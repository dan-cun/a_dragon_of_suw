import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import type { AppState } from '../shared/contracts';
import { powershellPath } from './native';
import trayScript from '../native/tray.ps1' with { type: 'file' };
import trayIcon from '../../assets/icon.ico' with { type: 'file' };

const eventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.enum(['ready', 'open', 'quit']) }),
  z.object({ type: z.literal('accepted'), id: z.string().uuid() }),
  z.object({ type: z.literal('error'), message: z.string().max(500) }),
]);
interface Alert { key: string; title: string; body: string }
interface Pending { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
const seenSchema = z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(200);

function alerts(state: AppState, since: number): Alert[] {
  const result: Alert[] = [];
  if (state.sessionStatus === 'rejected') {
    const rejected = state.logs.findLast(log => log.request !== undefined && [log.request.businessCode, log.request.httpStatus].some(code => code === 401 || code === 403));
    if (rejected !== undefined && Date.parse(rejected.timestamp) >= since) result.push({ key: `session:${rejected.id}`, title: '校园登录已失效', body: '请打开西大日常处理登录。已保存的信息仍保留，尚未确认的任务不会重复提交。' });
  }
  if (state.authentication?.active && state.authentication.stage === 'ready') {
    const cycle = state.logs.findLast(log => log.event === 'auth-sso')?.id ?? 'current';
    result.push({ key: `captcha:${cycle}`, title: '校园登录需要验证码', body: '请打开西大日常完成验证码。后台正在等待人工处理。' });
  }
  for (const log of state.logs) {
    if (Date.parse(log.timestamp) < since || (log.event === 'auth.failed' && log.message.includes('取消'))) continue;
    if (['schedule.failed', 'submission.unresolved', 'submission.confirmed', 'background.failed', 'auth.failed', 'login.task-sync-failed', 'storage.write-failed', 'storage.load-failed'].includes(log.event)) {
      result.push({ key: `log:${log.id}`, title: log.event === 'submission.confirmed' ? '回查已确认签到' : log.event === 'submission.unresolved' ? '签到结果仍待确认' : '西大日常需要处理',
        body: log.event === 'submission.confirmed' ? '后台只读回查已确认任务完成，没有再次提交。' : '后台遇到需要处理的状态。请打开程序查看运行记录；已发起过提交的任务不会重复提交。' });
    }
  }
  for (const record of state.history) {
    if (Date.parse(record.timestamp) < since) continue;
    if (record.trigger === 'scheduled' || record.outcome === 'unconfirmed') {
      result.push({ key: `result:${record.id}:${record.outcome}`, title: record.outcome === 'success' || record.outcome === 'already-signed' ? '学校已确认签到' : '签到需要核对',
        body: record.outcome === 'success' || record.outcome === 'already-signed' ? '学校服务端已确认任务完成。可打开西大日常查看详情。' : '这项任务尚未确认成功。请打开程序核对结果，后台不会重复提交。' });
    }
  }
  return result;
}

export async function createNotifications(directory: string, onAction: (action: 'open' | 'quit') => Promise<void>, onFailure: (error: Error) => void) {
  const since = Date.now();
  const trayIconPath = join(directory, 'tray-icon.ico');
  writeFileSync(trayIconPath, readFileSync(trayIcon));
  const encoded = Buffer.from(readFileSync(trayScript, 'utf8'), 'utf16le').toString('base64');
  const pending = new Map<string, Pending>();
  let closed = false;
  let failure: Error | null = null;
  const savedPath = join(directory, 'notifications.json');
  let seen = existsSync(savedPath) ? seenSchema.parse(JSON.parse(readFileSync(savedPath, 'utf8'))) : [];
  let handled = new Set(seen);
  const child = spawn(powershellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded], { windowsHide: true, stdio: 'pipe', env: { ...process.env, SWU_TRAY_ICON_PATH: trayIconPath } });
  const hash = (key: string): string => createHash('sha256').update(key).digest('hex');
  function fail(error: Error): void {
    if (failure !== null) return;
    failure = error;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear(); onFailure(error);
  }
  const exit = new Promise<number | null>(resolve => child.once('close', resolve));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { const error = new Error('Windows 托盘未在 15 秒内就绪。'); fail(error); child.stdin.end(); reject(error); }, 15_000);
    createInterface({ input: child.stdout }).on('line', line => {
      try {
        const event = eventSchema.parse(JSON.parse(line));
        if (event.type === 'ready') { clearTimeout(timer); resolve(); }
        else if (event.type === 'accepted') {
          const request = pending.get(event.id);
          if (request === undefined) throw new Error('Windows 通知返回了未知请求编号。');
          clearTimeout(request.timer); pending.delete(event.id); request.resolve();
        } else if (event.type === 'error') throw new Error(event.message);
        else void onAction(event.type).catch(cause => onFailure(cause instanceof Error ? cause : new Error('托盘操作失败。', { cause })));
      } catch (cause) {
        clearTimeout(timer); const error = new Error('Windows 托盘通信失败。', { cause }); fail(error); reject(error); child.stdin.end();
      }
    });
    createInterface({ input: child.stderr }).on('line', () => { const error = new Error('Windows 托盘进程输出错误，请检查系统服务。'); fail(error); reject(error); child.stdin.end(); });
    child.stdin.on('error', error => { fail(error); reject(error); });
    child.once('error', error => { clearTimeout(timer); fail(error); reject(error); });
    child.once('close', code => { clearTimeout(timer); if (!closed || code !== 0) { const error = new Error(`Windows 托盘进程退出（${code ?? '未知'}）。`); fail(error); reject(error); } });
  });
  async function notify(title: string, body: string): Promise<void> {
    if (failure !== null) throw failure;
    if (closed) throw new Error('Windows 通知服务已关闭。');
    const id = randomUUID();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Windows 未在 5 秒内接受通知。')); }, 5000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ command: 'notify', id, title, body }) + '\n', error => { if (error) fail(error); });
    });
  }
  return {
    notify,
    prime(state: AppState): void { seen = [...new Set([...seen, ...alerts(state, since).map(alert => hash(alert.key))])].slice(-200); handled = new Set(seen); },
    observe(state: AppState): void {
      if (closed || failure !== null) return;
      const candidates = alerts(state, since);
      const live = new Set([...seen, ...candidates.map(alert => hash(alert.key))]);
      handled = new Set([...handled].filter(key => live.has(key)));
      for (const alert of candidates) {
        const key = hash(alert.key);
        if (handled.has(key)) continue;
        handled.add(key);
        seen = [...seen.slice(-199), key];
        void notify(alert.title, alert.body).then(() => {
          writeFileSync(`${savedPath}.pending`, JSON.stringify(seen), { encoding: 'utf8', mode: 0o600 });
          renameSync(`${savedPath}.pending`, savedPath);
        }).catch(cause => onFailure(cause instanceof Error ? cause : new Error('后台提醒失败。', { cause })));
      }
    },
    async close(): Promise<void> {
      closed = true;
      child.stdin.end(JSON.stringify({ command: 'shutdown' }) + '\n');
      const timeout = setTimeout(() => { child.kill(); }, 5000);
      const code = await exit; clearTimeout(timeout);
      if (code !== 0) throw new Error('Windows 托盘未正常退出。');
    }
  };
}
