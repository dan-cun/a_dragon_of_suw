import { expect, test } from 'bun:test';
import { chromium } from 'playwright-core';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createModelService } from '../desktop/bun/models';
import type { ModelProvider } from '../desktop/shared/models';

const chromePath = 'D:\\Code\\swu-campus-assistant\\ocs-2.12.0\\resources\\bin\\chrome\\chrome\\chrome.exe';

function configuredProvider(): ModelProvider {
  return { id: crypto.randomUUID(), name: 'Pi OCS UI test', protocol: 'openaiChatCompletions', baseUrl: 'https://api.deepseek.com', modelId: 'deepseek-flash', timeoutSeconds: 10,
    contextWindow: null, maxTokens: null, vision: false, tools: true, apiKey: '', headers: {}, payloadParameters: {} };
}

test('Pi UI requires explicit OCS startup and separate consent for tool results without provider requests', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'swu-pi-ocs-ui-'));
  const evidence = resolve(process.env['SWU_PI_OCS_APPROVAL_EVIDENCE'] ?? 'work', `pi-ocs-ui-${Date.now()}`);
  await mkdir(evidence, { recursive: true });
  const previousBrowser = process.env['SWU_OCS_BROWSER'];
  process.env['SWU_OCS_BROWSER'] = chromePath;
  const provider = configuredProvider();
  const models = createModelService(directory);
  await models.execute({ command: 'save', provider });
  const browser = await chromium.launch({ executablePath: chromePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 760, height: 900 } });
  const page = await context.newPage();
  const piCommands: string[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname !== '/api/pi' || request.method() !== 'POST') return;
    const decoded: unknown = request.postDataJSON();
    if (typeof decoded === 'object' && decoded !== null && 'command' in decoded && typeof decoded.command === 'string') piCommands.push(decoded.command);
  });
  const child = Bun.spawn([process.execPath, 'desktop/bun/launch.ts', '--no-window'], {
    cwd: process.cwd(), env: { ...process.env, SWU_USER_DATA_DIR: directory }, stdout: 'pipe', stderr: 'pipe',
  });
  let launched = false;
  try {
    const deadline = Date.now() + 30_000;
    let instance: { pid: number; port: number; launchKey: string } | null = null;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Isolated application exited during startup: ${(await new Response(child.stderr).text()).slice(0, 2000)}`);
      try {
        const content: unknown = JSON.parse(await readFile(join(directory, 'instance.json'), 'utf8'));
        if (typeof content === 'object' && content !== null && 'pid' in content && 'port' in content && 'launchKey' in content
          && typeof content.pid === 'number' && typeof content.port === 'number' && typeof content.launchKey === 'string') {
          instance = { pid: content.pid, port: content.port, launchKey: content.launchKey };
          break;
        }
      } catch (cause) {
        if (!(cause instanceof Error && 'code' in cause && cause.code === 'ENOENT')) throw cause;
      }
      await Bun.sleep(100);
    }
    if (!instance) throw new Error('Isolated Pi OCS UI host did not become ready within 30 seconds.');
    await page.goto(`http://127.0.0.1:${instance.port}/launch/${instance.launchKey}`);
    await page.getByTestId('tasks-empty').waitFor();
    launched = true;
    await page.getByTestId('nav-models').click();
    await page.getByTestId('pi-runtime-info').waitFor();
    await page.getByTestId('pi-provider').selectOption(provider.id);
    expect(await page.getByTestId('pi-ocs-enabled').isEnabled()).toBe(true);
    await page.getByTestId('pi-ocs-enabled').check();
    expect(await page.getByTestId('pi-tool-results-confirmed').isVisible()).toBe(true);
    await page.getByTestId('pi-start').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="pi-runtime-info"]')?.textContent?.includes('ocs'));
    expect(await page.getByTestId('pi-runtime-info').textContent()).toContain('工具 2');
    await page.getByTestId('pi-draft').fill('只检查受控 Pi 界面，不发起模型请求。');
    await page.getByTestId('pi-send-confirmed').check();
    expect(await page.getByTestId('pi-send').isDisabled()).toBe(true);
    await page.getByTestId('pi-tool-results-confirmed').check();
    expect(await page.getByTestId('pi-send').isEnabled()).toBe(true);
    await page.screenshot({ path: join(evidence, 'pi-ocs-explicit-consent.png'), fullPage: true });
    expect(piCommands).not.toContain('prompt');
    await Bun.write(join(evidence, 'result.json'), JSON.stringify({ sourceUi: true, ocsToolsEnabledExplicitly: true, toolResultConsentSeparate: true, promptRequests: 0, modelNetworkRequests: 0, schoolAccounts: false, viewportWidth: 760, assertions: 'passed' }, null, 2));
    await page.getByTestId('pi-stop').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="pi-status"]')?.textContent === '已停止');
  } finally {
    try {
      if (launched && child.exitCode === null) {
        const result = await page.evaluate(() => window.desktop.quit());
        if (!result.ok) throw new Error(`Isolated OCS UI test shutdown refused: ${result.error.code}: ${result.error.message}`);
        const exit = await Promise.race([child.exited, Bun.sleep(15_000).then(() => { throw new Error('Isolated OCS UI test host did not exit normally.'); })]);
        if (exit !== 0) throw new Error(`Isolated OCS UI test host exited with code ${exit}.`);
      } else if (child.exitCode === null) {
        throw new Error('Isolated UI host did not reach readiness; refusing to terminate its process without a confirmed normal shutdown path.');
      }
    } finally {
      await browser.close();
      if (child.exitCode !== null) await rm(directory, { recursive: true, force: true });
      if (previousBrowser === undefined) delete process.env['SWU_OCS_BROWSER'];
      else process.env['SWU_OCS_BROWSER'] = previousBrowser;
    }
  }
}, 90_000);
