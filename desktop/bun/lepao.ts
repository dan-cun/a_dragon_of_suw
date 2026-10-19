import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { lepaoCommandSchema, lepaoLogSchema, lepaoSnapshotSchema, type LepaoState } from '../shared/lepao';
import { DakaError, redact } from '../core/errors';

const eventSchema = z.union([
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('log'), level: z.enum(['info', 'warning', 'error']), message: z.string().max(1500) }),
  z.object({ type: z.literal('state'), value: lepaoSnapshotSchema }),
  z.object({ type: z.literal('response'), id: z.string(), ok: z.literal(true), value: lepaoSnapshotSchema }),
  z.object({ type: z.literal('response'), id: z.string(), ok: z.literal(false), error: z.string().max(1500) }),
]);
interface Pending { resolve: (value: LepaoState) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }

export function createLepaoService(directory: string) {
  let child: ChildProcessWithoutNullStreams | null = null;
  let starting: Promise<void> | null = null;
  let ready = false;
  let failed: Error | null = null;
  let reservations = 0;
  let closing = false;
  let state: LepaoState = { operation: null, busy: false, action: '', result: '', proxyRecoveryNeeded: false, members: [], capabilities: null, privacy: null, logs: [] };
  const pending = new Map<string, Pending>();

  function log(level: 'info' | 'warning' | 'error', message: string): void {
    state = { ...state, logs: [...state.logs.slice(-299), lepaoLogSchema.parse({ id: randomUUID(), time: new Date().toISOString(), level, message })] };
  }
  function fail(error: Error): void {
    if (failed !== null) return;
    failed = error;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
    log('error', error.message);
    child?.stdin.end();
  }
  function start(): Promise<void> {
    if (failed !== null) return Promise.reject(failed);
    if (starting !== null) return starting;
    starting = new Promise<void>((resolve, reject) => {
      const executable = process.env['SWU_LEPAO_ENGINE'] ?? join(dirname(process.execPath), 'engine/lepao-engine.exe');
      if (!existsSync(executable)) { reject(new Error('未找到乐跑引擎，请使用包含 engine 文件夹的完整安装包。')); return; }
      const processChild = spawn(executable, [join(directory, 'lepao')], { windowsHide: true, stdio: 'pipe', env: { ...process.env, PYTHONUTF8: '1' } });
      child = processChild;
      const timeout = setTimeout(() => { const error = new Error('乐跑引擎未在 30 秒内就绪。'); fail(error); reject(error); }, 30_000);
      createInterface({ input: processChild.stdout }).on('line', line => {
        try {
          if (line.length > 512_000) throw new Error('乐跑引擎响应超过 512 KB。');
          const event = eventSchema.parse(JSON.parse(line));
          if (event.type === 'ready') { clearTimeout(timeout); ready = true; resolve(); }
          else if (event.type === 'log') log(event.level, event.message);
          else if (event.type === 'state') state = { ...event.value, logs: state.logs };
          else {
            const request = pending.get(event.id);
            if (request === undefined) throw new Error('乐跑引擎返回了未知请求编号。');
            clearTimeout(request.timer); pending.delete(event.id);
            if (event.ok) { state = { ...event.value, logs: state.logs }; request.resolve(state); }
            else request.reject(new Error(event.error));
          }
        } catch (error) {
          clearTimeout(timeout);
          const failure = new Error('乐跑引擎通信失败，请退出并重启程序。', { cause: error });
          fail(failure); if (!ready) reject(failure);
        }
      });
      createInterface({ input: processChild.stderr }).on('line', line => log('error', `乐跑引擎诊断：${redact(line, [])}`));
      processChild.stdin.on('error', error => { fail(error); if (!ready) reject(error); });
      processChild.once('error', error => { clearTimeout(timeout); fail(error); reject(error); });
      processChild.once('exit', code => {
        clearTimeout(timeout);
        if (!closing || code !== 0 || pending.size > 0 || !ready) {
          const error = new Error(`乐跑引擎已退出（代码 ${code ?? '未知'}），请重启程序。`);
          fail(error); reject(error);
        }
        child = null; ready = false;
        state = { ...state, busy: false, operation: state.operation?.status === 'running'
          ? { ...state.operation, phase: 'finished', status: 'failed', finishedAt: new Date().toISOString(), proxyRestored: null,
            message: '乐跑引擎异常退出，操作结果与代理恢复状态尚未核实。请重启程序后检查。' } : state.operation };
      });
    });
    return starting;
  }
  async function request(command: object): Promise<LepaoState> {
    await start();
    if (failed !== null) throw failed;
    if (child === null || !ready) throw new Error('乐跑引擎未运行，请重启程序。');
    const active = child;
    const id = randomUUID();
    return new Promise<LepaoState>((resolve, reject) => {
      const timer = setTimeout(() => { const error = new Error('乐跑引擎请求超过 45 秒，操作结果未知，请重启后检查。'); fail(error); reject(error); }, 45_000);
      pending.set(id, { resolve, reject, timer });
      active.stdin.write(JSON.stringify({ ...command, id }) + '\n', error => {
        if (error !== null && error !== undefined) { clearTimeout(timer); pending.delete(id); reject(error); }
      });
    });
  }
  function assertCanClose(): void {
    if (reservations > 0 || state.busy) throw new DakaError('OPERATION_BUSY', '乐跑操作尚未结束，请先停止并等待代理恢复。', undefined);
  }
  return {
    isBusy: (): boolean => reservations > 0 || state.busy,
    assertCanClose,
    async execute(payload: unknown): Promise<LepaoState> {
      const command = lepaoCommandSchema.parse(payload);
      if (closing) throw new DakaError('OPERATION_BUSY', '乐跑引擎正在退出，请稍后重新打开。', undefined);
      const mutating = !['state', 'stop'].includes(command.command);
      if (mutating) {
        if (reservations > 0 || state.busy) throw new DakaError('OPERATION_BUSY', '已有乐跑操作正在执行，请等待完成。', undefined);
        reservations += 1;
      }
      try { return await request(command); }
      finally { if (mutating) reservations -= 1; }
    },
    async close(): Promise<void> {
      assertCanClose();
      closing = true;
      if (child === null) return;
      const active = child;
      if (failed === null) await request({ command: 'shutdown' });
      active.stdin.end();
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('乐跑引擎未在 10 秒内退出。')), 10_000);
        if (active.exitCode !== null) { clearTimeout(timeout); resolve(); return; }
        active.once('exit', code => { clearTimeout(timeout); if (code === 0) resolve(); else reject(new Error('乐跑引擎退出失败。')); });
      });
    },
  };
}
