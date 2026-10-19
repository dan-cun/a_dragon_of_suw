import childProcess, { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Writable } from 'node:stream';
import { z } from 'zod';
import { emptyOcsDocument, savedBrowserSchema } from '../desktop/bun/ocs-document';

const options = z.object({
  directory: z.string().min(1), chrome: z.string().min(1), durationMs: z.number().int().min(5000).max(120000),
  forceGc: z.boolean(), label: z.string().regex(/^[a-z-]+$/)
}).strict().parse(JSON.parse(process.env['SWU_OCS_NATIVE_OPTIONS'] ?? 'null'));
for (const name of ['SWU_OCS_BROWSER', 'SWU_OCS_DIST']) {
  if (Object.hasOwn(process.env, name)) throw new Error(`${name} must be absent for the native investigation.`);
}
const work = resolve('work');
const distance = relative(work, resolve(options.directory));
if (!isAbsolute(options.directory) || !isAbsolute(options.chrome) || !distance || isAbsolute(distance) || distance === '..' || distance.startsWith('..' + sep) || !distance.split(sep)[0]?.startsWith('ocs-native-')) throw new Error('Native observation requires explicit Chrome and a new isolated work/ocs-native-* directory.');
mkdirSync(options.directory, { recursive: true });
const timeline = join(options.directory, 'timeline.jsonl');
const started = performance.now();
function record(kind: string, fields: object): void {
  appendFileSync(timeline, JSON.stringify({ at: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started), kind, ...fields }) + '\n', 'utf8');
}
function stack(): string[] { return (new Error().stack ?? '').split('\n').slice(2, 10); }
function errorCode(cause: unknown): string | null {
  return cause instanceof Error && 'code' in cause && typeof cause.code === 'string' ? cause.code : null;
}
interface NativeRoot { pid: number; child: WeakRef<ChildProcess>; exited: boolean; exitCode: number | null; signal: string | null }
const roots: NativeRoot[] = [];
const commandSchema = z.object({ method: z.string() });
const closeMethods = new Set(['Browser.close', 'Target.closeTarget', 'Target.disposeBrowserContext', 'Page.close']);
const nativeSpawn = childProcess.spawn;
// Observe only allowlisted protocol names; never persist protocol payloads, arguments or page data.
childProcess.spawn = new Proxy(nativeSpawn, {
  apply(target, receiver: unknown, args: unknown[]): unknown {
    const result: unknown = Reflect.apply(target, receiver, args);
    const command = args[0];
    if (typeof command !== 'string' || resolve(command).toLowerCase() !== resolve(options.chrome).toLowerCase()) return result;
    if (!(result instanceof ChildProcess) || result.pid === undefined) throw new TypeError('The actual Chrome child is missing its PID.');
    const pid = result.pid;
    const root: NativeRoot = { pid, child: new WeakRef(result), exited: false, exitCode: null, signal: null };
    roots.push(root);
    record('native.spawn', { pid, stdioCount: result.stdio.length });
    result.once('exit', (code, signal) => { root.exited = true; root.exitCode = code; root.signal = signal; record('native.exit', { pid, code, signal }); });
    result.once('close', (code, signal) => record('native.close', { pid, code, signal }));
    result.on('error', cause => record('native.error', { pid, code: errorCode(cause) }));
    result.kill = new Proxy(result.kill, {
      apply(method, child: unknown, values: unknown[]): unknown {
        record('native.kill.requested', { pid, stack: stack() });
        return Reflect.apply(method, child, values);
      }
    });
    result.stdio.forEach((stream, index) => {
      if (!stream) return;
      for (const event of ['close', 'end', 'finish']) stream.once(event, () => record('stdio.' + event, { pid, index }));
      stream.on('error', cause => record('stdio.error', { pid, index, code: errorCode(cause) }));
      if (index !== 3 && index !== 4) return;
      stream.destroy = new Proxy(stream.destroy, {
        apply(method, pipe: unknown, values: unknown[]): unknown {
          record('stdio.destroy.called', { pid, index, stack: stack() });
          return Reflect.apply(method, pipe, values);
        }
      });
      if (!(stream instanceof Writable)) return;
      stream.end = new Proxy(stream.end, {
        apply(method, pipe: unknown, values: unknown[]): unknown {
          record('stdio.end.called', { pid, index, stack: stack() });
          return Reflect.apply(method, pipe, values);
        }
      });
      if (index !== 3) return;
      stream.write = new Proxy(stream.write, {
        apply(method, pipe: unknown, values: unknown[]): unknown {
          const chunk = values[0];
          const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : null;
          if (text?.startsWith('{') && text.endsWith('}')) {
            const message = commandSchema.parse(JSON.parse(text));
            if (closeMethods.has(message.method)) record('cdp.close-method.sent', { pid, method: message.method, stack: stack() });
          }
          return Reflect.apply(method, pipe, values);
        }
      });
    });
    return result;
  }
});

const { createOcsBrowserRuntime } = await import('../desktop/bun/ocs-browser');
const runtime = createOcsBrowserRuntime(join(options.directory, 'runtime'), options.chrome, (id, level, event, message) => record('runtime', { id, level, event, message }));
const now = new Date().toISOString();
const browsers = ['A', 'B'].map(label => savedBrowserSchema.parse({
  id: randomUUID(), name: `Native ${label}`, folder: '', notes: 'No accounts, scripts, extensions or course execution',
  tags: [], startUrl: 'about:blank', automationName: null, createdAt: now, updatedAt: now
}));
const document = { ...emptyOcsDocument(), browsers };
let gcCount = 0;
let failure: Error | null = null;
let samples = 0;
function sample(stage: string): void {
  samples += 1;
  record('sample', {
    stage, gcCount, browsers: browsers.map(browser => {
      const state = runtime.browserState(browser);
      return { id: state.id, phase: state.phase, owned: state.owned };
    }),
    roots: roots.map(root => {
      const child = root.child.deref();
      return { pid: root.pid, retained: child !== undefined, exited: root.exited, exitCode: root.exitCode, signal: root.signal,
        pipes: child?.stdio.map((stream, index) => ({ index, destroyed: stream?.destroyed ?? null })) ?? null };
    })
  });
}
try {
  record('start', { label: options.label, durationMs: options.durationMs, forceGc: options.forceGc, bun: Bun.version });
  for (const browser of browsers) await runtime.start(browser, document);
  if (roots.length !== 2) throw new Error('Expected two actual Chrome roots before observation.');
  const first = browsers[0];
  if (!first) throw new Error('Browser A metadata is missing.');
  await runtime.focus(first.id);
  await runtime.capture(first.id);
  const deadline = performance.now() + options.durationMs;
  while (performance.now() < deadline) {
    if (options.forceGc) { record('gc.before', { gcCount }); Bun.gc(true); gcCount += 1; record('gc.after', { gcCount }); }
    sample('observing');
    if (browsers.some(browser => { const state = runtime.browserState(browser); return state.phase !== 'running' || !state.owned; }) || roots.some(root => root.exited)) throw new Error('A real Chrome exited without an observation stop; preserved lifecycle and pipe records identify the sequence.');
    await Bun.sleep(1000);
  }
} catch (cause: unknown) {
  failure = cause instanceof Error ? cause : new Error('The native observation threw a non-Error value.', { cause });
  record('failure', { name: failure.name, message: failure.message.split('\n')[0], code: errorCode(cause) });
  sample('failure-before-cleanup');
} finally {
  record('action', { action: 'normal-runtime-stop-all' });
  try { await runtime.stopAll(); }
  catch (cause: unknown) { failure = new AggregateError(failure ? [failure, cause] : [cause], 'Native observation or normal cleanup failed.'); record('cleanup.failure', { code: errorCode(cause) }); }
  const deadline = performance.now() + 5000;
  while (roots.some(root => !root.exited) && performance.now() < deadline) await Bun.sleep(100);
  sample('after-normal-cleanup');
  childProcess.spawn = nativeSpawn;
  const cleanupComplete = roots.every(root => root.exited) && !runtime.hasRunning();
  if (!cleanupComplete) failure = new AggregateError(failure ? [failure] : [], 'Normal cleanup did not confirm every actual Chrome exit.');
  writeFileSync(join(options.directory, 'summary.json'), JSON.stringify({
    ok: failure === null, label: options.label, gcCount, samples, cleanupComplete,
    roots: roots.map(({ pid, exited, exitCode, signal }) => ({ pid, exited, exitCode, signal })), timeline
  }, null, 2), 'utf8');
}
if (failure) throw failure;
