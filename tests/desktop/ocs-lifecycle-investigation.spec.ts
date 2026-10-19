import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { ocsStateSchema, type OcsState } from '../../desktop/shared/ocs';
import { sanitizeOcsMessage } from '../../desktop/bun/ocs-privacy';

const instanceSchema = z.object({ pid: z.number().int().positive(), port: z.number().int().positive(), launchKey: z.string().min(1) });
const rootProcessSchema = z.object({ browserId: z.string().uuid(), pid: z.number().int().positive(), createdAt: z.string().min(1) });
type RootProcess = z.infer<typeof rootProcessSchema>;
type Application = { process: ChildProcess; browser: Browser; page: Page };
type Observation = {
  stateAt: string;
  processesAt: string;
  browsers: OcsState['browsers'];
  logs: OcsState['logs'];
  roots: RootProcess[];
  ui: { id: string; phase: string | null }[];
};
type Evidence =
  | { kind: 'sample'; stage: string; observation: Observation }
  | { kind: 'action'; at: string; action: string; browserId: string | null }
  | { kind: 'failure'; at: string; stage: string; message: string }
  | { kind: 'shutdown'; at: string; applicationExitCode: number | null; remainingRoots: RootProcess[] }
  | { kind: 'result'; at: string; observedMilliseconds: number; sampleCount: number; executableSha256: string; unexpectedExit: false };

async function record(path: string, evidence: Evidence): Promise<void> {
  await appendFile(path, JSON.stringify(evidence) + '\n', 'utf8');
}

async function executableHash(binary: string): Promise<string> {
  return createHash('sha256').update(await readFile(binary)).digest('hex');
}

async function startInvestigation(directory: string, binary: string): Promise<Application> {
  await mkdir(directory, { recursive: true });
  const child = spawn(binary, ['--no-window'], { env: { ...process.env, SWU_USER_DATA_DIR: directory }, windowsHide: true, stdio: 'ignore' });
  let launchFailure: Error | null = null;
  child.once('error', error => { launchFailure = error; });
  await expect.poll(async () => {
    if (launchFailure) throw launchFailure;
    if (child.exitCode !== null) throw new Error(`The isolated application exited during startup (${child.exitCode}).`);
    try { return instanceSchema.parse(JSON.parse(await readFile(join(directory, 'instance.json'), 'utf8'))).pid === child.pid; }
    catch (cause) {
      if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') return false;
      throw cause;
    }
  }, { timeout: 30_000 }).toBe(true);
  const instance = instanceSchema.parse(JSON.parse(await readFile(join(directory, 'instance.json'), 'utf8')));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1240, height: 860 } });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${instance.port}/launch/${instance.launchKey}`);
  await expect(page.getByTestId('tasks-empty')).toBeVisible();
  return { process: child, browser, page };
}

async function publicState(page: Page): Promise<OcsState> {
  const reply = await page.evaluate(() => window.ocs.execute({ command: 'state' }));
  if (!reply.ok) throw new Error(`OCS public state failed: ${reply.error.code}: ${reply.error.message}`);
  return ocsStateSchema.parse(reply.value);
}

async function rootProcesses(root: string, browserIds: string[], executable: string): Promise<RootProcess[]> {
  if (!isAbsolute(root) || browserIds.some(id => !z.string().uuid().safeParse(id).success)) throw new Error('The investigation profile scope is invalid.');
  if (browserIds.length === 0) return [];
  const profiles = browserIds.map(id => ({ id, path: join(root, 'profiles', id) }));
  const script = "$ErrorActionPreference='Stop';$query=[Console]::In.ReadToEnd()|ConvertFrom-Json;$processes=@(Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\");$rows=@(foreach($profile in $query.profiles){foreach($process in $processes){$line=$process.CommandLine;if($line -and $line -notmatch '(^|\\s)--type(?:=|\\s|$)' -and [string]::Equals($process.ExecutablePath,$query.executable,[StringComparison]::OrdinalIgnoreCase) -and $line.Contains($profile.path,[StringComparison]::OrdinalIgnoreCase)){@{browserId=$profile.id;pid=[int]$process.ProcessId;createdAt=$process.CreationDate.ToUniversalTime().ToString('O')}}}});ConvertTo-Json -InputObject $rows -Compress";
  const child = spawn('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  return await new Promise<RootProcess[]>((accept, reject) => {
    let output = '';
    let diagnostics = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { output += chunk; });
    child.stderr.on('data', (chunk: string) => { diagnostics += chunk; });
    child.once('error', reject);
    child.stdin.on('error', reject);
    child.once('close', code => {
      if (code !== 0) { reject(new Error(`Scoped Chrome process inspection failed (${String(code)}): ${sanitizeOcsMessage(diagnostics, [])}`)); return; }
      try { accept(z.array(rootProcessSchema).parse(JSON.parse(output))); }
      catch (cause) { reject(new Error('Scoped Chrome process inspection returned invalid data.', { cause })); }
    });
    child.stdin.end(JSON.stringify({ profiles, executable }));
  });
}

async function observe(application: Application, root: string, executable: string): Promise<Observation> {
  const state = await publicState(application.page);
  if (state.dataDirectory !== root) throw new Error('OCS returned a data directory outside this investigation.');
  if (resolve(state.browserExecutable).toLowerCase() !== executable.toLowerCase()) throw new Error('OCS did not select the investigated EXE bundled Chrome.');
  const stateAt = new Date().toISOString();
  const ui = await application.page.evaluate(ids => ids.map(id => ({ id, phase: document.querySelector(`[data-testid="ocs-browser-phase-${id}"]`)?.textContent ?? null })), state.browsers.map(browser => browser.id));
  const roots = await rootProcesses(root, state.browsers.map(browser => browser.id), executable);
  return {
    stateAt, processesAt: new Date().toISOString(), browsers: state.browsers,
    logs: state.logs.map(log => ({ ...log, message: sanitizeOcsMessage(log.message, []) })), roots, ui
  };
}

function assertOwnedBrowsers(observation: Observation, expectedIds: string[], baselineRoots: RootProcess[]): void {
  for (const id of expectedIds) {
    const browser = observation.browsers.find(value => value.id === id);
    expect(browser, `Missing browser ${id} in public state.`).toBeDefined();
    expect(browser?.phase, `Browser ${id} stopped without an investigation stop command.`).toBe('running');
    expect(browser?.owned, `Ownership was lost for ${id}.`).toBe(true);
    const roots = observation.roots.filter(value => value.browserId === id);
    expect(roots, `Expected exactly one bundled Chrome root for ${id}.`).toHaveLength(1);
    const baseline = baselineRoots.find(value => value.browserId === id);
    if (!baseline) throw new Error(`The initial root process for ${id} was not recorded.`);
    expect(roots[0]?.pid, `The root process changed for ${id}; no restart was requested.`).toBe(baseline.pid);
    expect(observation.logs.filter(log => log.browserId === id && ['browser.closed', 'browser.stopped', 'browser.cleanup.failed', 'page.crashed'].includes(log.event)), `Unexpected browser lifecycle events for ${id}.`).toEqual([]);
  }
}

async function stopInvestigation(application: Application): Promise<void> {
  await application.page.getByTestId('nav-history').click();
  await expect(application.page.getByTestId('ocs-page')).toHaveCount(0);
  // A read barrier drains commands already issued by the unmounted OCS controller.
  await publicState(application.page);
  const reply = await application.page.evaluate(() => window.desktop.quit());
  if (!reply.ok) throw new Error(`Normal investigation shutdown failed: ${reply.error.code}: ${reply.error.message}`);
  await expect.poll(() => application.process.exitCode, { timeout: 15_000 }).toBe(0);
}

test('OCS lifecycle investigation observes two owned profiles through focus preview navigation and idle time', async () => {
  test.skip(process.env['SWU_OCS_LIFECYCLE_INVESTIGATION'] !== '1', 'Requires an explicit opt-in for the extended no-account lifecycle investigation.');
  test.setTimeout(300_000);
  for (const name of ['SWU_OCS_BROWSER', 'SWU_OCS_DIST']) expect(Object.hasOwn(process.env, name), `${name} must be truly absent, not an empty value.`).toBe(false);
  const binary = process.env['SWU_TEST_EXE'];
  if (!binary || !isAbsolute(binary)) throw new Error('SWU_TEST_EXE must explicitly select the isolated compiled application.');
  const expectedBrowser = join(dirname(binary), 'modules', 'ocs', 'browser', 'chrome.exe');
  const directory = resolve('work', `ocs-investigation-${randomUUID()}`);
  const root = join(directory, 'ocs', 'source-integration');
  const evidence = join(directory, 'timeline.jsonl');
  const initialHash = await executableHash(binary);
  const application = await startInvestigation(directory, binary);
  const ids: string[] = [];
  const errors: string[] = [];
  application.page.on('pageerror', error => { errors.push(sanitizeOcsMessage(error.message, [])); });
  let stage = 'initial-state';
  let failure: Error | null = null;
  let samples = 0;
  let observationStarted = 0;
  let baselineRoots: RootProcess[] = [];
  async function sample(label: string): Promise<Observation> {
    const observation = await observe(application, root, expectedBrowser);
    await record(evidence, { kind: 'sample', stage: label, observation });
    samples += 1;
    return observation;
  }
  async function action(label: string, browserId: string | null): Promise<void> {
    stage = label;
    await record(evidence, { kind: 'action', at: new Date().toISOString(), action: label, browserId });
  }
  try {
    console.log(JSON.stringify({ event: 'ocs.investigation.started', directory, executableSha256: initialHash, repeat: test.info().repeatEachIndex }));
    const page = application.page;
    await page.getByTestId('nav-ocs').click();
    await expect(page.getByTestId('ocs-phase')).toHaveText('源码服务就绪');
    const initial = await publicState(page);
    expect(initial.browsers).toEqual([]);
    expect(initial.userScripts).toEqual([]);
    expect(initial.extensions).toEqual([]);
    for (const name of ['Investigation blank A', 'Investigation blank B']) {
      await action('create-browser', null);
      await page.getByTestId('ocs-browser-new').click();
      await page.getByTestId('ocs-browser-name').fill(name);
      await page.getByTestId('ocs-browser-folder').fill('Lifecycle investigation');
      await page.getByTestId('ocs-browser-url').fill('about:blank');
      await page.getByTestId('ocs-browser-tags').fill('local-only, no-account');
      await page.getByTestId('ocs-browser-notes').fill('No account, scripts, extensions or course execution.');
      await page.getByTestId('ocs-browser-create').click();
      await expect(page.getByTestId('ocs-browser-editor')).toHaveCount(0);
      const created = (await publicState(page)).browsers.find(browser => browser.name === name);
      if (!created) throw new Error('The isolated investigation browser was not created.');
      ids.push(created.id);
    }
    const first = z.string().uuid().parse(ids[0]);
    const second = z.string().uuid().parse(ids[1]);
    await action('edit-browser-B', second);
    await page.getByTestId(`ocs-browser-edit-${second}`).click();
    await page.getByTestId('ocs-browser-name').fill('Investigation blank B edited');
    await page.getByTestId('ocs-browser-save').click();
    await expect(page.getByTestId('ocs-browser-editor')).toHaveCount(0);
    for (const id of ids) {
      await action('start-browser', id);
      await page.getByTestId(`ocs-browser-start-${id}`).click();
      await expect(page.getByTestId(`ocs-browser-phase-${id}`)).toHaveText('运行中', { timeout: 60_000 });
    }
    const baseline = await sample('two-browser-baseline');
    baselineRoots = baseline.roots;
    expect(baselineRoots).toHaveLength(2);
    expect(new Set(baselineRoots.map(value => value.pid)).size).toBe(2);
    assertOwnedBrowsers(baseline, ids, baselineRoots);
    observationStarted = Date.now();
    let nextInteraction = 0;
    let cycle = 0;
    while (Date.now() - observationStarted < 120_000) {
      const elapsed = Date.now() - observationStarted;
      if (elapsed >= nextInteraction) {
        const id = cycle % 2 === 0 ? first : second;
        await action('focus-browser', id);
        await page.getByTestId(`ocs-browser-focus-${id}`).click();
        assertOwnedBrowsers(await sample('after-focus'), ids, baselineRoots);
        await action('select-and-preview-browser', id);
        await page.getByTestId(`ocs-browser-select-${id}`).click();
        await page.getByTestId('ocs-browser-preview').click();
        const image = page.getByTestId('ocs-browser-preview-result').locator('img');
        await expect(image).toBeVisible();
        await expect.poll(() => image.evaluate(element => element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0)).toBe(true);
        assertOwnedBrowsers(await sample('after-preview'), ids, baselineRoots);
        await page.setViewportSize({ width: 760, height: 900 });
        await page.screenshot({ path: join(directory, `preview-cycle-${cycle}.png`), fullPage: true });
        await action('navigate-away', null);
        await page.getByTestId('nav-history').click();
        await expect(page.getByTestId('ocs-page')).toHaveCount(0);
        assertOwnedBrowsers(await sample('away-from-ocs'), ids, baselineRoots);
        await action('navigate-back', null);
        await page.getByTestId('nav-ocs').click();
        await expect(page.getByTestId('ocs-browsers')).toBeVisible();
        assertOwnedBrowsers(await sample('after-navigation'), ids, baselineRoots);
        cycle += 1;
        nextInteraction = elapsed + 20_000;
      }
      stage = 'idle-observation';
      assertOwnedBrowsers(await sample(stage), ids, baselineRoots);
      expect(errors).toEqual([]);
      await delay(1500);
    }
    expect(await executableHash(binary), 'The production EXE changed during the investigation; this round cannot be attributed to one build.').toBe(initialHash);
    const result = { kind: 'result' as const, at: new Date().toISOString(), observedMilliseconds: Date.now() - observationStarted, sampleCount: samples, executableSha256: initialHash, unexpectedExit: false as const };
    await record(evidence, result);
    await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
  } catch (cause: unknown) {
    failure = cause instanceof Error ? cause : new Error('The lifecycle investigation threw a non-Error value.', { cause });
    try {
      await record(evidence, { kind: 'failure', at: new Date().toISOString(), stage, message: sanitizeOcsMessage(failure.message, []) });
      const observation = await sample('failure-before-cleanup');
      await writeFile(join(directory, 'failure-diagnostics.json'), JSON.stringify({ stage, observation }, null, 2), 'utf8');
    } catch (diagnosticCause: unknown) {
      failure = new AggregateError([failure, diagnosticCause], 'Lifecycle investigation and failure collection both failed.', { cause: failure });
    }
  } finally {
    const cleanupFailures: Error[] = [];
    try {
      await record(evidence, { kind: 'action', at: new Date().toISOString(), action: 'normal-application-shutdown', browserId: null });
      if (application.process.exitCode === null && application.process.signalCode === null) await stopInvestigation(application);
      const remainingRoots = await rootProcesses(root, ids, expectedBrowser);
      await record(evidence, { kind: 'shutdown', at: new Date().toISOString(), applicationExitCode: application.process.exitCode, remainingRoots });
      expect(remainingRoots).toEqual([]);
    } catch (cause: unknown) { cleanupFailures.push(cause instanceof Error ? cause : new Error('Normal investigation cleanup failed.', { cause })); }
    try { await application.browser.close(); }
    catch (cause: unknown) { cleanupFailures.push(cause instanceof Error ? cause : new Error('The owned investigation UI browser did not close.', { cause })); }
    console.log(JSON.stringify({ event: 'ocs.investigation.finished', directory, samples, bodyFailed: failure !== null, cleanupFailed: cleanupFailures.length > 0 }));
    if (failure && cleanupFailures.length > 0) throw new AggregateError([failure, ...cleanupFailures], 'Lifecycle investigation and normal cleanup both failed.', { cause: failure });
    if (failure) throw failure;
    if (cleanupFailures.length > 0) throw new AggregateError(cleanupFailures, 'Normal lifecycle investigation cleanup failed.');
  }
});
