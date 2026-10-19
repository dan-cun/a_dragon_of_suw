import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import packageMetadata from '../../package.json';
import type { AppState, Phase, RunRecord, Submission } from '../shared/contracts';
import { locationSchema, settingsSchema } from '../shared/validation';
import { createClient, type ReportEntry } from '../core/api';
import { syncTasks, runCheckin, readSubmissionConfirmation } from '../core/workflow';
import { findSubmission, assertNotSubmitted, claimSubmission, confirmSubmission, deferConfirmation, replaceSubmission } from '../core/submissions';
import { assertCheckinWindow, getShanghaiClock } from '../core/time';
import { configuredPosition } from '../core/location';
import { DakaError } from '../core/errors';
import { assertNotOnLeave, assertScheduleSettings, assertTaskNotOnLeave, isAutomaticWindowOpen } from '../core/schedule-policy';
import { createAuthentication, type Authentication } from './auth';
import { createCaptchaRecognizer, type CaptchaRecognizer } from './captcha-ocr';
import { initialSettings, readStore, writeStore, type StoredSession } from './store';
import { failedSchedule, freshSchedule, isScheduleDue, nextScheduleCheck, planSchedule, resumeSchedule } from './scheduler';
import { protectToken, unprotectToken, setLaunchAtLogin, openDataFolder } from './native';
import { readLoginMemory, writeLoginMemory, clearLoginMemory, type LoginMemory, type AuthenticationSubmission } from './login-memory';
import { credentialsSchema } from './auth-http';

export async function createApplication(dataDirectory: string, edgePath: string, externalBusy: () => boolean) {
  let token: string | null = null;
  let savedSession: StoredSession | null = null;
  let storageFailure: Error | null = null;
  let scheduleRunning = false;
  let authenticationBusy = false;
  let authentication: Authentication | null = null;
  let loginMemory: LoginMemory | null = null;
  let pendingLogin: { username: string; password: string; remember: boolean } | null = null;
  let automaticLoginAttempted = false;
  let closing = false;
  let loginCompletion: Promise<void> | null = null;
  const captchaOcrExecutable = process.env['SWU_CAPTCHA_OCR'] ?? join(dirname(process.execPath), 'engine', 'captcha-ocr.exe');
  let captchaRecognizer: CaptchaRecognizer | null = null;
  function recognizeCaptcha(imageDataUrl: string, signal: AbortSignal): Promise<string> {
    if (captchaRecognizer === null) captchaRecognizer = createCaptchaRecognizer(captchaOcrExecutable);
    return captchaRecognizer.recognize(imageDataUrl, signal);
  }
  const subscribers = new Set<(state: AppState) => void>();
  const state: AppState = {
    version: packageMetadata.version, phase: 'idle', sessionStatus: 'signed-out', rememberedLogin: false, profile: null, tasks: [], settings: { ...initialSettings },
    history: [], logs: [], lastSyncedAt: null, lastScheduledDate: null, submissions: [], legacyHold: null,
    schedule: freshSchedule(), lastPosition: null, authentication: null
  };
  function publish(): void { for (const listener of subscribers) listener(state); }
  function persist(): void {
    if (storageFailure !== null) throw storageFailure;
    try { writeStore(dataDirectory, state, savedSession); }
    catch (error) {
      storageFailure = new Error('本地状态保存失败，已停止后续操作。请检查数据目录权限和磁盘空间后重启程序。', { cause: error });
      throw storageFailure;
    }
  }
  function sanitize(message: string): string {
    let clean = message.replace(/(?:https?:\/\/)[^\s]+/g, '[接口地址]').replace(/(?:password|token|cookie|IDToken[123]|authorization)\s*[=:]\s*[^\s,;]+/gi, '[敏感字段已隐藏]');
    if (token) clean = clean.replaceAll(token, '[登录令牌]');
    if (loginMemory) clean = clean.replaceAll(loginMemory.password, '[密码]').replaceAll(loginMemory.username, '[账号]');
    if (pendingLogin) clean = clean.replaceAll(pendingLogin.password, '[密码]').replaceAll(pendingLogin.username, '[账号]');
    if (state.profile) clean = clean.replaceAll(state.profile.username, '[账号]');
    return clean.slice(0, 800);
  }
  function detail(error: unknown): { code: string; message: string } {
    if (error instanceof z.ZodError) return { code: 'INVALID_DATA', message: '数据格式不符合要求，请检查设置或重新同步任务。' };
    if (error instanceof Error) return {
      code: 'code' in error && typeof error.code === 'string' ? error.code : 'OPERATION_FAILED', message: sanitize(error.message)
    };
    return { code: 'OPERATION_FAILED', message: '收到非标准操作错误，请查看运行日志。' };
  }
  function report(entry: ReportEntry): void {
    if (!authenticationBusy && token !== null && entry.request !== undefined
      && [entry.request.httpStatus, entry.request.businessCode].some(code => code === 401 || code === 403)) {
      state.sessionStatus = 'rejected';
      state.tasks = []; state.lastSyncedAt = null;
    }
    state.logs = [...state.logs.slice(-599), { id: randomUUID(), timestamp: new Date().toISOString(), ...entry, message: sanitize(entry.message) }];
    publish();
  }
  function phase(value: Phase): void { state.phase = value; publish(); }
  function sessionToken(): string {
    if (token === null) throw new DakaError('AUTH_REQUIRED', '请先登录校园账号，再同步今日任务。', undefined);
    if (state.sessionStatus === 'rejected') throw new DakaError('AUTH_REQUIRED', '学校已拒绝当前认证，请点击重新登录；本次未发送学校请求。', undefined);
    return token;
  }
  async function exclusive(operation: () => Promise<void>): Promise<AppState> {
    if (closing) throw new DakaError('OPERATION_BUSY', '程序已停止业务并正在退出，请稍后重新打开。', undefined);
    if (externalBusy()) throw new DakaError('OPERATION_BUSY', '乐跑操作正在进行，请等待结束后再操作查寝。', undefined);
    if (state.phase !== 'idle') throw new Error('已有操作正在执行，请等待完成后再试。');
    if (storageFailure !== null) throw storageFailure;
    try { phase('syncing'); await operation(); persist(); }
    finally {
      phase('idle');
      if (state.sessionStatus === 'rejected' && loginMemory !== null) queueMicrotask(() => { void recoverLogin().catch(error => report({ level: 'error', event: 'session.reauth-failed', message: detail(error).message })); });
    }
    return state;
  }
  async function synchronize(): Promise<void> {
    phase('syncing');
    const result = await syncTasks(client, sessionToken(), new Date());
    if (state.profile !== null && state.profile.username !== result.profile.username) throw new Error('当前会话身份已改变，请退出后重新登录。');
    state.profile = result.profile;
    state.sessionStatus = 'valid';
    state.tasks = result.tasks;
    if (state.legacyHold !== null && (state.legacyHold.account === null || state.legacyHold.account === result.profile.username)) {
      const legacy = state.legacyHold;
      if (legacy.date !== getShanghaiClock(new Date()).date || result.tasks.length > 0) {
        for (const task of result.tasks.filter(task => task.date === legacy.date)) {
          const entry = claimSubmission(result.profile.username, task, null, new Date());
          state.submissions = replaceSubmission(state.submissions, task.signed ? confirmSubmission(entry, new Date()) : entry);
        }
        state.legacyHold = null;
        report({ level: 'warning', event: 'submission.migrated', message: '旧版当天防重标记已迁移为独立任务记录；未确认项只回查，不重新提交。' });
      }
    }
    for (const task of result.tasks.filter(task => task.signed)) {
      const entry = findSubmission(state.submissions, result.profile.username, task.date, task.id);
      if (entry?.status !== 'confirmed') acceptConfirmation(entry ?? claimSubmission(result.profile.username, task, null, new Date()));
    }
    state.lastSyncedAt = new Date().toISOString();
    report({ level: 'info', event: 'tasks.synced', message: `已同步 ${result.tasks.length} 个今日查寝任务。` });
  }
  function acceptConfirmation(entry: Submission): void {
    state.submissions = replaceSubmission(state.submissions, confirmSubmission(entry, new Date()));
    state.tasks = state.tasks.map(task => task.id === entry.taskId && task.studentId === entry.account && task.date === entry.date ? { ...task, signed: true } : task);
    state.history = state.history.map(record => record.id === entry.recordId ? { ...record, outcome: 'success', message: '只读回查后，学校服务端确认已签到。' } : record);
  }
  async function execute(taskId: string, trigger: 'manual' | 'scheduled'): Promise<void> {
    assertNotOnLeave(state.settings, new Date());
    const selected = state.tasks.find((task) => task.id === taskId);
    if (!selected) throw new Error('所选任务已失效，请重新同步后选择。');
    const record: RunRecord = { id: randomUUID(), timestamp: new Date().toISOString(), taskId, taskTitle: selected.title, outcome: 'failed', message: '', trigger };
    try {
      await synchronize();
      const current = state.tasks.find((task) => task.id === taskId);
      if (!current) throw new Error('所选任务已不在今日查寝列表中。');
      assertTaskNotOnLeave(current);
      if (current.signed) {
        record.outcome = 'already-signed'; record.message = '服务端确认该任务已签到，无需重复提交。';
        state.lastScheduledDate = getShanghaiClock(new Date()).date;
      } else {
        assertNotSubmitted(state.submissions, current.studentId, current);
        assertCheckinWindow(current, new Date());
        phase('locating'); state.lastPosition = null;
        const position = configuredPosition(state.settings.location, new Date());
        state.lastPosition = position; publish();
        const outcome = await runCheckin(client, sessionToken(), taskId, position, () => new Date(), (value) => {
          if (value === 'submitting') {
            assertNotOnLeave(state.settings, new Date());
            if (trigger === 'scheduled' && !isAutomaticWindowOpen(state.settings, new Date(), schedulingBoundary(new Date()))) {
              throw new DakaError('SCHEDULE_ENDED', '已离开所设自动打卡时间段或当天已暂停，未发送提交。', undefined);
            }
            // Persist before sending the non-idempotent request, including manual submissions.
            state.lastScheduledDate = getShanghaiClock(new Date()).date;
            state.submissions = replaceSubmission(state.submissions, claimSubmission(current.studentId, current, record.id, new Date()));
            persist();
          }
          if (value === 'confirming') {
            const entry = findSubmission(state.submissions, current.studentId, current.date, current.id);
            if (entry === undefined) throw new Error('提交防重记录缺失，未进行结果回查。');
            state.submissions = replaceSubmission(state.submissions, { ...entry, checks: 1, nextCheckAt: Date.now() + 15_000 });
            persist();
          }
          phase(value);
        });
        record.outcome = outcome.outcome; record.message = sanitize(outcome.message);
        const submitted = findSubmission(state.submissions, current.studentId, current.date, current.id);
        if (outcome.task.signed) acceptConfirmation(submitted ?? claimSubmission(current.studentId, current, record.id, new Date()));
        else if (submitted !== undefined) state.submissions = replaceSubmission(state.submissions, { ...submitted, lastError: record.message, nextCheckAt: Date.now() + 15_000 });
        if (outcome.outcome === 'already-signed') state.lastScheduledDate = getShanghaiClock(new Date()).date;
        state.tasks = state.tasks.map((task) => task.id === taskId ? outcome.task : task);
      }
      report({ level: record.outcome === 'unconfirmed' ? 'warning' : 'info', event: 'checkin.result', message: record.message });
    } catch (error) {
      record.message = detail(error).message;
      const submitted = findSubmission(state.submissions, selected.studentId, selected.date, selected.id);
      if (submitted?.recordId === record.id && submitted.status === 'pending') {
        record.outcome = 'unconfirmed';
        state.submissions = replaceSubmission(state.submissions, { ...submitted, lastError: record.message, nextCheckAt: Date.now() + 15_000 });
      }
      report({ level: 'error', event: 'checkin.failed', message: record.message });
      throw error;
    } finally {
      state.history = [record, ...state.history].slice(0, 200);
      persist(); publish();
    }
  }
  const client = createClient(fetch, report);

  try {
    const saved = readStore(dataDirectory);
    state.settings = saved.settings; state.history = saved.history; state.logs = saved.logs; state.lastScheduledDate = saved.lastScheduledDate; state.schedule = saved.schedule;
    state.submissions = saved.submissions; state.legacyHold = saved.legacyHold;
    savedSession = saved.session;
    loginMemory = await readLoginMemory(dataDirectory);
    state.rememberedLogin = loginMemory !== null;
    if (saved.session !== null) {
      token = await unprotectToken(saved.session.encryptedToken);
      state.profile = { username: saved.session.username, displayName: saved.session.displayName };
      state.sessionStatus = 'unverified';
    }
    persist();
  } catch (error) {
    storageFailure = new Error('本地数据无法读取或解密。请通过数据目录保留文件并排查，然后重新启动程序。', { cause: error });
    report({ level: 'error', event: 'storage.load-failed', message: storageFailure.message });
  }

  async function completeLogin(activeAuthentication: Authentication): Promise<void> {
    try {
      const newToken = await activeAuthentication.wait();
      const identity = await client.profile(newToken);
      const encryptedToken = await protectToken(newToken);
      const remembered = pendingLogin?.remember ? { username: pendingLogin.username, password: pendingLogin.password, cookies: activeAuthentication.getCookies() }
        : pendingLogin === null && loginMemory !== null ? { ...loginMemory, cookies: activeAuthentication.getCookies() } : null;
      if (remembered !== null) {
        if (remembered.username !== identity.username) throw new DakaError('ACCOUNT_MISMATCH', '认证身份与记住的账号不同，未保存账号密码。', undefined);
        await writeLoginMemory(dataDirectory, remembered);
      } else clearLoginMemory(dataDirectory);
      loginMemory = remembered; state.rememberedLogin = remembered !== null;
      token = newToken; savedSession = { ...identity, encryptedToken };
      state.profile = identity; state.sessionStatus = 'valid'; state.tasks = []; state.lastSyncedAt = null; state.lastPosition = null;
      state.schedule = resumeSchedule(state.schedule);
      state.authentication = { active: false, stage: 'ready', message: '登录成功，校园会话已安全保存在本机。', captcha: '', captchaCode: '', result: 'success' };
      persist();
      try { await synchronize(); automaticLoginAttempted = false; }
      catch (error) {
        if (error instanceof DakaError && error.code === 'AUTH_REQUIRED') state.sessionStatus = 'rejected';
        report({ level: 'error', event: 'login.task-sync-failed', message: detail(error).message });
      }
      persist();
    } catch (error) {
      const failure = detail(error);
      state.authentication = { active: false, stage: 'ready', message: failure.message, captcha: '', captchaCode: '', result: 'failed' };
      report({ level: 'warning', event: 'auth.failed', message: failure.message });
      try { persist(); }
      catch (cause) { report({ level: 'error', event: 'storage.write-failed', message: detail(cause).message }); }
    } finally { pendingLogin = null; authenticationBusy = false; phase('idle'); }
  }

  async function startLogin(automatic: boolean): Promise<AppState> {
    if (closing) throw new DakaError('OPERATION_BUSY', '程序已停止业务并正在退出，请稍后重新打开。', undefined);
    if (externalBusy()) throw new DakaError('OPERATION_BUSY', '乐跑操作正在进行，请等待结束后再登录。', undefined);
    if (state.phase !== 'idle' || authenticationBusy) throw new Error('已有操作正在执行，请等待完成。');
    if (storageFailure !== null) throw storageFailure;
    authenticationBusy = true;
    pendingLogin = null;
    const activeAuthentication = createAuthentication(edgePath, join(dataDirectory, 'auth-sessions'), loginMemory?.cookies ?? [], recognizeCaptcha, report, (view) => {
      state.authentication = { active: true, ...view, result: 'pending' };
      publish();
    });
    authentication = activeAuthentication;
    phase('authenticating');
    state.authentication = { active: true, stage: 'preparing', message: '正在连接学校认证服务…', captcha: '', captchaCode: '', result: 'pending' };
    publish();
    loginCompletion = completeLogin(activeAuthentication);
    void activeAuthentication.start().then(async () => {
      if (!automatic || !state.settings.autoLogin || loginMemory === null) return;
      const view = activeAuthentication.getView();
      if (view.stage !== 'ready' || !/^\d{4}$/.test(view.captchaCode)) return;
      report({ level: 'info', event: 'auth-auto-submit', message: '已自动识别验证码，正在使用保存的密码提交认证。' });
      await activeAuthentication.submit({ username: loginMemory.username, password: loginMemory.password, captcha: view.captchaCode })
        .catch((error: unknown) => report({ level: 'warning', event: 'auth-auto-submit-failed', message: detail(error).message }));
    }).catch(async (error: unknown) => {
      report({ level: 'warning', event: 'auth.start-failed', message: detail(error).message });
      await activeAuthentication.cancel();
    });
    return state;
  }

  async function recoverLogin(): Promise<boolean> {
    if (closing || loginMemory === null || !state.settings.autoLogin || automaticLoginAttempted || authenticationBusy || state.phase !== 'idle' || externalBusy()) return false;
    if (state.sessionStatus !== 'rejected' && token !== null) return false;
    automaticLoginAttempted = true;
    report({ level: 'warning', event: 'session.reauth', message: '学校认证失效，自动登录已开启，正在使用保存的密码和自动验证码识别重新认证。' });
    await startLogin(true);
    await loginCompletion;
    return state.sessionStatus === 'valid';
  }

  // The random range only chooses the planned start. Once the school task window is known,
  // the scheduler keeps trying until that window ends. A day that has not synced yet gets one
  // discovery check until day end so a restart after the planned time can still find the task.
  function schedulingBoundary(now: Date): string | null {
    const clock = getShanghaiClock(now);
    const taskEnds = state.tasks.filter(task => task.date === clock.date).map(task => task.window[1]).sort();
    const knownEnd = taskEnds.at(-1) ?? null;
    if (knownEnd !== null) return knownEnd;
    const syncedToday = state.lastSyncedAt !== null && getShanghaiClock(new Date(state.lastSyncedAt)).date === clock.date;
    return syncedToday ? null : '23:59';
  }
  async function schedule(retryAfterLogin: boolean): Promise<void> {
    if (closing || scheduleRunning || externalBusy() || state.phase !== 'idle' || !state.settings.scheduleEnabled || storageFailure !== null) return;
    scheduleRunning = true;
    let authenticationFailed = false;
    try {
      const now = new Date();
      const date = getShanghaiClock(now).date;
      if (state.settings.pausedDates.includes(date) || state.settings.leaveDates.includes(date)) return;
      const planned = planSchedule(state.settings, state.schedule, now);
      if (planned !== state.schedule) { state.schedule = planned; persist(); publish(); }
      if (!isScheduleDue(state.settings, state.schedule, now, schedulingBoundary(now))) return;
      await exclusive(async () => {
        if (token === null) throw new DakaError('AUTH_REQUIRED', '请登录学校账号后恢复定时签到。', undefined);
        configuredPosition(state.settings.location, new Date());
        await synchronize();
        const clock = getShanghaiClock(new Date());
        const candidates = state.tasks.filter((task) => !task.signed && task.date === clock.date && clock.time >= task.window[0] && clock.time <= task.window[1]
          && findSubmission(state.submissions, task.studentId, task.date, task.id) === undefined);
        if (candidates.length === 0) {
          state.schedule = nextScheduleCheck(state.schedule, new Date());
          const known = state.tasks.some(task => task.date === clock.date);
          if (known) state.schedule = { ...state.schedule, nextCheckAt: Date.now() + 300_000 };
          report({ level: 'info', event: 'schedule.waiting', message: known ? '已知任务均已处理或等待回查，5 分钟后检查是否有新任务。' : '当前没有开放的未签到任务，60 秒后继续检查。' });
          return;
        }
        if (candidates.length > 1) throw new Error('存在多个开放任务，请打开窗口选择任务并手动执行。');
        const selected = candidates[0];
        if (selected === undefined) throw new Error('定时任务选择失败。');
        await execute(selected.id, 'scheduled');
        state.schedule = { ...nextScheduleCheck(state.schedule, new Date()), nextCheckAt: Date.now() + 300_000 };
      });
    } catch (error) {
      authenticationFailed = error instanceof DakaError && error.code === 'AUTH_REQUIRED';
      const failure = error instanceof Error ? error : new Error('定时操作返回了非标准错误。', { cause: error });
      state.schedule = failedSchedule(state.schedule, failure, detail(error).message, new Date());
      const submitted = state.submissions.some(entry => entry.account === state.profile?.username && entry.date === getShanghaiClock(new Date()).date && entry.status !== 'confirmed');
      report({ level: 'warning', event: 'schedule.failed', message: submitted
        ? `${detail(error).message} 已发起提交的任务不会重复提交，后台将进行有限只读回查。`
        : state.schedule.pausedReason ?? `${detail(error).message} 60 秒后重试，最多连续尝试 3 次。` });
      try { persist(); }
      catch (cause) { report({ level: 'error', event: 'storage.write-failed', message: detail(cause).message }); }
    } finally {
      scheduleRunning = false;
      if (authenticationFailed && !retryAfterLogin) {
        const recovered = await recoverLogin().catch(error => {
          report({ level: 'error', event: 'session.reauth-failed', message: detail(error).message });
          return false;
        });
        if (recovered) {
          state.schedule = resumeSchedule(state.schedule);
          try { persist(); }
          catch (cause) { report({ level: 'error', event: 'storage.write-failed', message: detail(cause).message }); }
          publish();
          report({ level: 'info', event: 'schedule.resume-after-login', message: '自动登录已完成，继续执行今天的定时签到。' });
          await schedule(true);
        }
      }
    }
  }
  async function reconcile(): Promise<void> {
    if (closing || scheduleRunning || state.phase !== 'idle' || externalBusy() || storageFailure !== null || token === null || state.sessionStatus === 'rejected') return;
    const now = Date.now();
    const entry = state.submissions.find(entry => entry.account === state.profile?.username && entry.status === 'pending' && entry.checks < 3 && entry.nextCheckAt !== null && entry.nextCheckAt <= now);
    if (entry === undefined) return;
    let authenticationFailed = false;
    await exclusive(async () => {
      // Consume the read budget before the request so restarts cannot reset it.
      let checked = deferConfirmation(entry, '等待学校确认。', new Date());
      state.submissions = replaceSubmission(state.submissions, { ...checked, status: 'pending' }); persist();
      try {
        if (await readSubmissionConfirmation(client, sessionToken(), entry)) {
          acceptConfirmation(checked);
          report({ level: 'info', event: 'submission.confirmed', message: '只读回查确认一项任务已签到；没有重新提交。' });
          return;
        }
        checked = { ...checked, lastError: '学校回查尚未显示已签到。' };
      } catch (error) {
        checked = { ...checked, lastError: detail(error).message };
        if (error instanceof DakaError && error.code === 'ACCOUNT_MISMATCH') checked = { ...checked, status: 'unresolved', nextCheckAt: null };
        report({ level: 'warning', event: 'submission.read-failed', message: detail(error).message });
        if (error instanceof DakaError && error.code === 'AUTH_REQUIRED') { state.sessionStatus = 'rejected'; authenticationFailed = true; }
      }
      state.submissions = replaceSubmission(state.submissions, checked);
      report({ level: 'warning', event: checked.status === 'unresolved' ? 'submission.unresolved' : 'submission.waiting', message: checked.status === 'unresolved'
        ? '这项任务的自动回查已停止，结果仍未确认。请打开学校页面核实；不会再次提交。'
        : `这项任务的第 ${checked.checks}/3 次回查尚未确认，稍后仅查询结果。` });
    });
    if (authenticationFailed) await recoverLogin();
  }
  async function tick(): Promise<void> {
    try { await reconcile(); await schedule(false); }
    catch (error) { report({ level: 'error', event: 'background.failed', message: detail(error).message }); }
  }
  const interval = setInterval(() => { void tick(); }, 15_000);

  return {
    getState: (): AppState => state,
    subscribe(listener: (state: AppState) => void): () => void { subscribers.add(listener); return () => subscribers.delete(listener); },
    login: () => startLogin(false),
    async logout(): Promise<AppState> {
      return exclusive(async () => {
        await authentication?.cancel(); token = null; savedSession = null;
        clearLoginMemory(dataDirectory); loginMemory = null; state.rememberedLogin = false;
        state.profile = null; state.sessionStatus = 'signed-out'; state.tasks = []; state.lastSyncedAt = null; state.lastPosition = null; state.authentication = null;
        state.settings = { ...state.settings, scheduleEnabled: false };
        report({ level: 'info', event: 'session.cleared', message: '已退出登录，定时打卡已关闭。' });
      });
    },
    sync: (): Promise<AppState> => exclusive(synchronize),
    forgetLogin: (): Promise<AppState> => exclusive(async () => {
      clearLoginMemory(dataDirectory); loginMemory = null; state.rememberedLogin = false;
      report({ level: 'info', event: 'session.memory-cleared', message: '已删除保存的账号密码与学校登录会话，当前应用令牌保持不变。' });
    }),
    saveLocation: (payload: unknown): Promise<AppState> => exclusive(async () => {
      const location = locationSchema.safeParse(payload);
      if (!location.success) throw new DakaError('INVALID_POSITION', '坐标保存失败：经度须为 -180 到 180，纬度须为 -90 到 90，地点名称不能为空。', undefined);
      state.settings = { ...state.settings, location: location.data };
      state.lastPosition = null;
      state.schedule = resumeSchedule(state.schedule);
      report({ level: 'info', event: 'location.saved', message: '签到坐标已保存，手动和定时签到均使用此位置。' });
    }),
    checkin: (taskId: string): Promise<AppState> => exclusive(async () => execute(taskId, 'manual')),
    saveSettings: (payload: unknown): Promise<AppState> => exclusive(async () => {
      const settings = settingsSchema.parse(payload);
      assertScheduleSettings(settings);
      if (settings.scheduleEnabled && token === null) throw new Error('开启定时打卡前，请先登录校园账号。');
      if (settings.scheduleEnabled) configuredPosition(state.settings.location, new Date());
      const previous = state.settings;
      if (settings.launchAtLogin || settings.launchAtLogin !== previous.launchAtLogin) await setLaunchAtLogin(settings.launchAtLogin);
      state.settings = { ...settings, location: state.settings.location };
      const changedWindow = settings.scheduleMode !== previous.scheduleMode || settings.scheduleTime !== previous.scheduleTime || settings.scheduleEndTime !== previous.scheduleEndTime;
      const resumed = changedWindow ? freshSchedule() : resumeSchedule(state.schedule);
      state.schedule = settings.scheduleEnabled ? planSchedule(settings, resumed, new Date()) : resumed;
      try { persist(); }
      catch (error) { state.settings = previous; if (settings.launchAtLogin !== previous.launchAtLogin) await setLaunchAtLogin(previous.launchAtLogin); throw error; }
      publish();
    }),
    openDataFolder: (): Promise<void> => openDataFolder(dataDirectory),
    getAuthView: () => {
      if (authentication === null) throw new Error('请从主界面打开登录窗口。');
      return { ...authentication.getView(), rememberedUsername: loginMemory?.username ?? null };
    },
    submitAuth: (request: AuthenticationSubmission) => {
      if (authentication === null) throw new Error('认证会话不存在，请重新登录。');
      if (request.useSaved && (loginMemory === null || request.username !== loginMemory.username)) throw new Error('没有与所填账号匹配的已保存密码，请手动填写密码。');
      const credentials = credentialsSchema.parse({ username: request.username, password: request.useSaved ? loginMemory?.password : request.password, captcha: request.captcha });
      pendingLogin = { username: credentials.username, password: credentials.password, remember: request.remember };
      return authentication.submit(credentials);
    },
    refreshAuth: () => {
      if (authentication === null) throw new Error('认证会话不存在，请重新登录。');
      return authentication.refresh();
    },
    cancelAuth: () => authentication?.cancel(),
    reportFailure(error: unknown): { code: string; message: string } {
      const failure = detail(error); report({ level: 'error', event: 'operation.failed', message: failure.message });
      if (failure.code === 'AUTH_REQUIRED') queueMicrotask(() => { void recoverLogin().catch(cause => report({ level: 'error', event: 'session.reauth-failed', message: detail(cause).message })); });
      return failure;
    },
    async close(): Promise<void> {
      closing = true;
      clearInterval(interval);
      await authentication?.cancel();
      await loginCompletion;
      if (storageFailure === null) persist();
    }
  };
}
