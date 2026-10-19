import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { createOcsService } from '../desktop/bun/ocs';
import { createOcsRepository } from '../desktop/bun/ocs-storage';
import { createGmStorage } from '../desktop/bun/ocs-gm-storage';
import type { OcsState } from '../desktop/shared/ocs';

const integration = process.env['SWU_OCS_RUNTIME_GM_TEST'] === '1' ? test : test.skip;
const work = await mkdtemp(join(resolve(import.meta.dir, '../work'), 'ocs-runtime-gm-'));
const sourcePaths = ['desktop/bun/ocs-browser.ts', 'desktop/bun/ocs.ts', 'desktop/bun/ocs-gm-storage.ts', 'desktop/ocs/userscripts.ts', 'desktop/ocs/gm-types.ts', 'desktop/ocs/gm-runtime.ts', 'desktop/ocs/gm-world.ts', 'tests/ocs-runtime-gm.test.ts'];
const sourceFingerprints: Record<string, string> = Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, createHash('sha256').update(await readFile(resolve(import.meta.dir, '..', path))).digest('hex')] as const)));
if (process.env['SWU_OCS_RUNTIME_GM_TEST'] === '1') console.log(JSON.stringify({ event: 'ocs.runtime.gm.evidence', work, sourceFingerprints }));
const results: { name: string; passed: boolean; at: string }[] = [];
const metadata = { name: 'Runtime GM integration', folder: '', notes: 'Authored loopback page; no accounts or course execution', tags: ['integration'], startUrl: 'about:blank' };
function chromeExecutable(): string {
  const executable = process.env['SWU_OCS_BROWSER'];
  if (!executable || !isAbsolute(executable)) throw new Error('SWU_OCS_BROWSER must explicitly select an existing standalone Chrome for this source-runtime integration.');
  if (Object.hasOwn(process.env, 'SWU_OCS_DIST')) throw new Error('SWU_OCS_DIST must be truly absent.');
  return resolve(executable);
}
async function evidence(name: string, passed: boolean): Promise<void> {
  results.push({ name, passed, at: new Date().toISOString() });
  await writeFile(join(work, 'result.json'), JSON.stringify({ results, sourceFingerprints, realChrome: true, realDpapi: true, externalAccountsUsed: false, compiledDesktopTested: false }, null, 2), 'utf8');
}
async function powershell(script: string, input: object): Promise<string> {
  const child = spawn('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  return await new Promise<string>((accept, reject) => {
    let output = '';
    let diagnostics = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { output += chunk; });
    child.stderr.on('data', (chunk: string) => { diagnostics += chunk; });
    child.once('error', reject); child.stdin.on('error', reject);
    child.once('close', code => { if (code === 0) accept(output); else reject(new Error(`Scoped Chrome inspection/window request failed (${String(code)}): ${diagnostics}`)); });
    child.stdin.end(JSON.stringify(input), 'utf8');
  });
}
async function rootPids(root: string, chrome: string): Promise<number[]> {
  const script = "$ErrorActionPreference='Stop';$query=[Console]::In.ReadToEnd()|ConvertFrom-Json;$rows=@(Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\"|Where-Object{$_.CommandLine -and [string]::Equals($_.ExecutablePath,$query.chrome,[StringComparison]::OrdinalIgnoreCase) -and $_.CommandLine.Contains($query.root,[StringComparison]::OrdinalIgnoreCase) -and $_.CommandLine -notmatch '(^|\\s)--type(?:=|\\s|$)'}|ForEach-Object{[int]$_.ProcessId});ConvertTo-Json -InputObject $rows -Compress";
  return z.array(z.number().int().positive()).parse(JSON.parse(await powershell(script, { root, chrome })));
}
async function normalWindowClose(root: string, chrome: string, pid: number): Promise<void> {
  const script = "$ErrorActionPreference='Stop';$query=[Console]::In.ReadToEnd()|ConvertFrom-Json;$native=Get-CimInstance Win32_Process -Filter ('ProcessId='+$query.pid);if(-not $native -or -not [string]::Equals($native.ExecutablePath,$query.chrome,[StringComparison]::OrdinalIgnoreCase) -or -not $native.CommandLine.Contains($query.root,[StringComparison]::OrdinalIgnoreCase) -or $native.CommandLine -match '(^|\\s)--type(?:=|\\s|$)'){throw 'The isolated native root identity changed.'};$nativeProcess=Get-Process -Id $query.pid;if($nativeProcess.MainWindowHandle -eq 0 -or -not $nativeProcess.CloseMainWindow()){throw 'Normal owned-window close was not accepted.'};Write-Output 'closed'";
  expect((await powershell(script, { root, chrome, pid })).trim()).toBe('closed');
}
function importedSource(body: string): string {
  return ['// ==UserScript==', '// @name Runtime GM integration', '// @match http://127.0.0.1/*', '// @grant GM_getValue', '// @grant GM_setValue', '// @run-at document-end', '// ==/UserScript==', body].join('\n');
}
async function fixture(name: string, body: string) {
  const chrome = chromeExecutable();
  const directory = join(work, name);
  const reports: { count: number; failed: boolean }[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (new URL(request.url).pathname === '/report') {
      reports.push(z.object({ count: z.number().int(), failed: z.boolean() }).parse(await request.json()));
      return new Response('OK');
    }
    return new Response('<!doctype html><html><body><div id="integration-ready">Authored GM runtime integration</div></body></html>', { headers: { 'Content-Type': 'text/html' } });
  } });
  const service = createOcsService(directory);
  const repository = createOcsRepository(directory);
  try {
    await service.execute({ command: 'script-import', name: 'Runtime GM integration', content: importedSource(body) });
    const state = await service.execute({ command: 'browser-create', browser: { ...metadata, startUrl: `http://127.0.0.1:${server.port}/page` } });
    const browser = state.browsers[0];
    const script = (await repository.read()).userScripts[0];
    if (!browser || !script) throw new Error('The real runtime fixture metadata was not created.');
    expect(script.enabled).toBe(true);
    return { chrome, directory, root: repository.root, service, server, reports, browser, script, store: createGmStorage(repository.root, browser.id, script.id, script.digest) };
  } catch (cause) { try { await service.close(); } finally { await server.stop(true); } throw cause; }
}
async function waitFor(check: () => boolean | Promise<boolean>, description: string): Promise<void> {
  const deadline = performance.now() + 10000;
  while (performance.now() < deadline) { if (await check()) return; await Bun.sleep(100); }
  throw new DOMException(`Timed out waiting for ${description}.`, 'TimeoutError');
}
async function waitForReports(actual: { count: number; failed: boolean }[], expected: { count: number; failed: boolean }[]): Promise<void> {
  await waitFor(() => actual.length >= expected.length, 'the real managed GM page report');
  expect(actual).toEqual(expected);
}
async function cleanup(subject: Awaited<ReturnType<typeof fixture>>, failure: unknown, name: string): Promise<void> {
  const errors: unknown[] = failure === null ? [] : [failure];
  try {
    const state = await subject.service.execute({ command: 'state' });
    await writeFile(join(subject.directory, 'before-cleanup.json'), JSON.stringify({
      failure: failure instanceof Error ? { name: failure.name, firstLine: failure.message.split('\n')[0] } : null,
      browsers: state.browsers.map(({ id, phase, owned, lastError }) => ({ id, phase, owned, lastError })),
      logs: state.logs, rootPids: await rootPids(subject.root, subject.chrome)
    }, null, 2), 'utf8');
  } catch (cause) { errors.push(cause); }
  try { await subject.service.close(); } catch (cause) { errors.push(cause); }
  try { await waitFor(async () => (await rootPids(subject.root, subject.chrome)).length === 0, 'normal scoped Chrome exit'); } catch (cause) { errors.push(cause); }
  await subject.server.stop(true);
  await evidence(name, errors.length === 0);
  if (errors.length) throw new AggregateError(errors, 'Real GM runtime integration or normal cleanup failed; no browser was force-terminated.');
}
function errorTree(cause: unknown, seen: Set<Error>): Error[] {
  if (!(cause instanceof Error) || seen.has(cause)) return [];
  seen.add(cause);
  const children: unknown[] = cause instanceof AggregateError ? cause.errors as unknown[] : [];
  return [cause, ...children.flatMap(child => errorTree(child, seen)), ...errorTree(cause.cause, seen)];
}
function browserState(state: OcsState, id: string) {
  const browser = state.browsers.find(value => value.id === id);
  if (!browser) throw new Error('The investigated browser is missing from public state.');
  return browser;
}
const increment = "const count=GM_getValue('count',0)+1;GM_setValue('count',count).then(()=>fetch('/report',{method:'POST',body:JSON.stringify({count,failed:false})}),()=>fetch('/report',{method:'POST',body:JSON.stringify({count,failed:true})}));";

integration('Runtime GM: durable writes survive stop and restart, and deletion is gated by ownership', async () => {
  const name = 'persist-stop-restart-delete';
  const subject = await fixture(name, increment);
  let failure: unknown = null;
  try {
    await subject.service.execute({ command: 'browser-start', id: subject.browser.id });
    await waitForReports(subject.reports, [{ count: 1, failed: false }]);
    expect(await subject.store.read()).toEqual({ count: 1 });
    expect(await rootPids(subject.root, subject.chrome)).toHaveLength(1);
    await expect(subject.service.execute({ command: 'browser-delete', id: subject.browser.id })).rejects.toThrow('先停止');
    await expect(subject.service.execute({ command: 'browser-start', id: subject.browser.id })).rejects.toThrow('仍被持有');
    const stopped = await subject.service.execute({ command: 'browser-stop', id: subject.browser.id });
    expect(browserState(stopped, subject.browser.id).owned).toBe(false);
    expect(browserState(stopped, subject.browser.id).phase).toBe('stopped');
    const requested = stopped.logs.find(value => value.event === 'browser.scripts.dispose.requested');
    const closed = stopped.logs.find(value => value.event === 'browser.closed');
    const released = stopped.logs.find(value => value.event === 'browser.owner.released');
    expect(requested).toBeDefined(); expect(closed).toBeDefined(); expect(released).toBeDefined();
    expect(requested!.sequence).toBeLessThan(closed!.sequence);
    expect(closed!.sequence).toBeLessThan(released!.sequence);
    expect(await rootPids(subject.root, subject.chrome)).toEqual([]);
    const ciphertext = await readFile(join(subject.root, 'gm-values', subject.browser.id, subject.script.id, subject.script.digest + '.dpapi.json'), 'utf8');
    expect(z.object({ protection: z.literal('windows-current-user-dpapi') }).parse(JSON.parse(ciphertext)).protection).toBe('windows-current-user-dpapi');
    expect(ciphertext.includes('"count"')).toBe(false);
    await subject.service.execute({ command: 'browser-start', id: subject.browser.id });
    await waitForReports(subject.reports, [{ count: 1, failed: false }, { count: 2, failed: false }]);
    await subject.service.execute({ command: 'browser-stop', id: subject.browser.id });
    expect(await subject.store.read()).toEqual({ count: 2 });
    expect((await subject.service.execute({ command: 'browser-delete', id: subject.browser.id })).browsers).toEqual([]);
  } catch (cause) { failure = cause; }
  finally { await cleanup(subject, failure, name); }
}, 90000);

integration('Runtime GM: real persistence failure still closes Chrome and preserves the aggregate failure', async () => {
  const name = 'real-write-failure-normal-close';
  const subject = await fixture(name, increment);
  let failure: unknown = null;
  try {
    await subject.store.read();
    await mkdir(join(subject.root, 'gm-values', subject.browser.id, subject.script.id, subject.script.digest + '.dpapi.json.pending'));
    await subject.service.execute({ command: 'browser-start', id: subject.browser.id });
    await waitForReports(subject.reports, [{ count: 1, failed: true }]);
    const stopped = await subject.service.execute({ command: 'browser-stop', id: subject.browser.id }).then(() => null, (cause: unknown) => cause);
    expect(stopped).toBeInstanceOf(AggregateError);
    const state = await subject.service.execute({ command: 'state' });
    expect(browserState(state, subject.browser.id).owned).toBe(false);
    expect(state.logs.some(log => log.event === 'browser.scripts.dispose.failed')).toBe(true);
    expect(state.logs.some(log => log.event === 'browser.closed')).toBe(true);
    expect(state.logs.some(log => log.event === 'browser.owner.released')).toBe(true);
    expect(await rootPids(subject.root, subject.chrome)).toEqual([]);
    expect(await subject.store.read()).toEqual({});
    expect((await subject.service.execute({ command: 'browser-delete', id: subject.browser.id })).browsers).toEqual([]);
  } catch (cause) { failure = cause; }
  finally { await cleanup(subject, failure, name); }
}, 90000);

integration('Runtime GM: attach failure from a real invalid store closes its newly owned Chrome', async () => {
  const name = 'real-attach-failure';
  const subject = await fixture(name, increment);
  let failure: unknown = null;
  try {
    await subject.store.read();
    await mkdir(join(subject.root, 'gm-values', subject.browser.id, subject.script.id, subject.script.digest + '.dpapi.json'));
    const started = await subject.service.execute({ command: 'browser-start', id: subject.browser.id }).then(() => null, (cause: unknown) => cause);
    expect(started).toBeInstanceOf(AggregateError);
    expect(errorTree(started, new Set()).some(cause => cause instanceof TypeError && cause.message.includes('GM encrypted store type'))).toBe(true);
    const state = await subject.service.execute({ command: 'state' });
    expect(browserState(state, subject.browser.id).owned).toBe(false);
    expect(state.logs.some(log => log.event === 'browser.closed')).toBe(true);
    expect(await rootPids(subject.root, subject.chrome)).toEqual([]);
    expect(subject.reports).toEqual([]);
    expect((await subject.service.execute({ command: 'browser-delete', id: subject.browser.id })).browsers).toEqual([]);
  } catch (cause) { failure = cause; }
  finally { await cleanup(subject, failure, name); }
}, 90000);

integration('Runtime GM: closing the actual native window triggers tracked script disposal before ownership release', async () => {
  const name = 'native-window-close-disposes-gm';
  const subject = await fixture(name, increment);
  let failure: unknown = null;
  try {
    await subject.service.execute({ command: 'browser-start', id: subject.browser.id });
    await waitForReports(subject.reports, [{ count: 1, failed: false }]);
    const pids = await rootPids(subject.root, subject.chrome);
    expect(pids).toHaveLength(1);
    const pid = pids[0];
    if (!pid) throw new Error('The exact isolated Chrome root is missing.');
    await normalWindowClose(subject.root, subject.chrome, pid);
    await waitFor(async () => !browserState(await subject.service.execute({ command: 'state' }), subject.browser.id).owned, 'GM disposal after native window close');
    const state = await subject.service.execute({ command: 'state' });
    const closed = state.logs.find(log => log.event === 'browser.closed');
    const disposing = state.logs.find(log => log.event === 'browser.scripts.dispose.requested');
    const released = state.logs.find(log => log.event === 'browser.owner.released');
    expect(closed).toBeDefined(); expect(disposing).toBeDefined(); expect(released).toBeDefined();
    expect(z.object({ requested: z.literal(false) }).parse(JSON.parse(closed!.message)).requested).toBe(false);
    expect(disposing!.sequence).toBeLessThan(released!.sequence);
    expect(await subject.store.read()).toEqual({ count: 1 });
    await waitFor(async () => (await rootPids(subject.root, subject.chrome)).length === 0, 'native process exit before reusing the closed profile');
    await subject.service.execute({ command: 'browser-start', id: subject.browser.id });
    await waitForReports(subject.reports, [{ count: 1, failed: false }, { count: 2, failed: false }]);
    await subject.service.execute({ command: 'browser-stop', id: subject.browser.id });
    expect(await subject.store.read()).toEqual({ count: 2 });
  } catch (cause) { failure = cause; }
  finally { await cleanup(subject, failure, name); }
}, 90000);

integration('Runtime GM: native close revokes a real queued DPAPI write burst without releasing the gate early', async () => {
  const name = 'native-close-with-queued-writes';
  const burst = "GM_setValue('count',1).then(()=>{for(let i=0;i<32;i++)GM_setValue('queued-'+i,i).catch(()=>undefined);return fetch('/report',{method:'POST',body:JSON.stringify({count:32,failed:false})});});";
  const subject = await fixture(name, burst);
  let failure: unknown = null;
  try {
    await subject.service.execute({ command: 'browser-start', id: subject.browser.id });
    await waitForReports(subject.reports, [{ count: 32, failed: false }]);
    const before = await subject.store.read();
    expect(before['count']).toBe(1);
    expect(Object.keys(before).filter(key => key.startsWith('queued-')).length).toBeLessThan(32);
    const pids = await rootPids(subject.root, subject.chrome);
    expect(pids).toHaveLength(1);
    const pid = pids[0];
    if (!pid) throw new Error('The queued-write Chrome root was not found.');
    await normalWindowClose(subject.root, subject.chrome, pid);
    await waitFor(async () => !browserState(await subject.service.execute({ command: 'state' }), subject.browser.id).owned, 'real queued GM work to settle after native close');
    const state = await subject.service.execute({ command: 'state' });
    const disposed = state.logs.find(log => log.event === 'browser.scripts.dispose.completed');
    const released = state.logs.find(log => log.event === 'browser.owner.released');
    expect(disposed).toBeDefined(); expect(released).toBeDefined();
    expect(z.object({ settled: z.literal(true) }).parse(JSON.parse(disposed!.message)).settled).toBe(true);
    expect(disposed!.sequence).toBeLessThan(released!.sequence);
    const settled = await subject.store.read();
    await Bun.sleep(750);
    expect(await subject.store.read()).toEqual(settled);
    expect(settled['count']).toBe(1);
    expect(Object.keys(settled).filter(key => key.startsWith('queued-')).length).toBeLessThan(32);
    expect(await rootPids(subject.root, subject.chrome)).toEqual([]);
    expect((await subject.service.execute({ command: 'browser-delete', id: subject.browser.id })).browsers).toEqual([]);
  } catch (cause) { failure = cause; }
  finally { await cleanup(subject, failure, name); }
}, 90000);

integration('Runtime GM: unexpected-close IO failures remain visible in state and the next stop', async () => {
  const name = 'unexpected-error-delivery';
  const subject = await fixture(name, increment);
  let failure: unknown = null;
  try {
    await subject.store.read();
    await mkdir(join(subject.root, 'gm-values', subject.browser.id, subject.script.id, subject.script.digest + '.dpapi.json.pending'));
    await subject.service.execute({ command: 'browser-start', id: subject.browser.id });
    await waitForReports(subject.reports, [{ count: 1, failed: true }]);
    const pids = await rootPids(subject.root, subject.chrome);
    expect(pids).toHaveLength(1);
    const pid = pids[0];
    if (!pid) throw new Error('The failed-write Chrome root was not found.');
    await normalWindowClose(subject.root, subject.chrome, pid);
    await waitFor(async () => !browserState(await subject.service.execute({ command: 'state' }), subject.browser.id).owned, 'the failed GM runtime to settle');
    const state = await subject.service.execute({ command: 'state' });
    expect(browserState(state, subject.browser.id).phase).toBe('failed');
    expect(browserState(state, subject.browser.id).lastError).not.toBeNull();
    await expect(subject.service.execute({ command: 'browser-stop', id: subject.browser.id })).rejects.toThrow('意外退出收尾曾失败');
    expect(browserState(await subject.service.execute({ command: 'browser-stop', id: subject.browser.id }), subject.browser.id).phase).toBe('stopped');
    await waitFor(async () => (await rootPids(subject.root, subject.chrome)).length === 0, 'native file-handle release before deleting the closed profile');
    expect((await subject.service.execute({ command: 'browser-delete', id: subject.browser.id })).browsers).toEqual([]);
  } catch (cause) { failure = cause; }
  finally { await cleanup(subject, failure, name); }
}, 90000);
