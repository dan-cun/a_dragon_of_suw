import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { closeApplicationWindows } from './native';
import { hasRunningInstance } from './instance';
import { phaseSchema } from '../shared/validation';
import { assertCanShutdown } from '../core/shutdown';

export async function stopRunningApplication(): Promise<void> {
  const appData = process.env['APPDATA'];
  if (appData === undefined) throw new Error('未找到 Windows 用户数据目录。');
  const directory = process.env['SWU_USER_DATA_DIR'] ?? join(appData, 'swu-daka-desktop');
  if (!isAbsolute(directory)) throw new Error('应用数据目录必须为绝对路径。');
  const path = join(directory, 'instance.json');
  if (!(await hasRunningInstance(directory))) { await closeApplicationWindows(directory); return; }
  const readyDeadline = Date.now() + 10_000;
  while (!existsSync(path) && Date.now() < readyDeadline) await Bun.sleep(100);
  if (!existsSync(path)) throw new Error('旧程序仍在启动，未在 10 秒内准备好退出接口，请稍后重试。');
  const instance = z.object({ pid: z.number().int().positive(), port: z.number().int().min(1).max(65535), launchKey: z.string().regex(/^[a-f0-9]{64}$/) }).parse(JSON.parse(readFileSync(path, 'utf8')));
  const origin = `http://127.0.0.1:${instance.port}`;
  const identified = await fetch(`${origin}/api/instance`, { headers: { 'X-SWU-Instance': instance.launchKey }, signal: AbortSignal.timeout(5000) });
  if (!identified.ok) throw new Error('无法确认旧程序身份，请从旧版偏好设置退出后重试。');
  z.object({ application: z.literal('swu-daka-desktop') }).parse(await identified.json());
  const launch = await fetch(`${origin}/launch/${instance.launchKey}`, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
  const cookie = launch.headers.get('set-cookie')?.split(';')[0];
  if (launch.status !== 302 || cookie === undefined || !/^swu-session=[a-f0-9]{64}$/.test(cookie)) throw new Error('无法取得旧程序的本机退出会话。');
  const stateResponse = await fetch(`${origin}/api/state`, { method: 'POST',
    headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', 'X-SWU-Request': '1' }, body: '{}', signal: AbortSignal.timeout(5000) });
  if (!stateResponse.ok) throw new Error(`无法读取旧程序的任务状态，HTTP ${stateResponse.status}。`);
  const state = z.object({ ok: z.literal(true), value: z.object({ phase: phaseSchema }) }).parse(await stateResponse.json());
  assertCanShutdown(state.value.phase);
  const response = await fetch(`${origin}/api/quit`, { method: 'POST',
    headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', 'X-SWU-Request': '1' }, body: '{}', signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`旧程序退出请求失败，HTTP ${response.status}。`);
  const result = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true) }), z.object({ ok: z.literal(false), error: z.object({ message: z.string() }) })]).parse(await response.json());
  if (!result.ok) throw new Error(result.error.message);
  const deadline = Date.now() + 15_000;
  while ((await hasRunningInstance(directory)) && Date.now() < deadline) await Bun.sleep(100);
  if (await hasRunningInstance(directory)) throw new Error('旧程序未在 15 秒内退出，请退出旧版后重试安装。');
  await closeApplicationWindows(directory);
}
