import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, writeFile, unlink, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { shiftCalendarDate } from '../../desktop/renderer/heatmap-model';
import { getShanghaiClock } from '../../desktop/core/time';
import { hasRunningInstance } from '../../desktop/bun/instance';
import { readStore } from '../../desktop/bun/store';
import { releaseEdition, editionLabel } from '../../desktop/shared/edition';
import packageMetadata from '../../package.json' with { type: 'json' };

const executable = resolve(process.env['SWU_TEST_EXE'] ?? 'releases/打卡助手.exe');
const instanceSchema = z.object({ pid: z.number(), port: z.number(), launchKey: z.string() });

async function start(directory: string, binary: string): Promise<{ process: ChildProcess; browser: Browser; page: Page; origin: string }> {
  await mkdir(directory, { recursive: true });
  const child = spawn(binary, ['--no-window'], { env: { ...process.env, SWU_USER_DATA_DIR: directory }, windowsHide: true, stdio: 'ignore' });
  let instance: z.infer<typeof instanceSchema> | null = null;
  await expect.poll(async () => {
    try { instance = instanceSchema.parse(JSON.parse(await readFile(join(directory, 'instance.json'), 'utf8'))); return true; }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      return false;
    }
  }, { timeout: 30_000 }).toBe(true);
  if (instance === null) throw new Error('Application did not publish its local endpoint.');
  const details = instanceSchema.parse(instance);
  const origin = `http://127.0.0.1:${details.port}`;
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1240, height: 860 } });
  const page = await context.newPage();
  await page.goto(`${origin}/launch/${details.launchKey}`);
  await expect(page.getByTestId('tasks-empty')).toBeVisible();
  return { process: child, browser, page, origin };
}

async function stop(application: Awaited<ReturnType<typeof start>>): Promise<void> {
  const result = await application.page.evaluate(() => window.desktop.quit());
  if (!result.ok) throw new Error(`Application refused test shutdown: ${result.error.code}: ${result.error.message}`);
  await expect.poll(() => application.process.exitCode, { timeout: 15_000 }).toBe(0);
  await application.browser.close();
}

test('Compiled EXE serves the real UI, protects local operations and persists preferences across restart', async () => {
  const directory = resolve('work', `desktop-${randomUUID()}`);
  let application = await start(directory, executable);
  try {
    await expect(application.page.getByTestId('release-edition')).toHaveText(editionLabel);
    const errors: string[] = [];
    application.page.on('pageerror', (error) => errors.push(error.message));
    const disconnectedClients = await application.page.evaluate(async () => {
      for (let index = 0; index < 10; index += 1) {
        const controller = new AbortController();
        const response = await fetch('/api/events', { signal: controller.signal });
        if (!response.ok || response.body === null) throw new Error('State stream did not open.');
        const reader = response.body.getReader();
        const first = await reader.read();
        if (first.done) throw new Error('State stream closed before its initial state.');
        if (index % 2 === 0) await reader.cancel();
        else controller.abort();
      }
      return 10;
    });
    expect(disconnectedClients).toBe(10);
    expect((await fetch(`${application.origin}/api/state`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401);
    const crossOrigin = await application.page.context().request.post(`${application.origin}/api/state`, { headers: { Origin: 'https://example.com', 'Content-Type': 'application/json', 'X-SWU-Request': '1' }, data: {} });
    expect(crossOrigin.status()).toBe(403);
    const invalidRun = await application.page.evaluate(() => window.desktop.checkin('unknown-task'));
    expect(invalidRun.ok).toBe(false);
    await expect(application.page.getByTestId('phase-status')).toContainText('就绪');
    await application.page.getByTestId('nav-history').click();
    await expect(application.page.getByTestId('history-empty')).toBeVisible();
    await expect(application.page.getByTestId('log-list')).toBeVisible();
    await application.page.getByTestId('nav-settings').click();
    await expect(application.page.getByTestId('license-details')).toBeVisible();
    await application.page.getByTestId('test-notification').click();
    await expect(application.page.getByTestId('notice')).toContainText('Windows');
    await application.page.getByTestId('schedule-enabled').check();
    await application.page.getByTestId('save-settings').click();
    await expect(application.page.getByTestId('notice')).toContainText('先登录');
    await application.page.getByTestId('schedule-enabled').uncheck();
    const saved = await application.page.evaluate(async () => {
      const result = await window.desktop.getState();
      if (!result.ok) throw new Error(result.error.message);
      return window.desktop.saveSettings({ ...result.value.settings, scheduleEnabled: false, scheduleTime: '21:15', closeToTray: false, launchAtLogin: false });
    });
    expect(saved.ok).toBe(true);
    await application.page.getByTestId('nav-today').click();
    await application.page.getByTestId('dismiss-notice').click();
    await expect(application.page.getByTestId('save-location')).toBeDisabled();
    const rejected = await application.page.evaluate(() => window.desktop.saveLocation({ longitude: 181, latitude: 91, address: '' }));
    expect(rejected.ok).toBe(false);
    await application.page.getByTestId('location-longitude').fill('0');
    await application.page.getByTestId('location-latitude').fill('0');
    await application.page.getByTestId('location-address').fill('坐标保存验收（不提交）');
    await application.page.getByTestId('save-location').click();
    await expect(application.page.getByTestId('location-status')).toContainText('已保存');
    await application.page.getByTestId('location-longitude').fill('');
    await expect(application.page.getByTestId('location-status')).toContainText('修改后请保存');
    await expect(application.page.getByTestId('save-location')).toBeDisabled();
    await application.page.getByTestId('location-longitude').fill('0');
    await expect(application.page.getByTestId('location-status')).toContainText('已保存');
    await expect(application.page.getByTestId('schedule-status')).toContainText('尚未开启');
    await application.page.screenshot({ path: resolve('work/preview.png'), fullPage: true });
    const duplicate = spawn(executable, ['--no-window'], { env: { ...process.env, SWU_USER_DATA_DIR: directory }, windowsHide: true, stdio: 'ignore' });
    await expect.poll(() => duplicate.exitCode, { timeout: 10_000 }).toBe(0);
    const running = instanceSchema.parse(JSON.parse(await readFile(join(directory, 'instance.json'), 'utf8')));
    expect(running.pid).toBe(application.process.pid);
    expect(errors).toEqual([]);
    await stop(application);
    application = await start(directory, executable);
    const state = await application.page.evaluate(() => window.desktop.getState());
    expect(state.ok && state.value.settings.scheduleTime).toBe('21:15');
    expect(state.ok && state.value.settings.closeToTray).toBe(false);
    expect(state.ok && state.value.settings.location).toEqual({ longitude: 0, latitude: 0, address: '坐标保存验收（不提交）' });
    await expect(application.page.getByTestId('location-longitude')).toHaveValue('0');
    await expect(application.page.getByTestId('location-latitude')).toHaveValue('0');
    await application.page.setViewportSize({ width: 760, height: 900 });
    expect(await application.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await application.page.screenshot({ path: resolve('work/coordinates-narrow.png'), fullPage: true });
    await stop(application);
  } catch (error) {
    await application.browser.close();
    throw error;
  }
});

test('Quitting during authentication waits for cleanup and persists the final idle state', async () => {
  const directory = resolve('work', `authentication-quit-${randomUUID()}`);
  const application = await start(directory, executable);
  try {
    const login = await application.page.evaluate(() => window.desktop.login());
    expect(login.ok && login.value.phase).toBe('authenticating');
    await stop(application);
    expect(readStore(directory).session).toBe(null);
    expect(await hasRunningInstance(directory)).toBe(false);
    const sessions = await import('node:fs/promises').then(fs => fs.readdir(join(directory, 'auth-sessions')));
    expect(sessions).toEqual([]);
  } catch (error) {
    await application.browser.close();
    throw error;
  }
});

test('Login can be canceled immediately and opened again using a fresh Edge authentication session', async () => {
  const application = await start(resolve('work', `authentication-${randomUUID()}`), executable);
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await application.page.getByTestId('login-button').click();
      await expect(application.page.getByTestId('login-frame')).toBeVisible();
      await application.page.frameLocator('[data-testid="login-frame"]').locator('#cancel').click();
      await expect(application.page.getByTestId('login-frame')).not.toBeVisible({ timeout: 15_000 });
      await expect(application.page.getByTestId('phase-status')).toContainText('就绪');
      await expect(application.page.getByTestId('notice')).toContainText('取消');
    }
    await stop(application);
  } catch (error) {
    await application.browser.close();
    throw error;
  }
});

test('Remembered credentials stay out of the login DOM, survive cancellation and can be forgotten', async () => {
  const directory = resolve('work', `remembered-login-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const password = randomUUID();
  const username = randomUUID();
  const writer = spawn('D:/Code/bun/bun.exe', ['-e', "import { writeLoginMemory } from './desktop/bun/login-memory.ts'; await writeLoginMemory(process.argv[1], JSON.parse(await Bun.stdin.text()));", directory], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
  writer.stdin?.end(JSON.stringify({ username, password, cookies: [] }));
  await expect.poll(() => writer.exitCode, { timeout: 15_000 }).toBe(0);
  const application = await start(directory, executable);
  try {
    const initial = await application.page.evaluate(() => window.desktop.getState());
    expect(initial.ok && initial.value.rememberedLogin).toBe(true);
    await application.page.getByTestId('login-button').click();
    const frame = application.page.frameLocator('[data-testid="login-frame"]');
    await expect(frame.locator('#use-saved')).toBeChecked({ timeout: 15_000 });
    await expect(frame.locator('#password')).toBeDisabled();
    await expect(frame.locator('#password')).toHaveValue('');
    const leaksPassword = await application.page.evaluate(secret => document.documentElement.outerHTML.includes(secret), password);
    expect(leaksPassword).toBe(false);
    await frame.locator('#cancel').click();
    await expect(application.page.getByTestId('login-frame')).not.toBeVisible({ timeout: 15_000 });
    const canceled = await application.page.evaluate(() => window.desktop.getState());
    expect(canceled.ok && canceled.value.rememberedLogin).toBe(true);
    await application.page.getByTestId('nav-settings').click();
    await application.page.getByTestId('forget-login').click();
    await expect(application.page.getByTestId('forget-login')).toBeDisabled();
    const forgotten = await application.page.evaluate(() => window.desktop.getState());
    expect(forgotten.ok && forgotten.value.rememberedLogin).toBe(false);
  } finally {
    await stop(application);
    const path = join(directory, 'login-memory.json');
    try { await unlink(path); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  }
});

test('A rejected real saved session is labeled accurately and reauthentication cancellation preserves settings', async () => {
  const source = process.env['SWU_TEST_SESSION_SOURCE'];
  test.skip(source === undefined, 'Requires an explicitly selected real saved session; no fabricated school responses.');
  if (source === undefined) throw new Error('Missing session source.');
  const saved = readStore(source);
  if (saved.session === null) throw new Error('The selected source has no saved session.');
  const directory = resolve('work', `session-review-${randomUUID()}`);
  const statePath = join(directory, 'state.json');
  await mkdir(directory, { recursive: true });
  const isolated = { ...saved, settings: { ...saved.settings, scheduleEnabled: false, launchAtLogin: false } };
  await writeFile(statePath, JSON.stringify(isolated), { encoding: 'utf8', mode: 0o600 });
  let application: Awaited<ReturnType<typeof start>> | null = null;
  try {
    application = await start(directory, executable);
    const page = application.page;
    await expect(page.getByTestId('session-status')).toContainText('待验证');
    await page.getByTestId('sync-button').click();
    await expect(page.getByTestId('notice')).toContainText('401', { timeout: 30_000 });
    await expect(page.getByTestId('session-status')).toHaveText('需重新登录');
    const blocked = await page.evaluate(async () => {
      const before = await window.desktop.getState();
      const result = await window.desktop.sync();
      const after = await window.desktop.getState();
      if (!before.ok || !after.ok) throw new Error('Could not read session state.');
      return {
        rejected: !result.ok && result.error.code === 'AUTH_REQUIRED',
        noNewRequests: before.value.logs.filter(log => log.request !== undefined).length === after.value.logs.filter(log => log.request !== undefined).length,
        tasksCleared: after.value.tasks.length === 0,
      };
    });
    expect(blocked).toEqual({ rejected: true, noNewRequests: true, tasksCleared: true });
    await page.getByTestId('relogin-button').click();
    await expect(page.getByTestId('login-frame')).toBeVisible();
    await page.frameLocator('[data-testid="login-frame"]').locator('#cancel').click();
    await expect(page.getByTestId('login-frame')).not.toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('session-status')).toHaveText('需重新登录');
    await page.setViewportSize({ width: 760, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await stop(application);
    application = null;
    const after = readStore(directory);
    expect(JSON.stringify(after.settings) === JSON.stringify(isolated.settings)).toBe(true);
    expect(JSON.stringify(after.schedule) === JSON.stringify(isolated.schedule)).toBe(true);
    expect(after.lastScheduledDate === isolated.lastScheduledDate).toBe(true);
    expect(JSON.stringify(after.session) === JSON.stringify(isolated.session)).toBe(true);
    expect(after.logs.filter(log => log.request !== undefined).slice(saved.logs.filter(log => log.request !== undefined).length).every(log => log.request?.method === 'GET' && log.request.path.endsWith('/auth/user'))).toBe(true);
  } finally {
    if (application !== null) await stop(application);
    await unlink(statePath);
  }
});

test('Installer shutdown exits the live backend and preserves saved preferences', async () => {
  const directory = resolve('work', `installer-shutdown-${randomUUID()}`);
  const application = await start(directory, executable);
  try {
    expect(await hasRunningInstance(directory)).toBe(true);
    const saved = await application.page.evaluate(async () => {
      const result = await window.desktop.getState();
      if (!result.ok) throw new Error(result.error.message);
      return window.desktop.saveSettings({ ...result.value.settings, scheduleTime: '21:18' });
    });
    expect(saved.ok).toBe(true);
    const helper = spawn(executable, ['--shutdown'], { env: { ...process.env, SWU_USER_DATA_DIR: directory }, windowsHide: true, stdio: 'ignore' });
    await expect.poll(() => helper.exitCode, { timeout: 25_000 }).toBe(0);
    expect(application.process.exitCode).toBe(0);
    expect(await hasRunningInstance(directory)).toBe(false);
    const disk = z.object({ settings: z.object({ scheduleTime: z.string() }) }).parse(JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')));
    expect(disk.settings.scheduleTime).toBe('21:18');
  } finally {
    await application.browser.close();
    if (application.process.exitCode === null) throw new Error('Installer shutdown left a backend process running.');
  }
});

test('Stale instance metadata with a reused PID does not block installation or stop an unrelated process', async () => {
  const directory = resolve('work', `stale-instance-${randomUUID()}`);
  const application = await start(directory, executable);
  const recorded = instanceSchema.parse(JSON.parse(await readFile(join(directory, 'instance.json'), 'utf8')));
  await stop(application);
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
  try {
    if (unrelated.pid === undefined) throw new Error('Unrelated test process did not start.');
    await writeFile(join(directory, 'instance.json'), JSON.stringify({ ...recorded, pid: unrelated.pid }), 'utf8');
    const helper = spawn(executable, ['--shutdown'], { env: { ...process.env, SWU_USER_DATA_DIR: directory }, windowsHide: true, stdio: 'ignore' });
    await expect.poll(() => helper.exitCode, { timeout: 25_000 }).toBe(0);
    expect(unrelated.exitCode).toBe(null);
    expect(unrelated.signalCode).toBe(null);
    expect(await hasRunningInstance(directory)).toBe(false);
  } finally {
    unrelated.kill();
    await expect.poll(() => unrelated.exitCode !== null || unrelated.signalCode !== null, { timeout: 10_000 }).toBe(true);
  }
});

test('Random windows and date exclusions persist, and leave blocks manual check-in before any school request', async () => {
  const directory = resolve('work', `schedule-ui-${randomUUID()}`);
  let application = await start(directory, executable);
  const today = getShanghaiClock(new Date()).date;
  const tomorrow = shiftCalendarDate(today, 1);
  const lastDay = shiftCalendarDate(today, 3);
  try {
    await application.page.getByTestId('nav-settings').click();
    await application.page.getByTestId('schedule-mode').selectOption('random');
    await application.page.getByTestId('schedule-time').fill('21:05');
    await application.page.getByTestId('schedule-end-time').fill('20:00');
    await application.page.getByTestId('save-settings').click();
    await expect(application.page.getByTestId('notice')).toContainText('结束时间必须晚于开始时间');
    await application.page.getByTestId('schedule-end-time').fill('23:00');
    await application.page.getByTestId('paused-start').fill(tomorrow);
    await application.page.getByTestId('paused-end').fill(lastDay);
    await application.page.getByTestId('paused-add').click();
    await expect(application.page.getByTestId('paused-list')).toContainText(lastDay);
    await application.page.getByTestId('leave-start').fill(today);
    await application.page.getByTestId('leave-add').click();
    await application.page.getByTestId('save-settings').click();
    await expect(application.page.getByTestId('notice')).toContainText('已保存');
    await application.page.getByTestId('nav-today').click();
    await expect(application.page.getByTestId('schedule-status')).toContainText('手动和自动打卡均已禁止');
    const rejected = await application.page.evaluate(() => window.desktop.checkin('not-a-school-task'));
    expect(!rejected.ok && rejected.error.code).toBe('LEAVE_DAY');
    const state = await application.page.evaluate(() => window.desktop.getState());
    expect(state.ok && state.value.history.length).toBe(0);
    expect(state.ok && state.value.logs.filter(log => log.request !== undefined).length).toBe(0);
    await stop(application);
    application = await start(directory, executable);
    const restored = await application.page.evaluate(() => window.desktop.getState());
    expect(restored.ok && restored.value.settings.scheduleMode).toBe('random');
    expect(restored.ok && restored.value.settings.scheduleTime).toBe('21:05');
    expect(restored.ok && restored.value.settings.scheduleEndTime).toBe('23:00');
    expect(restored.ok && restored.value.settings.leaveDates).toEqual([today]);
    expect(restored.ok && restored.value.settings.pausedDates.length).toBe(3);
    await application.page.getByTestId('nav-settings').click();
    await application.page.screenshot({ path: resolve('work/schedule-settings.png'), fullPage: true });
    await application.page.setViewportSize({ width: 760, height: 900 });
    expect(await application.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await application.page.screenshot({ path: resolve('work/schedule-settings-narrow.png'), fullPage: true });
    await stop(application);
  } catch (error) {
    await application.browser.close();
    throw error;
  }
});

test('Real empty history renders the calendar and supports date selection, keyboard navigation and narrow screens', async () => {
  const application = await start(resolve('work', `heatmap-${randomUUID()}`), executable);
  try {
    const errors: string[] = [];
    application.page.on('pageerror', error => errors.push(error.message));
    await application.page.getByTestId('nav-heatmap').click({ timeout: 5000 });
    await expect(application.page.getByTestId('checkin-heatmap')).toBeVisible();
    await expect(application.page.getByTestId('heatmap-confirmed-days')).toHaveText('0天');
    await expect(application.page.getByTestId('heatmap-legend').locator('.heatmap-swatch')).toHaveCount(2);
    await expect(application.page.getByTestId('heatmap-longest-streak')).toHaveText('0天');
    await expect(application.page.getByTestId('heatmap-day-empty')).toBeVisible();
    const date = (await application.page.getByTestId('heatmap-selected-date').innerText()).slice(0, 10);
    await expect(application.page.getByTestId(`heatmap-day-${date}`)).toHaveAttribute('data-signed', 'false');
    const yesterday = shiftCalendarDate(date, -1);
    const previousWeek = shiftCalendarDate(yesterday, -7);
    await application.page.getByTestId(`heatmap-day-${yesterday}`).click();
    await expect(application.page.getByTestId('heatmap-selected-date')).toContainText(yesterday);
    await application.page.getByTestId(`heatmap-day-${yesterday}`).press('ArrowLeft');
    await expect(application.page.getByTestId('heatmap-selected-date')).toContainText(previousWeek);
    await expect(application.page.getByTestId(`heatmap-day-${previousWeek}`)).toBeFocused();
    await application.page.screenshot({ path: resolve('work/heatmap-preview.png'), fullPage: true });
    await application.page.setViewportSize({ width: 760, height: 900 });
    const scroll = application.page.getByTestId('heatmap-scroll');
    expect(await scroll.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
    expect(await application.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await application.page.screenshot({ path: resolve('work/heatmap-narrow.png'), fullPage: true });
    expect(errors).toEqual([]);
    await stop(application);
  } catch (error) {
    await application.browser.close();
    throw error;
  }
});

test('The merged EXE starts its bundled Lepao engine, checks the real environment and protects busy shutdown', async () => {
  const directory = resolve('work', `merged-engine-${randomUUID()}`);
  const application = await start(directory, executable);
  try {
    const errors: string[] = [];
    application.page.on('pageerror', error => errors.push(error.message));
    await application.page.getByTestId('nav-lepao').click();
    await expect(application.page.getByTestId('lepao-add')).toBeEnabled({ timeout: 30_000 });
    await expect(application.page.getByTestId('lepao-log-panel')).not.toHaveAttribute('open');
    await application.page.getByTestId('lepao-log-panel').locator('summary').click();
    await expect(application.page.getByTestId('lepao-logs')).toContainText('dan-cun');
    await expect(application.page.getByTestId('lepao-logs')).toContainText('非商业授权软件');
    await expect(application.page.getByTestId('lepao-run')).toBeDisabled();
    const started = await application.page.evaluate(() => window.lepao.execute({ command: 'check' }));
    expect(started.ok && started.value.busy).toBe(true);
    const quit = await application.page.evaluate(() => window.desktop.quit());
    expect(!quit.ok && quit.error.code).toBe('OPERATION_BUSY');
    await expect(application.page.getByTestId('lepao-stop')).toBeVisible();
    await application.page.context().setOffline(true);
    await expect(application.page.getByTestId('lepao-error')).toContainText('状态更新已停止');
    await expect(application.page.getByTestId('lepao-phase')).toHaveText('状态读取失败');
    await expect(application.page.getByTestId('lepao-reconnect')).toBeEnabled();
    await expect(application.page.getByTestId('lepao-stop')).toBeEnabled();
    await application.page.context().setOffline(false);
    await application.page.getByTestId('lepao-reconnect').click();
    await expect(application.page.getByTestId('lepao-error')).toHaveCount(0);
    await expect(application.page.getByTestId('lepao-result')).toContainText('环境检查完成', { timeout: 40_000 });
    await expect(application.page.getByTestId('lepao-phase')).toHaveText('空闲');
    const checked = await application.page.evaluate(() => window.lepao.execute({ command: 'state' }));
    expect(checked.ok && checked.value.capabilities?.proxyReady).toBe(true);
    expect(checked.ok && checked.value.capabilities?.licenseValid).toBe(true);
    expect(checked.ok && checked.value.members.length).toBe(0);
    const config = z.object({ storage: z.literal('windows-dpapi-v1'), encrypted: z.string() }).strict().parse(JSON.parse(await readFile(join(directory, 'lepao/config.json'), 'utf8')));
    expect(config.encrypted.length).toBeGreaterThan(0);
    await application.page.getByTestId('lepao-privacy').locator('summary').click();
    await expect(application.page.getByTestId('lepao-privacy')).toContainText('Windows 当前用户加密');
    await application.page.setViewportSize({ width: 760, height: 900 });
    expect(await application.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await application.page.screenshot({ path: resolve('work/merged-lepao.png'), fullPage: true });
    await application.page.getByTestId('nav-settings').click();
    await expect(application.page.getByTestId('lepao-about')).toContainText('https://github.com/dan-cun/lepao3');
    expect(errors).toEqual([]);
  } finally {
    const current = await application.page.evaluate(() => window.lepao.execute({ command: 'state' }));
    if (current.ok && current.value.busy) {
      await application.page.evaluate(() => window.lepao.execute({ command: 'stop' }));
      await expect.poll(async () => {
        const result = await application.page.evaluate(() => window.lepao.execute({ command: 'state' }));
        return result.ok && !result.value.busy;
      }, { timeout: 40_000 }).toBe(true);
    }
    await stop(application);
  }
});

test('Lepao members survive encrypted restart and cleanup removes owned capture files without deleting other files', async () => {
  const directory = resolve('work', `lepao-lifecycle-${randomUUID()}`);
  let application = await start(directory, executable);
  const member = `local_${randomUUID().slice(0, 12)}`;
  try {
    await application.page.getByTestId('nav-lepao').click();
    await expect(application.page.getByTestId('lepao-add')).toBeEnabled({ timeout: 30_000 });
    await application.page.getByTestId('lepao-name').fill('本机生命周期验证');
    await application.page.getByTestId('lepao-student').fill(member);
    await application.page.getByTestId('lepao-add').click();
    await expect(application.page.getByTestId('lepao-member')).toHaveValue(member);
    await expect(application.page.getByTestId('lepao-session-state')).toContainText('未保存会话');

    await expect(application.page.getByTestId('lepao-proxy-consent')).not.toBeChecked();
    const denied = await application.page.evaluate(async member => {
      const results: boolean[] = [];
      for (const command of ['capture', 'run']) {
        for (const body of [{ command, member }, { command, member, allowSystemProxy: false }]) {
          const response = await fetch('/api/lepao', { method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-SWU-Request': '1' }, body: JSON.stringify(body) });
          const result = await response.json();
          results.push(result.ok === false);
        }
      }
      return results;
    }, member);
    expect(denied).toEqual([true, true, true, true]);
    const idle = await application.page.evaluate(() => window.lepao.execute({ command: 'state' }));
    expect(idle.ok && !idle.value.busy && !idle.value.proxyRecoveryNeeded).toBe(true);
    await application.page.getByTestId('lepao-proxy-consent').check();

    const encrypted = await readFile(join(directory, 'lepao/config.json'), 'utf8');
    expect(encrypted).not.toContain(member);
    await stop(application);
    application = await start(directory, executable);
    await application.page.getByTestId('nav-lepao').click();
    await expect(application.page.getByTestId('lepao-member')).toHaveValue(member, { timeout: 30_000 });
    await expect(application.page.getByTestId('lepao-proxy-consent')).not.toBeChecked();
    await mkdir(join(directory, 'lepao/flows'), { recursive: true });
    await writeFile(join(directory, 'lepao/flows/capture.mitm'), randomUUID(), 'utf8');
    await writeFile(join(directory, 'lepao/keep-user-note.txt'), 'Keep this unrelated user file.', 'utf8');
    await application.page.getByTestId('lepao-privacy').locator('summary').click();
    await expect(application.page.getByTestId('lepao-raw-files')).toContainText('1 个');
    await application.page.getByTestId('lepao-cleanup').click();
    await expect(application.page.getByTestId('lepao-raw-files')).toContainText('0 个');
    expect(await readFile(join(directory, 'lepao/keep-user-note.txt'), 'utf8')).toBe('Keep this unrelated user file.');
    await application.page.getByTestId('lepao-forget').click();
    await expect(application.page.getByTestId('lepao-forget')).toBeEnabled();
    await expect(application.page.getByTestId('lepao-member')).toHaveValue(member);
    const beforeRemoval = await readFile(join(directory, 'lepao/config.json'), 'utf8');
    await application.page.getByTestId('lepao-remove').click();
    await expect(application.page.getByTestId('lepao-remove-confirmation')).toBeVisible();
    await expect(application.page.getByTestId('lepao-remove-cancel')).toBeFocused();
    await application.page.getByTestId('lepao-remove-cancel').click();
    await expect(application.page.getByTestId('lepao-remove-confirmation')).toHaveCount(0);
    expect(await readFile(join(directory, 'lepao/config.json'), 'utf8')).toBe(beforeRemoval);
    await expect(application.page.getByTestId('lepao-member')).toHaveValue(member);
    await application.page.getByTestId('lepao-remove').click();
    await application.page.getByTestId('lepao-remove-confirm').click();
    await expect(application.page.getByTestId('lepao-member')).toHaveValue('');
    await expect(application.page.getByTestId('lepao-forget')).toBeDisabled();
  } finally {
    await stop(application);
  }
});

test('Lepao onboarding advances from real member registration to environment preparation and explains unavailable actions', async () => {
  const application = await start(resolve('work', `lepao-guide-${randomUUID()}`), executable);
  try {
    const page = application.page;
    await page.getByTestId('nav-lepao').click();
    await expect(page.getByTestId('lepao-add')).toBeEnabled({ timeout: 30_000 });
    await expect(page.getByTestId('lepao-guide-step-1')).toHaveAttribute('aria-current', 'step');
    await expect(page.getByTestId('lepao-capture')).toBeDisabled();
    await expect(page.getByTestId('lepao-dry')).toBeDisabled();
    await expect(page.getByTestId('lepao-certificate')).toBeDisabled();
    await expect(page.getByTestId('lepao-full-run')).not.toHaveAttribute('open');
    await page.screenshot({ path: resolve('work/lepao-guide-start.png') });
    await expect(page.locator('#lepao-members')).toBeVisible();
    await expect(page.locator('.lepao-step-section:not([hidden])')).toHaveCount(1);
    await expect(page.getByTestId('lepao-privacy')).not.toHaveAttribute('open');
    await expect(page.getByTestId('lepao-log-panel')).not.toHaveAttribute('open');
    await page.getByTestId('lepao-name').fill('引导流程本机验证');
    await page.getByTestId('lepao-student').fill(`local_${randomUUID().slice(0, 12)}`);
    await page.getByTestId('lepao-add').click();
    await expect(page.getByTestId('lepao-guide-step-2')).toHaveAttribute('aria-current', 'step');
    await expect(page.getByTestId('lepao-guide-step-1')).toHaveClass('completed');
    await expect(page.getByTestId('lepao-member-hint')).toContainText('已选择');
    await expect(page.locator('#lepao-members')).toBeHidden();
    await expect(page.locator('#lepao-environment')).toBeFocused();
    await page.getByTestId('lepao-check').click();
    await expect(page.getByTestId('lepao-result')).toContainText('环境检查完成', { timeout: 40_000 });
    await expect(page.getByTestId('lepao-phase')).toHaveText('空闲');
    await expect(page.getByTestId('lepao-capture-reason')).not.toBeEmpty();
    await expect(page.getByTestId('lepao-dry')).toBeDisabled();
    await page.getByTestId('lepao-certificate-help').locator('summary').click();
    await expect(page.getByTestId('lepao-certificate-help')).toHaveAttribute('open', '');
    await page.getByTestId('lepao-guide-step-4').locator('button').click();
    await expect(page.locator('.lepao-step-section:not([hidden])')).toHaveCount(1);
    await expect(page.locator('#lepao-environment')).toBeHidden();
    await page.getByTestId('lepao-full-run').locator('summary').click();
    await expect(page.getByTestId('lepao-run')).toBeVisible();
    await expect(page.getByTestId('lepao-run')).toBeDisabled();
    await page.getByTestId('lepao-next-action').click();
    await expect(page.locator('#lepao-environment')).toBeVisible();
    await page.setViewportSize({ width: 760, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: resolve('work/lepao-guide-narrow.png'), fullPage: true });
  } finally {
    const current = await application.page.evaluate(() => window.lepao.execute({ command: 'state' }));
    if (current.ok && current.value.busy) {
      await application.page.evaluate(() => window.lepao.execute({ command: 'stop' }));
      await expect.poll(async () => {
        const result = await application.page.evaluate(() => window.lepao.execute({ command: 'state' }));
        return result.ok && !result.value.busy;
      }, { timeout: 40_000 }).toBe(true);
    }
    await stop(application);
  }
});

test('A real local Lepao operation is attributed to its target and switching members does not inherit its result', async () => {
  const application = await start(resolve('work', `lepao-target-${randomUUID()}`), executable);
  try {
    const page = application.page;
    await page.getByTestId('nav-lepao').click();
    await expect(page.getByTestId('lepao-add')).toBeEnabled({ timeout: 30_000 });
    const members = [`local_${randomUUID().slice(0, 12)}`, `local_${randomUUID().slice(0, 12)}`];
    for (const [index, member] of members.entries()) {
      await page.getByTestId('lepao-guide-step-1').locator('button').click();
      await page.getByTestId('lepao-name').fill(`本地结果归属 ${index + 1}`);
      await page.getByTestId('lepao-student').fill(member);
      await page.getByTestId('lepao-add').click();
      await expect(page.getByTestId('lepao-add')).toBeEnabled();
    }
    const target = members[0];
    const other = members[1];
    if (target === undefined || other === undefined) throw new Error('Local member registration failed.');
    const started = await page.evaluate(member => window.lepao.execute({ command: 'dry', member }), target);
    expect(started.ok && started.value.operation?.member).toBe(target);
    await expect.poll(async () => {
      const result = await page.evaluate(() => window.lepao.execute({ command: 'state' }));
      return result.ok && !result.value.busy;
    }, { timeout: 40_000 }).toBe(true);
    const finished = await page.evaluate(() => window.lepao.execute({ command: 'state' }));
    expect(finished.ok && finished.value.operation?.member).toBe(target);
    expect(finished.ok && ['failed', 'needs-session'].includes(finished.value.operation?.status ?? '')).toBe(true);
    expect(finished.ok && finished.value.proxyRecoveryNeeded).toBe(false);
    await expect(page.getByTestId('lepao-result-context')).toContainText('本地结果归属 1');
    await page.getByTestId('lepao-member').selectOption(other);
    await expect(page.getByTestId('lepao-result-context')).toHaveCount(0);
    await expect(page.getByTestId('lepao-result')).toContainText('当前成员尚无本次运行结果');
    await page.getByTestId('lepao-member').selectOption(target);
    await expect(page.getByTestId('lepao-result-context')).toContainText('本地结果归属 1');
  } finally {
    await stop(application);
  }
});


test('Switching both real editions preserves preferences and exposes the selected edition', async () => {
  test.setTimeout(90_000);
  const other = process.env['SWU_OTHER_EDITION_EXE'];
  test.skip(other === undefined, 'Requires both compiled edition executables.');
  if (other === undefined) throw new Error('The other edition executable was not provided.');
  const root = resolve('work');
  const directory = resolve(root, `edition-switch-${randomUUID()}`);
  let application: Awaited<ReturnType<typeof start>> | null = null;
  try {
    for (const [index, binary] of [executable, other, executable].entries()) {
      application = await start(directory, binary);
      const expected = index === 1 ? releaseEdition === 'academic' ? 'basic' : 'academic' : releaseEdition;
      await expect(application.page.getByTestId('release-edition')).toHaveText(expected === 'academic' ? '含教务版' : '基础版');
      const instance = instanceSchema.parse(JSON.parse(await readFile(join(directory, 'instance.json'), 'utf8')));
      const response = await application.page.context().request.get(`${application.origin}/api/instance`, { headers: { 'X-SWU-Instance': instance.launchKey } });
      expect(z.object({ edition: z.enum(['academic', 'basic']) }).parse(await response.json()).edition).toBe(expected);
      if (expected === 'basic') {
        await expect(application.page.getByTestId('nav-academic')).toHaveCount(0);
        expect(await application.page.evaluate(() => 'academic' in window)).toBe(false);
        const removed = await application.page.context().request.post(`${application.origin}/api/academic`, {headers: {Origin: application.origin,'Content-Type':'application/json','X-SWU-Request':'1'},data:{command:'state'}});
        expect(removed.status()).toBe(404);
      } else await expect(application.page.getByTestId('nav-academic')).toBeVisible();
      const state = await application.page.evaluate(() => window.desktop.getState());
      if (!state.ok) throw new Error('Could not read the selected edition state.');
      expect(state.value.version).toBe(expected === 'academic' ? '1.0.0-beta' : '1.0.0-alpha');
      if (index === 0) {
        const saved = await application.page.evaluate(settings => window.desktop.saveSettings({...settings,autoLogin:false,scheduleEnabled:false,launchAtLogin:false,scheduleTime:'21:17'}), state.value.settings);
        expect(saved.ok).toBe(true);
      } else {
        expect(state.value.settings.scheduleTime).toBe('21:17');
        expect(state.value.settings.autoLogin).toBe(false);
      }
      await stop(application);
      application = null;
    }
    await writeFile(resolve('work/edition-switch-result.json'), JSON.stringify({version:packageMetadata.version,bothEditionsStarted:true,preferencesPreserved:true,basicAcademicRouteAbsent:true,returnedToOriginalEdition:true,timestamp:new Date().toISOString()}), 'utf8');
  } finally {
    if (application) await stop(application);
    if (!directory.startsWith(root + '\\')) throw new Error('Edition test cleanup is outside the workspace.');
    await rm(directory, {recursive:true,force:true,maxRetries:5,retryDelay:200});
  }
});

