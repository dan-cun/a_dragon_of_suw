import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, writeFile, unlink, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { shiftCalendarDate } from '../../desktop/renderer/heatmap-model';
import { getShanghaiClock } from '../../desktop/core/time';
import { hasRunningInstance } from '../../desktop/bun/instance';
import { readStore, writeStore } from '../../desktop/bun/store';
import { freshSchedule } from '../../desktop/bun/scheduler';
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

test('Campus services show real disconnected state and protect read-only operations', async () => {
  const directory = resolve('work', `campus-${randomUUID()}`);
  const application = await start(directory, executable);
  try {
    const errors: string[] = [];
    application.page.on('pageerror', error => errors.push(error.message));
    await application.page.getByTestId('nav-academic').click();
    await expect(application.page.getByTestId('campus-services')).toBeVisible();
    await expect(application.page.getByTestId('academic-status')).toHaveText('尚未连接');
    await expect(application.page.getByTestId('academic-connect')).toBeDisabled();
    await expect(application.page.getByTestId('academic-refresh')).toBeDisabled();
    await application.page.getByTestId('academic-guide').click();
    for (const section of ['grades', 'exams', 'timetable']) {
      await application.page.getByTestId(`academic-tab-${section}`).click();
      await expect(application.page.getByTestId(`academic-tab-${section}`)).toHaveAttribute('aria-selected', 'true');
      await expect(application.page.getByTestId('academic-empty')).toBeVisible();
    }
    const state = await application.page.evaluate(() => window.academic.execute({ command: 'state' }));
    expect(state.ok).toBe(true);
    if (!state.ok) throw new Error(state.error.message);
    expect(state.value.account).toBeNull();
    expect(state.value.datasets).toEqual([]);
    const rejected = await application.page.evaluate(() => window.academic.execute({ command: 'connect' }));
    expect(rejected.ok).toBe(false);
    const injection = await application.page.context().request.post(`${application.origin}/api/academic`, {
      headers: { Origin: application.origin, 'Content-Type': 'application/json', 'X-SWU-Request': '1' },
      data: { command: 'state', url: 'https://example.com/' },
    });
    expect((await injection.json()).ok).toBe(false);
    await application.page.screenshot({ path: resolve('work/campus-services.png'), fullPage: true });
    await application.page.setViewportSize({ width: 760, height: 900 });
    expect(await application.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally { await stop(application); }
});


test.use({ screenshot: process.env['SWU_ACADEMIC_LIVE_DATA'] === undefined ? 'only-on-failure' : 'off', trace: process.env['SWU_ACADEMIC_LIVE_DATA'] === undefined ? 'retain-on-failure' : 'off' });
test.describe('Authorized real academic desktop integration', () => {
  test('Campus live SSO reads actual timetable, grades and exams and clears data on logout', async () => {
    test.setTimeout(360_000);
    const source = process.env['SWU_ACADEMIC_LIVE_DATA'];
    test.skip(source === undefined, 'Requires explicitly provided local account data and normal school SSO.');
    if (source === undefined) throw new Error('Live school account data directory was not provided.');
    const work = resolve('work');
    const directory = resolve(work, `academic-live-${randomUUID()}`);
    const saved = readStore(source);
    if (saved.session === null) throw new Error('Live school session was not found.');
    let application: Awaited<ReturnType<typeof start>> | null = null;
    try {
      writeStore(directory, { ...saved, settings: { ...saved.settings, autoLogin: false, scheduleEnabled: false, launchAtLogin: false }, schedule: freshSchedule(), history: [], logs: [], submissions: [], legacyHold: null, lastScheduledDate: null }, saved.session);
      const writer = spawn('D:/Code/bun/bun.exe', ['-e', "import { readLoginMemory, writeLoginMemory } from './desktop/bun/login-memory.ts'; import {readStore} from './desktop/bun/store.ts'; const memory = await readLoginMemory(process.argv[1]); if (!memory || memory.username !== readStore(process.argv[1]).session?.username) throw new Error('Matching saved school credentials were not found.'); await writeLoginMemory(process.argv[2], {...memory,cookies:[]});", source, directory], { windowsHide: true, stdio: 'ignore' });
      await expect.poll(() => writer.exitCode, { timeout: 15_000 }).toBe(0);
      application = await start(directory, executable);
      const page = application.page;
      await page.getByTestId('nav-academic').click();
      await expect(page.getByTestId('academic-connect')).toBeEnabled();
      await page.getByTestId('academic-connect').click();
      await expect(page.getByTestId('academic-connect')).toBeDisabled();
      let announced = false;
      await expect.poll(async () => {
        if (await page.getByTestId('academic-error').isVisible()) {
          throw new Error(await page.getByTestId('academic-error').innerText());
        }
        if (await page.getByTestId('academic-status').innerText() === '学号已核验') return true;
        if (await page.getByTestId('academic-check').count() === 1 && await page.getByTestId('academic-check').isEnabled()) {
          if (!announced) { console.log(JSON.stringify({ event: 'academic.live-login.waiting', action: 'Complete official school login in the dedicated window.' })); announced = true; }
          await page.getByTestId('academic-check').click();
        }
        return false;
      }, { timeout: 240_000, intervals: [3000] }).toBe(true);
      const connection = await page.evaluate(() => window.academic.execute({ command: 'state' }));
      if (!connection.ok || !connection.value.selected) throw new Error('Normal school SSO did not provide an academic semester.');
      expect(connection.value.account === saved.session.username).toBe(true);
      const current = connection.value.selected;
      const previous = connection.value.semesters.find(item => item.year === String(Number(current.year) - 1) && item.term === '12');
      if (!previous) throw new Error('The official previous spring semester was not returned.');
      const counts: Record<string, number> = {};
      for (const section of ['timetable', 'grades', 'exams'] as const) {
        await page.getByTestId(`academic-tab-${section}`).click();
        const semester = section === 'timetable' ? current : previous;
        await page.getByTestId('academic-semester').selectOption(`${semester.year}:${semester.term}`);
        await page.getByTestId('academic-refresh').click();
        await expect(page.getByTestId('academic-updated')).toBeVisible({ timeout: 40_000 });
        const result = await page.evaluate(() => window.academic.execute({ command: 'state' }));
        if (!result.ok) throw new Error('Academic local state could not be read.');
        const dataset = result.value.datasets.find(item => item.section === section);
        if (!dataset) throw new Error('The requested academic dataset was not returned.');
        expect(dataset.semester.year === semester.year && dataset.semester.term === semester.term).toBe(true);
        expect(dataset.records.length).toBeGreaterThan(0);
        if (section === 'grades') expect(dataset.records.some(item => item.score.length > 0)).toBe(true);
        if (section === 'exams') expect(dataset.records.some(item => item.timing.length > 0)).toBe(true);
        await expect(page.getByTestId('academic-table').locator('tbody tr')).toHaveCount(dataset.records.length);
        counts[section] = dataset.records.length;
        await page.getByTestId('academic-search').fill('__no_course_should_match__');
        await expect(page.getByTestId('academic-no-match')).toBeVisible();
        await page.getByTestId('academic-search').fill('');
      }
      await page.setViewportSize({ width: 760, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const mainState = await page.evaluate(() => window.desktop.getState());
      if (!mainState.ok) throw new Error('Application state could not be read after academic queries.');
      expect(mainState.value.version).toBe('1.0.0-beta');
      expect(mainState.value.logs.every(entry => entry.request === undefined)).toBe(true);
      const logout = await page.evaluate(() => window.desktop.logout());
      expect(logout.ok).toBe(true);
      await expect(page.getByTestId('academic-connect')).toBeDisabled();
      const cleared = await page.evaluate(() => window.academic.execute({ command: 'state' }));
      if (!cleared.ok) throw new Error('Academic logout state could not be read.');
      expect(cleared.value.account === null && cleared.value.datasets.length === 0).toBe(true);
      expect((await readStore(directory)).session === null).toBe(true);
      await writeFile(resolve('work/academic-live-result.json'), JSON.stringify({ version: mainState.value.version, normalSso: true, savedCookiesClearedBeforeLogin: true, counts, renderedRowsMatched: true, search: true, logoutCleared: true, onlyAcademicRequests: true, timestamp: new Date().toISOString() }), 'utf8');
    } finally {
      try { if (application) await stop(application); }
      finally {
        if (!directory.startsWith(work + '\\')) throw new Error('Live academic test cleanup is outside the workspace.');
        await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    }
  });
});


test('Campus live without saved credentials keeps queries gated until official login', async () => {
  test.setTimeout(90_000);
  const source = process.env['SWU_ACADEMIC_LIVE_DATA'];
  test.skip(source === undefined, 'Requires explicitly provided local account data.');
  if (source === undefined) throw new Error('Live account data directory was not provided.');
  const work = resolve('work');
  const directory = resolve(work, `academic-live-${randomUUID()}`);
  const saved = readStore(source);
  if (saved.session === null) throw new Error('Live account session was not found.');
  let application: Awaited<ReturnType<typeof start>> | null = null;
  try {
    writeStore(directory, { ...saved, settings: { ...saved.settings, autoLogin: false, scheduleEnabled: false, launchAtLogin: false }, schedule: freshSchedule(), history: [], logs: [], submissions: [], legacyHold: null, lastScheduledDate: null }, saved.session);
    application = await start(directory, executable);
    const page = application.page;
    await page.getByTestId('nav-academic').click();
    await expect(page.getByTestId('academic-connect')).toBeEnabled();
    await page.getByTestId('academic-connect').click();
    await expect.poll(async () => {
      if (await page.getByTestId('academic-error').isVisible()) throw new Error(await page.getByTestId('academic-error').innerText());
      if (await page.getByTestId('academic-status').innerText() === '学号已核验') return 'ready';
      if (await page.getByTestId('academic-check').count() === 1 && await page.getByTestId('academic-check').isEnabled()) return 'gated';
      return 'pending';
    }, { timeout: 45_000 }).not.toBe('pending');
    test.skip(await page.getByTestId('academic-status').innerText() === '学号已核验', 'The valid school session did not require credential entry.');
    await expect(page.getByTestId('academic-status')).toHaveText('等待学校登录');
    await expect(page.getByTestId('academic-refresh')).toBeDisabled();
    const result = await page.evaluate(() => window.academic.execute({ command: 'state' }));
    if (!result.ok) throw new Error('Academic connection state could not be read.');
    expect(result.value.datasets.length === 0 && result.value.account === saved.session.username).toBe(true);
    await writeFile(resolve('work/academic-login-stage-result.json'), JSON.stringify({ verificationRequired: true, savedCredentialsAbsent: true, readsGated: true, timestamp: new Date().toISOString() }), 'utf8');
  } finally {
    try { if (application) await stop(application); }
    finally {
      if (!directory.startsWith(work + '\\')) throw new Error('Live test cleanup is outside the workspace.');
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
});


test('Compiled EXE integrates OCS source management, isolated browsers and private persistence in the main UI', async () => {
  test.setTimeout(240_000);
  const { ocsStateSchema } = await import('../../desktop/shared/ocs');
  const { stat } = await import('node:fs/promises');
  const work = resolve('work');
  const directory = resolve(work, `ocs-source-${randomUUID()}`);
  const sourceDirectory = join(directory, 'ocs', 'source-integration');
  const secret = randomUUID();
  const errors: string[] = [];
  let application = await start(directory, executable);
  async function state(page: Page): Promise<z.infer<typeof ocsStateSchema>> {
    const result = await page.evaluate(() => window.ocs.execute({ command: 'state' }));
    if (!result.ok) throw new Error(`OCS state failed: ${result.error.code}: ${result.error.message}`);
    return ocsStateSchema.parse(result.value);
  }
  async function browserPids(profiles: string[]): Promise<number[]> {
    if (profiles.length === 0 || profiles.some(profile => !profile.startsWith(sourceDirectory + '\\profiles\\'))) throw new Error('Process inspection is outside this isolated OCS profile directory.');
    const browserExecutable = resolve(executable, '..', 'modules', 'ocs', 'browser', 'chrome.exe');
    // Chromium children can repeat the profile argument; only the bundled browser root has no --type switch.
    const script = "$ErrorActionPreference='Stop';$query=[Console]::In.ReadToEnd()|ConvertFrom-Json;$profiles=@($query.profiles);ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object {$line=$_.CommandLine; $line -and $line -notmatch '(^|\\s)--type(?:=|\\s|$)' -and [string]::Equals($_.ExecutablePath,$query.browserExecutable,[StringComparison]::OrdinalIgnoreCase) -and @($profiles | Where-Object {$line.Contains($_,[StringComparison]::OrdinalIgnoreCase)}).Count -gt 0} | ForEach-Object {[int]$_.ProcessId}) -Compress";
    const child = spawn('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    return await new Promise<number[]>((accept, reject) => {
      let output = '';
      let diagnostics = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { output += chunk; });
      child.stderr.on('data', (chunk: string) => { diagnostics += chunk; });
      child.once('error', reject);
      child.stdin.on('error', reject);
      child.once('close', code => {
        if (code !== 0) { reject(new Error(`Isolated OCS process inspection failed (${String(code)}): ${diagnostics.slice(0, 500)}`)); return; }
        try { accept(z.array(z.number().int().positive()).parse(JSON.parse(output))); }
        catch (cause) { reject(new Error('Isolated OCS process inspection returned invalid PID data.', { cause })); }
      });
      child.stdin.end(JSON.stringify({ profiles, browserExecutable }));
    });
  }
  async function waitForPhase(page: Page, id: string, phase: string): Promise<void> {
    await expect.poll(async () => {
      if (await page.getByTestId('ocs-error').isVisible()) throw new Error(await page.getByTestId('ocs-error').innerText());
      return page.getByTestId(`ocs-browser-phase-${id}`).innerText();
    }, { timeout: 60_000 }).toBe(phase);
  }
  const pendingOcsRequests = new Set<import('@playwright/test').Request>();
  const shutdownAttempts = new Set<ChildProcess>();
  function trackOcsRequests(page: Page): void {
    const endpoint = new URL('/api/ocs', page.url()).href;
    page.on('request', request => { if (request.url() === endpoint) pendingOcsRequests.add(request); });
    page.on('requestfinished', request => { pendingOcsRequests.delete(request); });
    page.on('requestfailed', request => { pendingOcsRequests.delete(request); });
  }
  async function stopOcsApplication(current: Awaited<ReturnType<typeof start>>): Promise<void> {
    if (shutdownAttempts.has(current.process)) throw new Error('Normal OCS test shutdown was already attempted; refusing to retry it.');
    await current.page.getByTestId('nav-history').click();
    await expect(current.page.getByTestId('ocs-page')).toHaveCount(0);
    // Unmount cancels future polling; let already-issued requests finish without retrying mutations.
    await expect.poll(() => pendingOcsRequests.size, { timeout: 30_000, message: 'OCS requests must finish before normal shutdown.' }).toBe(0);
    shutdownAttempts.add(current.process);
    await stop(current);
  }
  let bodyFailure: Error | null = null;
  try {
    let page = application.page;
    trackOcsRequests(page);
    page.on('pageerror', error => errors.push(error.message));
    await page.getByTestId('nav-ocs').click();
    await expect(page.getByTestId('ocs-phase')).toHaveText('源码服务就绪');
    await expect(page.getByTestId('ocs-browser-empty')).toBeVisible();
    await expect(page.getByTestId('ocs-page').locator('iframe')).toHaveCount(0);
    const initial = await state(page);
    expect(initial.integration).toBe('source');
    expect(initial.version).toBe('2.12.0');
    expect(initial.dataDirectory).toBe(sourceDirectory);
    expect(initial.browsers).toHaveLength(0);
    expect(initial.userScripts).toHaveLength(0);
    expect(initial.extensions).toHaveLength(0);
    const ids: string[] = [];
    for (const name of ['OCS local blank A', 'OCS local blank B']) {
      await page.getByTestId('ocs-browser-new').click();
      await page.getByTestId('ocs-browser-name').fill(name);
      await page.getByTestId('ocs-browser-folder').fill('Isolated desktop validation');
      await page.getByTestId('ocs-browser-url').fill('about:blank');
      await page.getByTestId('ocs-browser-tags').fill('local-only, no-course');
      await page.getByTestId('ocs-browser-notes').fill('Local browser validation only; no course execution or completion.');
      await page.getByTestId('ocs-browser-create').click();
      await expect(page.getByTestId('ocs-browser-editor')).toHaveCount(0);
      const created = (await state(page)).browsers.find(browser => browser.name === name);
      if (!created) throw new Error('The OCS browser created through the UI was not persisted.');
      ids.push(created.id);
      await expect(page.getByTestId(`ocs-browser-row-${created.id}`)).toBeVisible();
      expect(created.startUrl).toBe('about:blank');
      expect(created.tags).toEqual(['local-only', 'no-course']);
    }
    const firstId = z.string().uuid().parse(ids[0]);
    const secondId = z.string().uuid().parse(ids[1]);
    expect(firstId).not.toBe(secondId);
    const profiles = [firstId, secondId].map(id => join(sourceDirectory, 'profiles', id));
    await page.getByTestId(`ocs-browser-edit-${secondId}`).click();
    await expect(page.getByTestId('ocs-browser-name')).toHaveValue('OCS local blank B');
    await expect(page.getByTestId('ocs-browser-url')).toHaveValue('about:blank');
    await page.getByTestId('ocs-browser-name').fill('OCS local blank B edited');
    await page.getByTestId('ocs-browser-folder').fill('Edited local folder');
    await page.getByTestId('ocs-browser-tags').fill('edited, local-only');
    await page.getByTestId('ocs-browser-notes').fill('Edited metadata, never a course result.');
    await page.getByTestId('ocs-browser-save').click();
    await expect(page.getByTestId('ocs-browser-editor')).toHaveCount(0);
    expect((await state(page)).browsers.find(browser => browser.id === secondId)).toMatchObject({ name: 'OCS local blank B edited', folder: 'Edited local folder', tags: ['edited', 'local-only'], notes: 'Edited metadata, never a course result.', startUrl: 'about:blank' });
    for (const id of ids) {
      await page.getByTestId(`ocs-browser-start-${id}`).click();
      await waitForPhase(page, id, '运行中');
      await expect(page.getByTestId(`ocs-browser-delete-${id}`)).toBeDisabled();
    }
    expect((await state(page)).browsers.filter(browser => browser.phase === 'running' && browser.owned)).toHaveLength(2);
    const firstPids = await browserPids([profiles[0]!]);
    const secondPids = await browserPids([profiles[1]!]);
    expect(firstPids).toHaveLength(1);
    expect(secondPids).toHaveLength(1);
    expect(firstPids[0]).not.toBe(secondPids[0]);
    for (const profile of profiles) expect((await stat(profile)).isDirectory()).toBe(true);
    await page.getByTestId(`ocs-browser-focus-${firstId}`).click();
    await expect.poll(async () => (await state(page)).logs.some(log => log.browserId === firstId && log.event === 'browser.focused')).toBe(true);
    await page.getByTestId(`ocs-browser-select-${firstId}`).click();
    await page.getByTestId('ocs-browser-preview').click();
    const image = page.getByTestId('ocs-browser-preview-result').locator('img');
    await expect(image).toBeVisible();
    await expect(image).toHaveAttribute('src', /^data:image\/png;base64,/);
    await expect.poll(() => image.evaluate(element => element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0 && element.naturalHeight > 0)).toBe(true);
    expect((await state(page)).preview?.browserId).toBe(firstId);
    await page.setViewportSize({ width: 760, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: join(directory, 'ocs-source-preview-760.png'), fullPage: true });
    await page.getByTestId('nav-history').click();
    await expect(page.getByTestId('ocs-page')).toHaveCount(0);
    await page.getByTestId('nav-ocs').click();
    for (const id of ids) await waitForPhase(page, id, '运行中');
    expect(await browserPids([profiles[0]!])).toEqual(firstPids);
    expect(await browserPids([profiles[1]!])).toEqual(secondPids);
    expect(page.context().pages()).toHaveLength(1);
    await page.getByTestId(`ocs-browser-stop-${firstId}`).click();
    await waitForPhase(page, firstId, '未运行');
    expect((await state(page)).browsers.find(browser => browser.id === firstId)?.owned).toBe(false);
    expect((await state(page)).browsers.find(browser => browser.id === secondId)?.owned).toBe(true);
    await expect.poll(() => browserPids([profiles[0]!]), { timeout: 15_000 }).toEqual([]);
    expect(await browserPids([profiles[1]!])).toEqual(secondPids);
    await page.getByTestId('ocs-browsers-stop').click();
    await expect(page.getByTestId('ocs-confirm-dialog')).toBeVisible();
    await page.getByTestId('ocs-confirm-submit').click();
    await expect(page.getByTestId('ocs-confirm-dialog')).toHaveCount(0);
    for (const id of ids) await waitForPhase(page, id, '未运行');
    expect((await state(page)).browsers.every(browser => !browser.owned)).toBe(true);
    await expect.poll(() => browserPids(profiles), { timeout: 15_000 }).toEqual([]);
    await expect(page.getByTestId('ocs-browsers-stop')).toBeDisabled();

    await page.getByTestId('ocs-tab-scripts').click();
    const invalidScript = join(directory, 'invalid.user.js');
    await writeFile(invalidScript, 'void 0;', 'utf8');
    await page.getByTestId('ocs-script-file').setInputFiles(invalidScript);
    await expect(page.getByTestId('ocs-error')).toContainText('UserScript');
    await expect(page.getByTestId('ocs-error')).toContainText('script-import');
    expect((await state(page)).userScripts).toHaveLength(0);
    await expect(page.getByTestId('ocs-script-file')).toBeDisabled();
    await page.getByTestId('ocs-refresh').click();
    await expect(page.getByTestId('ocs-error')).toHaveCount(0);
    await page.getByTestId('ocs-script-url').fill('http://127.0.0.1/not-requested.user.js');
    await page.getByTestId('ocs-script-download').click();
    await expect(page.getByTestId('ocs-resource-error')).toContainText('HTTPS');
    const scriptFile = join(directory, 'local-only.user.js');
    await writeFile(scriptFile, '// ==UserScript==\n// @name Local-only desktop validation\n// @version 1.0.0\n// @include about:blank\n// @grant none\n// ==/UserScript==\nvoid 0;\n', 'utf8');
    await page.getByTestId('ocs-script-file').setInputFiles(scriptFile);
    await expect.poll(async () => (await state(page)).userScripts.length).toBe(1);
    const importedScript = (await state(page)).userScripts[0];
    if (!importedScript) throw new Error('The real local user script was not imported.');
    await expect(page.getByTestId(`ocs-script-${importedScript.id}`)).toBeVisible();
    await page.getByTestId(`ocs-script-enable-${importedScript.id}`).uncheck();
    await expect.poll(async () => (await state(page)).userScripts[0]?.enabled).toBe(false);
    await page.getByTestId(`ocs-script-delete-${importedScript.id}`).click();
    await page.getByTestId('ocs-confirm-delete').click();
    await expect(page.getByTestId(`ocs-script-${importedScript.id}`)).toHaveCount(0);
    await page.getByTestId('ocs-tab-extensions').click();
    const invalidExtension = join(directory, 'invalid-extension');
    await mkdir(invalidExtension);
    await writeFile(join(invalidExtension, 'manifest.json'), JSON.stringify({ manifest_version: 2, name: 'Rejected local extension', version: '1.0.0' }), 'utf8');
    await page.getByTestId('ocs-extension-directory').fill(invalidExtension);
    await page.getByTestId('ocs-extension-import').click();
    await expect(page.getByTestId('ocs-error')).toContainText('extension-import');
    await expect(page.getByTestId('ocs-error')).toContainText('manifest_version');
    expect((await state(page)).extensions).toHaveLength(0);
    await page.getByTestId('ocs-refresh').click();
    await expect(page.getByTestId('ocs-error')).toHaveCount(0);
    await expect(page.getByTestId('ocs-extension-import')).toBeEnabled();

    await page.getByTestId('ocs-tab-capabilities').click();
    const capabilities = (await state(page)).capabilities;
    for (const capability of capabilities) {
      await expect(page.getByTestId(`ocs-capability-${capability.id}`)).toContainText(capability.available ? '已提供' : '未提供');
      await expect(page.getByTestId(`ocs-capability-${capability.id}`)).toContainText(capability.detail);
    }
    for (const id of ['automatic-login', 'config-sync']) {
      expect(capabilities.find(capability => capability.id === id)?.available).toBe(true);
    }
    for (const id of ['gm-runtime', 'ocr', 'live-video', 'course-results', 'force-script-update']) {
      expect(capabilities.find(capability => capability.id === id)?.available).toBe(false);
    }
    await page.getByTestId('ocs-tab-settings').click();
    const settingsBeforeInvalidJson = (await state(page)).settings;
    const configurationPath = join(sourceDirectory, 'configuration.dpapi.json');
    const configurationBeforeInvalidJson = await readFile(configurationPath);
    await page.getByTestId('ocs-settings-json').fill('[]');
    await page.getByTestId('ocs-settings-save').click();
    await expect(page.getByTestId('ocs-settings-error')).toContainText('仅含 JSON 值的对象');
    await expect(page.getByTestId('ocs-settings-saved')).toHaveCount(0);
    await expect(page.getByTestId('ocs-settings-json')).toHaveValue('[]');
    expect((await state(page)).settings).toEqual(settingsBeforeInvalidJson);
    expect((await readFile(configurationPath)).equals(configurationBeforeInvalidJson)).toBe(true);
    // The UI rejects this draft before sending it; verify the real backend rejects it without writing too.
    const rejectedSettings = await page.evaluate(settings => window.ocs.execute({
      command: 'settings-save', settings: { ...settings, globalConfigJson: '[]' }
    }), settingsBeforeInvalidJson);
    expect(rejectedSettings.ok).toBe(false);
    if (rejectedSettings.ok) throw new Error('The OCS backend accepted an invalid JSON settings document.');
    expect(rejectedSettings.error.message).toBe('OCS settings-save 失败：OCS 全局配置必须是 JSON 对象。');
    expect((await state(page)).settings).toEqual(settingsBeforeInvalidJson);
    expect((await readFile(configurationPath)).equals(configurationBeforeInvalidJson)).toBe(true);
    await page.getByTestId('ocs-settings-discard').click();
    await expect(page.getByTestId('ocs-settings-json')).toHaveValue(settingsBeforeInvalidJson.globalConfigJson);
    // syncEnabled persists a preference; it does not authorize exposing private configuration to pages.
    await page.getByTestId('ocs-settings-sync').setChecked(!initial.settings.syncEnabled);
    await page.getByTestId('ocs-settings-dialogs').setChecked(!initial.settings.enableDialogs);
    await page.getByTestId('ocs-settings-force-update').uncheck();
    await page.getByTestId('ocs-settings-save').click();
    await expect(page.getByTestId('ocs-settings-saved')).toBeVisible();
    const savedSettings = (await state(page)).settings;
    expect(savedSettings).toEqual({ ...initial.settings, syncEnabled: !initial.settings.syncEnabled, enableDialogs: !initial.settings.enableDialogs, forceUpdateScripts: false });
    for (const tab of ['settings', 'scripts', 'extensions', 'logs', 'capabilities', 'browsers']) {
      await page.getByTestId(`ocs-tab-${tab}`).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    await page.getByTestId(`ocs-browser-select-${firstId}`).click();
    const automation = initial.automationCatalog.find(definition => definition.fields.some(field => field.secret));
    const privateField = automation?.fields.find(field => field.secret);
    if (!automation || !privateField) throw new Error('The upstream automation catalog has no private field to verify.');
    await page.getByTestId('ocs-automation-name').selectOption(automation.name);
    await page.getByTestId(`ocs-automation-field-${privateField.key}`).fill(secret);
    await page.getByTestId('ocs-automation-save').click();
    await expect(page.getByTestId('ocs-automation-saved')).toBeVisible();
    await expect(page.getByTestId(`ocs-automation-field-${privateField.key}`)).toHaveValue('');
    expect(JSON.stringify(await state(page)).includes(secret)).toBe(false);
    expect(await page.evaluate(value => document.documentElement.outerHTML.includes(value) || Array.from(document.querySelectorAll('input, textarea')).some(element => (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) && element.value.includes(value)), secret)).toBe(false);
    const configuration = await readFile(join(sourceDirectory, 'configuration.dpapi.json'), 'utf8');
    expect(configuration.includes(secret)).toBe(false);
    expect(z.object({ protection: z.literal('windows-current-user-dpapi'), encrypted: z.string().min(1) }).parse(JSON.parse(configuration)).protection).toBe('windows-current-user-dpapi');
    await stopOcsApplication(application);
    expect(await hasRunningInstance(directory)).toBe(false);
    application = await start(directory, executable);
    page = application.page;
    trackOcsRequests(page);
    page.on('pageerror', error => errors.push(error.message));
    await page.getByTestId('nav-ocs').click();
    await expect(page.getByTestId('ocs-phase')).toHaveText('源码服务就绪');
    const restored = await state(page);
    expect(restored.settings).toEqual(savedSettings);
    expect(restored.browsers.map(browser => browser.id)).toEqual(ids);
    expect(restored.browsers.every(browser => browser.phase === 'stopped' && !browser.owned)).toBe(true);
    expect(restored.browsers.find(browser => browser.id === secondId)).toMatchObject({ name: 'OCS local blank B edited', folder: 'Edited local folder', tags: ['edited', 'local-only'], notes: 'Edited metadata, never a course result.', startUrl: 'about:blank' });
    expect(restored.browsers.find(browser => browser.id === firstId)?.automationName).toBe(automation.name);
    expect(JSON.stringify(restored).includes(secret)).toBe(false);
    await page.getByTestId('ocs-tab-settings').click();
    await expect(page.getByTestId('ocs-settings-sync')).toBeChecked({ checked: savedSettings.syncEnabled });
    await expect(page.getByTestId('ocs-settings-dialogs')).toBeChecked({ checked: savedSettings.enableDialogs });
    await expect(page.getByTestId('ocs-settings-json')).toHaveValue(savedSettings.globalConfigJson);
    await page.getByTestId('ocs-tab-browsers').click();
    await page.getByTestId(`ocs-browser-select-${firstId}`).click();
    await expect(page.getByTestId('ocs-automation-name')).toHaveValue(automation.name);
    await expect(page.getByTestId(`ocs-automation-field-${privateField.key}`)).toHaveValue('');
    await page.getByTestId('ocs-automation-clear').click();
    await page.getByTestId('ocs-confirm-submit').click();
    await expect(page.getByTestId('ocs-confirm-dialog')).toHaveCount(0);
    expect((await state(page)).browsers.find(browser => browser.id === firstId)?.automationName).toBeNull();
    await page.getByTestId(`ocs-browser-delete-${secondId}`).click();
    await page.getByTestId('ocs-confirm-cancel').click();
    await expect(page.getByTestId(`ocs-browser-row-${secondId}`)).toBeVisible();
    await page.getByTestId(`ocs-browser-delete-${secondId}`).click();
    await page.getByTestId('ocs-confirm-delete').click();
    await expect(page.getByTestId(`ocs-browser-row-${secondId}`)).toHaveCount(0);
    await expect(stat(profiles[1]!)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(profiles[0]!)).isDirectory()).toBe(true);
    await page.getByTestId(`ocs-browser-start-${firstId}`).click();
    await waitForPhase(page, firstId, '运行中');
    expect((await state(page)).browsers.find(browser => browser.id === firstId)?.owned).toBe(true);
    expect(await browserPids([profiles[0]!])).toHaveLength(1);
    await stopOcsApplication(application);
    await expect.poll(() => browserPids(profiles), { timeout: 15_000 }).toEqual([]);
    expect(await hasRunningInstance(directory)).toBe(false);
    const desktopState = readStore(directory);
    expect(desktopState.session).toBeNull();
    expect(desktopState.history).toEqual([]);
    expect(desktopState.submissions).toEqual([]);
    expect(errors).toEqual([]);
    await writeFile(join(directory, 'ocs-source-result.json'), JSON.stringify({ integration: 'source', sameApplicationUi: true, browserCrud: true, independentProfiles: 2, realProcesses: true, navigationPreservesBrowsers: true, realPngPreview: true, individualAndAllStop: true, settingsRestart: true, privateParametersNotReturned: true, explicitResourceErrors: true, unavailableCapabilitiesLabeled: true, narrowLayout: true, quitClosesBrowsers: true, courseExecutionTested: false, timestamp: new Date().toISOString() }), 'utf8');
  } catch (cause: unknown) {
    const originalFailure = cause instanceof Error ? cause : new Error('OCS UI validation threw a non-Error value.', { cause });
    bodyFailure = originalFailure;
    const diagnosticsPath = join(directory, 'ocs-failure-diagnostics.json');
    try {
      const { sanitizeOcsMessage } = await import('../../desktop/bun/ocs-privacy');
      const snapshot = await state(application.page);
      const stateCapturedAt = new Date().toISOString();
      if (snapshot.dataDirectory !== sourceDirectory) throw new Error('Refusing to inspect OCS profiles outside this test data directory.');
      const ui = await application.page.evaluate(ids => ({
        phase: document.querySelector('[data-testid="ocs-phase"]')?.textContent ?? null,
        browsers: ids.map(id => ({ id, phase: document.querySelector(`[data-testid="ocs-browser-phase-${id}"]`)?.textContent ?? null }))
      }), snapshot.browsers.map(browser => browser.id));
      const uiCapturedAt = new Date().toISOString();
      const profiles = await Promise.all(snapshot.browsers.map(async browser => {
        const profile = join(sourceDirectory, 'profiles', browser.id);
        const rootPids = await browserPids([profile]);
        return { browserId: browser.id, profile, rootPids, inspectedAt: new Date().toISOString() };
      }));
      await writeFile(diagnosticsPath, JSON.stringify({
        stateCapturedAt, uiCapturedAt, integration: snapshot.integration, browserExecutable: snapshot.browserExecutable,
        browsers: snapshot.browsers.map(browser => ({ ...browser, lastError: browser.lastError === null ? null : sanitizeOcsMessage(browser.lastError, [secret]) })),
        logs: snapshot.logs.map(log => ({ ...log, message: sanitizeOcsMessage(log.message, [secret]) })),
        capabilities: snapshot.capabilities, profiles, ui
      }, null, 2), { encoding: 'utf8', mode: 0o600 });
      console.log(JSON.stringify({ event: 'ocs.failure.diagnostics', path: diagnosticsPath }));
      await test.info().attach('ocs-failure-diagnostics', { path: diagnosticsPath, contentType: 'application/json' });
    } catch (diagnosticCause: unknown) {
      const diagnosticFailure = new Error(`Unable to save OCS failure diagnostics at ${diagnosticsPath}.`, { cause: diagnosticCause });
      bodyFailure = new AggregateError([originalFailure, diagnosticFailure], 'OCS UI validation and failure diagnostics both failed.', { cause: originalFailure });
    }
  } finally {
    const cleanupFailures: Error[] = [];
    try {
      if (application.process.exitCode === null && application.process.signalCode === null && !shutdownAttempts.has(application.process)) await stopOcsApplication(application);
    } catch (cause: unknown) {
      cleanupFailures.push(cause instanceof Error ? cause : new Error('Normal OCS application shutdown threw a non-Error value.', { cause }));
    }
    try { await application.browser.close(); }
    catch (cause: unknown) { cleanupFailures.push(cause instanceof Error ? cause : new Error('The OCS UI test browser did not close normally.', { cause })); }
    if (bodyFailure && cleanupFailures.length > 0) throw new AggregateError([bodyFailure, ...cleanupFailures], 'OCS UI validation and normal cleanup both failed.', { cause: bodyFailure });
    if (bodyFailure) throw bodyFailure;
    if (cleanupFailures.length > 0) throw new AggregateError(cleanupFailures, 'OCS normal cleanup failed.');
  }
});

test('Pi provider UI protects compiled native sessions, keeps secrets private across restart and requires explicit sending', async () => {
  const directory = resolve('work', `models-ui-${randomUUID()}`);
  const secret = randomUUID();
  const { piCommandSchema } = await import('../../desktop/shared/pi');
  const piCommands: Array<'state' | 'start' | 'prompt' | 'stop' | 'clear'> = [];
  const piStarts: Array<{ ocsToolsEnabled: boolean }> = [];
  const errors: string[] = [];
  function observe(page: Page): void {
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (new URL(request.url()).pathname !== '/api/pi' || request.method() !== 'POST') return;
      const decoded: unknown = request.postDataJSON();
      const command = piCommandSchema.safeParse(decoded);
      if (!command.success) { errors.push('The renderer sent an invalid Pi command.'); return; }
      piCommands.push(command.data.command);
      if (command.data.command === 'start') piStarts.push({ ocsToolsEnabled: command.data.ocsToolsEnabled });
    });
  }
  let application = await start(directory, executable);
  try {
    let page = application.page;
    observe(page);
    await page.getByTestId('nav-models').click();
    await expect(page.getByTestId('pi-status')).toHaveText('已停止');
    const initialPi = await page.evaluate(() => window.pi.execute({ command: 'state' }));
    if (!initialPi.ok) throw new Error(initialPi.error.message);
    expect(initialPi.value).toMatchObject({ runtime: 'native-sdk', sdkVersion: '1.3.0', mode: 'diagnose', phase: 'stopped', busy: false, tools: [], messages: [], model: null, costKnown: false });
    const endpoint = `${application.origin}/api/pi`;
    const headers = { Origin: application.origin, 'Content-Type': 'application/json', 'X-SWU-Request': '1' };
    const anonymous = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ command: 'state' }) });
    expect(anonymous.status).toBe(401);
    await anonymous.text();
    const crossOrigin = await page.context().request.post(endpoint, { headers: { ...headers, Origin: 'https://example.invalid' }, data: { command: 'state' } });
    expect(crossOrigin.status()).toBe(403);
    const missingMarker = await page.context().request.post(endpoint, { headers: { Origin: application.origin, 'Content-Type': 'application/json' }, data: { command: 'state' } });
    expect(missingMarker.status()).toBe(403);
    for (const data of [{ command: 'state', unexpected: true }, { command: 'start', providerId: 'not-a-uuid', ocsToolsEnabled: false }, { command: 'prompt', text: 'Unconfirmed diagnostic request must be rejected.', confirmed: false, confirmedToolResults: false }]) {
      const rejected = await page.context().request.post(endpoint, { headers, data });
      expect(rejected.status()).toBe(200);
      const decoded: unknown = await rejected.json();
      const failure = z.object({ ok: z.literal(false), error: z.object({ code: z.literal('INVALID_DATA'), message: z.string().min(1) }) }).parse(decoded);
      expect(failure.error.code).toBe('INVALID_DATA');
    }
    const oversized = await page.context().request.post(endpoint, { headers, data: JSON.stringify({ command: 'state', padding: 'x'.repeat(65_537) }) });
    expect(oversized.status()).toBe(413);
    const afterRejected = await page.evaluate(() => window.pi.execute({ command: 'state' }));
    if (!afterRejected.ok) throw new Error(afterRejected.error.message);
    expect(afterRejected.value).toMatchObject({ phase: 'stopped', busy: false, model: null, messages: [] });
    await page.getByTestId('model-name').fill('Local provider configuration');
    await page.getByTestId('model-base-url').fill('http://127.0.0.1:11434');
    await page.getByTestId('model-id').fill('configured-model');
    await page.getByTestId('model-api-key').fill(secret);
    await page.getByTestId('model-save').click();
    await expect(page.getByTestId('model-result')).toContainText('配置已校验并加密保存。本次保存未发送模型请求。');
    await expect(page.getByTestId('model-api-key')).toHaveValue('');
    expect(await page.evaluate(value => document.documentElement.outerHTML.includes(value), secret)).toBe(false);
    const publicState = await page.evaluate(() => window.models.execute({ command: 'state' }));
    expect(JSON.stringify(publicState).includes(secret)).toBe(false);
    const disk = await readFile(join(directory, 'model-providers.json'), 'utf8');
    expect(disk.includes(secret)).toBe(false);
    await stop(application);
    application = await start(directory, executable);
    page = application.page;
    observe(page);
    await page.getByTestId('nav-models').click();
    await expect(page.getByTestId('pi-status')).toHaveText('已停止');
    const restored = await page.evaluate(() => window.models.execute({ command: 'state' }));
    if (!restored.ok || restored.value.providers.length !== 1) throw new Error('Saved provider metadata was not restored.');
    const provider = restored.value.providers[0];
    if (!provider) throw new Error('Restored provider has no public metadata.');
    expect(provider.hasApiKey).toBe(true);
    await page.getByTestId(`model-select-${provider.id}`).click();
    await expect(page.getByTestId('model-api-key')).toHaveValue('');
    await page.getByTestId('model-forget-key').click();
    await expect(page.getByTestId('model-forget-key')).toBeDisabled();
    const forgotten = await page.evaluate(() => window.models.execute({ command: 'state' }));
    if (!forgotten.ok) throw new Error(forgotten.error.message);
    expect(forgotten.value.providers[0]?.hasApiKey).toBe(false);
    await page.getByTestId('pi-provider').selectOption(provider.id);
    await expect(page.getByTestId('pi-ocs-enabled')).not.toBeChecked();
    await page.getByTestId('pi-start').click();
    await expect(page.getByTestId('pi-status')).toHaveText('会话已准备（非连通证明）');
    await expect(page.getByTestId('pi-send')).toBeDisabled();
    const ready = await page.evaluate(() => window.pi.execute({ command: 'state' }));
    if (!ready.ok) throw new Error(ready.error.message);
    expect(ready.value).toMatchObject({ mode: 'diagnose', phase: 'ready', busy: false, model: { providerId: provider.id }, tools: [], messages: [], costKnown: false });
    expect(piStarts).toEqual([{ ocsToolsEnabled: false }]);
    expect(JSON.stringify(ready.value).includes(secret)).toBe(false);
    await page.getByTestId('pi-stop').click();
    await expect(page.getByTestId('pi-status')).toHaveText('已停止');
    const stopped = await page.evaluate(() => window.pi.execute({ command: 'state' }));
    if (!stopped.ok) throw new Error(stopped.error.message);
    expect(stopped.value).toMatchObject({ phase: 'stopped', busy: false, model: { providerId: provider.id }, messages: [] });
    await page.getByTestId('pi-clear').click();
    await expect(page.getByTestId('pi-runtime-info')).toContainText('尚无会话模型');
    const cleared = await page.evaluate(() => window.pi.execute({ command: 'state' }));
    if (!cleared.ok) throw new Error(cleared.error.message);
    expect(cleared.value).toMatchObject({ phase: 'stopped', busy: false, model: null, messages: [], lastError: null });
    await page.setViewportSize({ width: 760, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await page.evaluate(value => document.documentElement.outerHTML.includes(value), secret)).toBe(false);
    await expect(page.getByTestId('models-page')).not.toContainText(/W\.?O\.?F|NAI Studio/i);
    await page.screenshot({ path: resolve('work/pi-provider-ui-narrow.png'), fullPage: true });
    await page.getByTestId('model-remove').click();
    await expect(page.getByTestId('models-empty')).toBeVisible();
    expect(piCommands).toEqual(expect.arrayContaining(['state', 'start', 'stop', 'clear']));
    expect(piCommands).not.toContain('prompt');
    expect(errors).toEqual([]);
    await writeFile(resolve('work/pi-provider-ui-result.json'), JSON.stringify({ compiled: true, executable, runtime: 'native-sdk', sessionPhase: 'stopped', nativeLifecycle: ['state', 'start-without-key', 'stop', 'clear'], hostGuards: { anonymous: 401, crossOrigin: 403, missingMarker: 403, strictSchema: 'INVALID_DATA', oversizedBody: 413 }, save: true, dpapi: true, restart: true, secretsNotReturned: true, forgetAndRemove: true, narrowLayout: true, width: 760, observedPiCommands: piCommands, promptRequests: 0, modelRequests: 0, timestamp: new Date().toISOString() }, null, 2), 'utf8');
  } finally { await stop(application); }
});
