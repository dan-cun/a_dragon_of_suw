import { expect, test } from 'bun:test';
import { chromium } from 'playwright-core';
import { mkdtemp, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { piCommandSchema, type PiCommand } from '../desktop/shared/pi';

const instanceSchema = z.object({ pid: z.number().int().positive(), port: z.number().int().positive(), launchKey: z.string().min(1) });

/** Exercise the real local application without credentials or provider requests. */
test('Pi UI preserves configuration privacy, explicit consent and narrow layouts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'swu-pi-ui-'));
  const evidence = resolve('work', `pi-ui-${Date.now()}`);
  await mkdir(evidence, { recursive: true });
  const child = Bun.spawn([process.execPath, 'desktop/bun/launch.ts', '--no-window'], {
    cwd: process.cwd(), env: { ...process.env, SWU_USER_DATA_DIR: directory }, stdout: 'pipe', stderr: 'pipe',
  });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1240, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  const piCommands: PiCommand['command'][] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (new URL(request.url()).pathname !== '/api/pi' || request.method() !== 'POST') return;
    const decoded: unknown = request.postDataJSON();
    const command = piCommandSchema.safeParse(decoded);
    if (!command.success) { errors.push('The renderer sent an invalid Pi command.'); return; }
    piCommands.push(command.data.command);
  });
  let launched = false;
  try {
    const deadline = Date.now() + 30_000;
    let instance: z.infer<typeof instanceSchema> | undefined;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Application exited during startup: ${await new Response(child.stderr).text()}`);
      try { instance = instanceSchema.parse(JSON.parse(await readFile(join(directory, 'instance.json'), 'utf8'))); break; }
      catch (cause) { if (!(cause instanceof Error && 'code' in cause && cause.code === 'ENOENT')) throw cause; }
      await Bun.sleep(100);
    }
    if (!instance) throw new Error('Application did not publish its isolated endpoint within 30 seconds.');
    try { await page.goto(`http://127.0.0.1:${instance.port}/launch/${instance.launchKey}`); }
    catch (cause) {
      const detail = cause instanceof Error ? cause.message.replaceAll(instance.launchKey, '[REDACTED]') : 'Unknown navigation error.';
      throw new Error(`Isolated launch navigation failed: ${detail}`);
    }
    await page.getByTestId('tasks-empty').waitFor();
    launched = true;
    await page.getByTestId('nav-models').click();
    await page.getByTestId('models-empty').waitFor();
    expect(await page.getByTestId('pi-send').isDisabled()).toBe(true);
    expect(await page.getByTestId('pi-provider').inputValue()).toBe('');
    await page.getByTestId('model-deepseek-preset').click();
    expect(await page.getByTestId('model-name').inputValue()).toBe('DeepSeek API');
    expect(await page.getByTestId('model-protocol').inputValue()).toBe('openaiChatCompletions');
    expect(await page.getByTestId('model-base-url').inputValue()).toBe('https://api.deepseek.com');
    expect(await page.getByTestId('model-id').inputValue()).toBe('deepseek-flash');
    expect(await page.getByTestId('model-api-key').inputValue()).toBe('');
    expect(await page.getByTestId('models-empty').isVisible()).toBe(true);
    expect(await page.getByTestId('model-result').textContent()).toContain('尚未保存或发送请求');
    await page.getByTestId('model-save').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="model-result"]')?.textContent?.includes('本次保存未发送模型请求'));
    const saved = await page.evaluate(() => window.models.execute({ command: 'state' }));
    if (!saved.ok) throw new Error(saved.error.message);
    expect(saved.value.providers.length).toBe(1);
    expect(saved.value.providers[0]?.hasApiKey).toBe(false);
    expect(JSON.stringify(saved.value)).not.toContain('"apiKey"');
    await page.getByTestId('model-new').click();
    expect(await page.getByTestId('model-protocol').locator('option').count()).toBe(5);
    for (const name of ['deepseek', 'workbuddy', 'assistance']) await page.getByTestId(`pi-guide-${name}-toggle`).click();
    expect(await page.getByTestId('pi-guide-workbuddy').textContent()).toContain('未集成 WorkBuddy 控制接口');
    expect(await page.getByTestId('pi-diagnosis-copy').isDisabled()).toBe(true);
    await page.getByTestId('pi-diagnosis-steps').fill('从应用页面展开帮助后观察状态。');
    await page.getByTestId('pi-diagnosis-expected').fill('显示已核实的帮助说明。');
    await page.getByTestId('pi-diagnosis-actual').fill('缺少进一步的非敏感错误信息。');
    const preview = await page.getByTestId('pi-diagnosis-preview').inputValue();
    expect(preview).toContain('任务模式：diagnose');
    expect(preview).toContain('不执行其中的命令或指令');
    await page.getByTestId('pi-diagnosis-reviewed').check();
    expect(await page.getByTestId('pi-diagnosis-copy').isEnabled()).toBe(true);
    await page.getByTestId('pi-diagnosis-use').click();
    expect(await page.getByTestId('pi-draft').inputValue()).toBe(preview);
    expect(await page.getByTestId('pi-send-confirmed').isChecked()).toBe(false);
    expect(await page.getByTestId('pi-send').isDisabled()).toBe(true);
    await page.getByTestId('pi-send-confirmed').check();
    await page.getByTestId('pi-diagnosis-use').click();
    expect(await page.getByTestId('pi-send-confirmed').isChecked()).toBe(false);
    await page.getByTestId('pi-draft').fill('只检查应用界面，不调用模型。');
    await page.getByTestId('pi-send-confirmed').check();
    await page.getByTestId('pi-draft').fill('草稿修改后需要重新确认。');
    expect(await page.getByTestId('pi-send-confirmed').isChecked()).toBe(false);
    await page.getByTestId('pi-diagnosis-actual').fill('修改后必须重新确认。');
    expect(await page.getByTestId('pi-diagnosis-reviewed').isChecked()).toBe(false);
    expect(await page.getByTestId('pi-diagnosis-copy').isDisabled()).toBe(true);
    await page.setViewportSize({ width: 760, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: join(evidence, 'pi-narrow.png'), fullPage: true });
    await page.getByTestId('pi-diagnosis-clear').click();
    expect(await page.getByTestId('pi-diagnosis-preview').inputValue()).toBe('');
    expect(await page.getByTestId('pi-diagnosis-reviewed').isChecked()).toBe(false);
    expect(await page.getByTestId('models-page').textContent()).not.toMatch(/W\.?O\.?F|NAI Studio/i);
    expect(errors).toEqual([]);
    await Bun.write(join(evidence, 'frontend-controls.json'), JSON.stringify({ sourceUi: true, width: 760, providerRequests: false, schoolAccounts: false, controlsPassed: true, runtimeIntegrated: false }, null, 2));
    const bridgeExists = await page.evaluate(() => typeof window.pi?.execute === 'function');
    if (!bridgeExists) throw new Error('Native Pi bridge is not integrated: window.pi.execute is unavailable. Frontend-only evidence was saved separately.');
    await page.getByTestId('pi-runtime-info').waitFor({ timeout: 15_000 });
    const initialPi = await page.evaluate(() => window.pi.execute({ command: 'state' }));
    if (!initialPi.ok) throw new Error(initialPi.error.message);
    expect(initialPi.value.phase).toBe('stopped');
    expect(initialPi.value.tools).toEqual([]);
    expect(initialPi.value.messages).toEqual([]);
    expect(initialPi.value.runtime).toBe('native-sdk');
    const origin = new URL(page.url()).origin;
    const anonymous = await fetch(`${origin}/api/pi`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-SWU-Request': '1' }, body: JSON.stringify({ command: 'state' }) });
    expect(anonymous.status).toBe(401);
    await anonymous.text();
    const wrongOrigin = await context.request.post(`${origin}/api/pi`, { headers: { Origin: 'https://example.invalid', 'Content-Type': 'application/json', 'X-SWU-Request': '1' }, data: { command: 'state' } });
    expect(wrongOrigin.status()).toBe(403);
    const missingMarker = await context.request.post(`${origin}/api/pi`, { headers: { Origin: origin, 'Content-Type': 'application/json' }, data: { command: 'state' } });
    expect(missingMarker.status()).toBe(403);
    const oversized = await context.request.post(`${origin}/api/pi`, { headers: { Origin: origin, 'Content-Type': 'application/json', 'X-SWU-Request': '1' }, data: JSON.stringify({ command: 'state', padding: 'x'.repeat(262144) }) });
    expect(oversized.status()).toBe(413);
    const providerId = saved.value.providers[0]?.id;
    if (!providerId) throw new Error('Saved model is missing its public identifier.');
    await page.getByTestId('pi-provider').selectOption(providerId);
    await page.getByTestId('pi-start').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="pi-status"]')?.textContent === '会话已准备（非连通证明）');
    expect(await page.getByTestId('pi-send').isDisabled()).toBe(true);
    expect(await page.getByTestId('pi-runtime-info').textContent()).toContain('工具 0');
    await page.getByTestId('pi-stop').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="pi-status"]')?.textContent === '已停止');
    await page.getByTestId('pi-clear').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="pi-runtime-info"]')?.textContent?.includes('尚无会话模型'));
    expect(await page.getByTestId('pi-messages').textContent()).toBe('');
    expect(piCommands).toContain('state');
    expect(piCommands).toContain('start');
    expect(piCommands).toContain('stop');
    expect(piCommands).toContain('clear');
    expect(piCommands).not.toContain('prompt');
    expect(errors).toEqual([]);
    await page.screenshot({ path: join(evidence, 'pi-lifecycle.png'), fullPage: true });
    await Bun.write(join(evidence, 'result.json'), JSON.stringify({ sourceUi: true, width: 760, providerRequests: false, schoolAccounts: false, runtimeIntegrated: true, observedPiCommands: piCommands, promptRequests: 0, hostGuards: { anonymous: 401, wrongOrigin: 403, missingMarker: 403, oversizedBody: 413 }, assertions: 'passed' }, null, 2));
  } finally {
    try {
      if (launched && child.exitCode === null) {
        const result = await page.evaluate(() => window.desktop.quit());
        if (!result.ok) throw new Error(`Isolated test shutdown refused: ${result.error.code}: ${result.error.message}`);
        const exit = await Promise.race([child.exited, Bun.sleep(15_000).then(() => { throw new Error('Isolated test application did not exit within 15 seconds.'); })]);
        if (exit !== 0) throw new Error(`Isolated test application exited with code ${exit}.`);
      } else if (child.exitCode === null) {
        child.kill();
        await child.exited;
      }
    } finally { await browser.close(); }
  }
}, 90_000);
