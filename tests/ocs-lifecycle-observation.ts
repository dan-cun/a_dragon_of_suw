import childProcess, { ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { z } from 'zod';
import type { OcsState } from '../desktop/shared/ocs';

const options = z.object({ durationMs: z.number().int().min(5000).max(180000), forceGc: z.boolean() }).strict().parse(JSON.parse(process.env['SWU_OCS_LIFECYCLE_OPTIONS'] ?? 'null'));
const directory = process.env['SWU_OCS_LIFECYCLE_DIRECTORY'];
const temporary = process.env['TEMP'];
const executable = process.env['SWU_OCS_BROWSER'];
if (!directory || !temporary || !executable || !isAbsolute(directory) || !isAbsolute(executable) || !existsSync(executable)) throw new Error('Explicit TEMP investigation directory and existing standalone Chrome are required.');
const distance = relative(resolve(temporary), resolve(directory));
if (!distance || isAbsolute(distance) || distance === '..' || distance.startsWith('..' + sep) || !distance.split(sep)[0]?.startsWith('swu-ocs-lifecycle-')) throw new Error('The lifecycle evidence directory must be inside its isolated TEMP prefix.');
mkdirSync(directory, { recursive: true });
const timeline = join(directory, 'timeline.jsonl');
const startedAt = performance.now();
function record(kind: string, fields: object): void {
  appendFileSync(timeline, JSON.stringify({ at: new Date().toISOString(), elapsedMs: Math.round(performance.now() - startedAt), kind, ...fields }) + '\n', 'utf8');
}
function errorCode(cause: unknown): string | null {
  return cause instanceof Error && 'code' in cause && typeof cause.code === 'string' ? cause.code : null;
}
function callerStack(): string[] { return (new Error().stack ?? '').split('\n').slice(2, 12); }
const protocolSchema = z.object({ method: z.string().optional(), params: z.object({ reason: z.string().optional() }).optional() });
const closeMethods = new Set(['Browser.close', 'Target.closeTarget', 'Target.disposeBrowserContext', 'Page.close']);
const targetEvents = new Set(['Target.detachedFromTarget', 'Target.targetDestroyed', 'Target.targetCrashed', 'Inspector.detached']);
/** Decode NUL framing without retaining page data, URLs, credentials or protocol payloads. */
function observeProtocol(pid: number, direction: 'sent' | 'received'): (chunk: Buffer) => void {
  let pending = Buffer.alloc(0);
  return chunk => {
    pending = Buffer.concat([pending, chunk]);
    let boundary = pending.indexOf(0);
    while (boundary !== -1) {
      const frame = pending.subarray(0, boundary).toString('utf8');
      pending = pending.subarray(boundary + 1);
      const message = protocolSchema.parse(JSON.parse(frame));
      if (message.method && (direction === 'sent' ? closeMethods.has(message.method) : targetEvents.has(message.method))) {
        const reason = message.params?.reason;
        record('cdp.' + direction, { pid, method: message.method, reason: reason && /^[a-zA-Z _-]{1,100}$/.test(reason) ? reason : null, stack: direction === 'sent' ? callerStack() : null });
      }
      boundary = pending.indexOf(0);
    }
  };
}
interface NativeRoot { pid: number; child: WeakRef<ChildProcess>; exitCode: number | null; signal: string | null; exited: boolean }
const roots: NativeRoot[] = [];
const nativeSpawn = childProcess.spawn;
const nativeSpawnSync = childProcess.spawnSync;
// Refuse upstream force-kill paths rather than allowing diagnostic failures to terminate processes.
childProcess.spawnSync = new Proxy(nativeSpawnSync, {
  apply(target, receiver: unknown, args: unknown[]): unknown {
    if (typeof args[0] === 'string' && /taskkill/i.test(args[0])) {
      record('native.force-kill.blocked', { stack: callerStack() });
      throw new Error('Force termination is forbidden in this isolated lifecycle investigation.');
    }
    return Reflect.apply(target, receiver, args);
  }
});
// Observe real spawn results without changing arguments, return values, stream flow or child lifetime.
childProcess.spawn = new Proxy(nativeSpawn, {
  apply(target, receiver: unknown, args: unknown[]): unknown {
    const result: unknown = Reflect.apply(target, receiver, args);
    const command = args[0];
    if (typeof command !== 'string' || resolve(command).toLowerCase() !== resolve(executable).toLowerCase()) return result;
    if (!(result instanceof ChildProcess) || result.pid === undefined) throw new TypeError('The real Chrome spawn did not return a ChildProcess with a PID.');
    const pid = result.pid;
    const root: NativeRoot = { pid, child: new WeakRef(result), exitCode: null, signal: null, exited: false };
    roots.push(root);
    record('native.spawn', { pid, stdioCount: result.stdio.length });
    result.once('exit', (code, signal) => { root.exitCode = code; root.signal = signal; root.exited = true; record('native.exit', { pid, code, signal }); });
    result.once('close', (code, signal) => record('native.close', { pid, code, signal }));
    result.on('error', (cause: unknown) => record('native.error', { pid, code: errorCode(cause) }));
    result.kill = () => { record('native.kill.blocked', { pid, stack: callerStack() }); throw new Error('ChildProcess.kill is forbidden in this investigation.'); };
    result.stdio.forEach((stream, index) => {
      if (!stream) return;
      stream.once('close', () => record('stdio.close', { pid, index }));
      stream.once('end', () => record('stdio.end', { pid, index }));
      stream.once('finish', () => record('stdio.finish', { pid, index }));
      stream.on('error', (cause: unknown) => record('stdio.error', { pid, index, code: errorCode(cause) }));
      if (index !== 3 && index !== 4) return;
      stream.destroy = new Proxy(stream.destroy, {
        apply(method, receiver: unknown, values: unknown[]): unknown {
          record('stdio.destroy.called', { pid, index, stack: callerStack() });
          return Reflect.apply(method, receiver, values);
        }
      });
      if (index === 4) {
        const observe = observeProtocol(pid, 'received');
        stream.emit = new Proxy(stream.emit, {
          apply(method, receiver: unknown, values: unknown[]): unknown {
            if (values[0] === 'data') {
              if (!Buffer.isBuffer(values[1])) throw new TypeError('The observed real CDP read is not a Buffer.');
              observe(values[1]);
            }
            return Reflect.apply(method, receiver, values);
          }
        });
      }
      if (!(stream instanceof Writable)) return;
      stream.end = new Proxy(stream.end, {
        apply(method, receiver: unknown, values: unknown[]): unknown {
          record('stdio.end.called', { pid, index, stack: callerStack() });
          return Reflect.apply(method, receiver, values);
        }
      });
      if (index !== 3) return;
      const observe = observeProtocol(pid, 'sent');
      stream.write = new Proxy(stream.write, {
        apply(method, receiver: unknown, values: unknown[]): unknown {
          const chunk = values[0];
          if (typeof chunk === 'string') observe(Buffer.from(chunk, 'utf8'));
          else if (Buffer.isBuffer(chunk)) observe(chunk);
          else throw new TypeError('The observed real CDP write is neither text nor a Buffer.');
          return Reflect.apply(method, receiver, values);
        }
      });
    });
    return result;
  }
});

const { createOcsService } = await import('../desktop/bun/ocs');
const service = createOcsService(join(directory, 'data'));
let gcCount = 0;
let samples = 0;
let failure: Error | null = null;
function snapshot(state: OcsState, stage: string): void {
  samples += 1;
  record('sample', {
    stage, gcCount, browsers: state.browsers.map(({ id, phase, owned }) => ({ id, phase, owned })),
    logs: state.logs.filter(log => log.event.startsWith('browser.lifecycle.') || ['browser.closed', 'browser.stopped', 'page.crashed'].includes(log.event)),
    roots: roots.map(root => {
      const child = root.child.deref();
      return {
        pid: root.pid, retainedByRuntime: child !== undefined, exited: root.exited, exitCode: root.exitCode, signal: root.signal,
        stdio: child?.stdio.map((stream, index) => ({ index, present: stream !== null, destroyed: stream?.destroyed ?? null, readable: stream instanceof Readable ? stream.readable : null, writable: stream instanceof Writable ? stream.writable : null })) ?? null
      };
    })
  });
}
function assertRunning(state: OcsState): void {
  if (state.browsers.length !== 2 || state.browsers.some(browser => browser.phase !== 'running' || !browser.owned)) throw new Error('A real owned Chrome stopped during lifecycle observation; see the preserved timeline.');
  if (roots.length !== 2 || roots.some(root => root.exited)) throw new Error('A real Chrome native process exited during lifecycle observation.');
}
try {
  record('start', { options, runtime: Bun.version, compiled: process.execPath.toLowerCase().endsWith('ocs-lifecycle-observation.exe'), parentStdio: process.env['SWU_OCS_LIFECYCLE_PARENT_STDIO'] });
  const metadata = { name: 'Lifecycle A', folder: '', notes: 'No accounts or course execution', tags: [], startUrl: 'about:blank' };
  await service.execute({ command: 'browser-create', browser: metadata });
  const created = await service.execute({ command: 'browser-create', browser: { ...metadata, name: 'Lifecycle B' } });
  const firstId = created.browsers[0]?.id;
  const secondId = created.browsers[1]?.id;
  if (!firstId || !secondId) throw new Error('Two isolated browser records are required.');
  for (const id of [firstId, secondId]) await service.execute({ command: 'browser-start', id });
  snapshot(await service.execute({ command: 'state' }), 'started');
  if (roots.length !== 2) throw new Error('The real Chrome spawn observer did not capture both native processes.');
  await service.execute({ command: 'browser-focus', id: firstId });
  await service.execute({ command: 'browser-preview', id: firstId });
  const deadline = performance.now() + options.durationMs;
  while (performance.now() < deadline) {
    if (options.forceGc) { Bun.gc(true); gcCount += 1; }
    const state = await service.execute({ command: 'state' });
    snapshot(state, 'observing');
    assertRunning(state);
    await Bun.sleep(1000);
  }
  record('action', { action: 'stop-A', firstId });
  const stopped = await service.execute({ command: 'browser-stop', id: firstId });
  snapshot(stopped, 'A-stopped');
  if (stopped.browsers.find(browser => browser.id === firstId)?.owned !== false || stopped.browsers.find(browser => browser.id === secondId)?.owned !== true) throw new Error('Stopping A did not preserve B ownership.');
  record('action', { action: 'restart-A', firstId });
  const restarted = await service.execute({ command: 'browser-start', id: firstId });
  snapshot(restarted, 'A-restarted');
  if (restarted.browsers.some(browser => !browser.owned || browser.phase !== 'running')) throw new Error('A restart or an old-owner event affected current ownership.');
  await Bun.sleep(1000);
  snapshot(await service.execute({ command: 'state' }), 'restart-settled');
  record('action', { action: 'stop-all' });
  await service.execute({ command: 'browsers-stop' });
  await Bun.sleep(250);
  const final = await service.execute({ command: 'state' });
  snapshot(final, 'all-stopped');
  if (final.browsers.some(browser => browser.owned) || roots.some(root => !root.exited)) throw new Error('A real native Chrome or owner remains after normal shutdown.');
  const lifecycle = final.logs.filter(log => log.event.startsWith('browser.lifecycle.'));
  const sources = lifecycle.map(log => z.object({ source: z.string(), attempted: z.boolean() }).parse(JSON.parse(log.message)));
  if (!sources.some(item => item.source === 'context.close' && item.attempted) || !sources.some(item => item.source === 'browser.disconnected')) throw new Error('The real normal-close lifecycle diagnostics are incomplete.');
} catch (cause) {
  failure = cause instanceof Error ? cause : new Error('The lifecycle fixture received a non-Error failure.');
  record('failure', { name: failure.name, code: errorCode(failure), message: failure.message.split('\n')[0] });
  snapshot(await service.execute({ command: 'state' }), 'failure-before-cleanup');
} finally {
  record('action', { action: 'normal-service-close' });
  try { await service.close(); }
  catch (cause) {
    record('cleanup.failure', { code: errorCode(cause) });
    failure = new AggregateError(failure ? [failure, cause] : [cause], 'Lifecycle observation or normal cleanup failed.');
  }
  await Bun.sleep(250);
  childProcess.spawn = nativeSpawn;
  if (roots.every(root => root.exited)) childProcess.spawnSync = nativeSpawnSync;
  const summary = { ok: failure === null, samples, gcCount, options, native: roots.map(({ pid, exited, exitCode, signal }) => ({ pid, exited, exitCode, signal })), cleanupComplete: roots.every(root => root.exited), timeline };
  writeFileSync(join(directory, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
}
if (failure) throw failure;
