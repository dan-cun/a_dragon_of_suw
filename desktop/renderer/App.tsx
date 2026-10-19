import { useEffect, useRef, useState } from 'react';
import {
  ArrowRight, CalendarCheck, Check, CheckCircle2, ChevronRight,
  Clock3, ExternalLink, FolderOpen, History, LoaderCircle, LogOut,
  MapPin, RefreshCw, Settings2, ShieldCheck, Sparkles, UserRound, X,
  AlertCircle, Power, CalendarDays, Activity, GraduationCap, MonitorPlay, Bot,
} from 'lucide-react';
import type { AppState, Outcome, Phase, Result, Settings, Task } from '../shared/contracts';
import Heatmap from './Heatmap';
import LocationEditor from './LocationEditor';
import SchedulePreferences from './SchedulePreferences';
import { getShanghaiClock } from '../core/time';
import Lepao from './Lepao';
import CampusServices from './CampusServices';
import Ocs from './Ocs';
import Models from './Models';
import { findSubmission } from '../core/submissions';
import { editionLabel } from '../shared/edition';

type View = 'academic' | 'ocs' | 'models' | 'today' | 'lepao' | 'heatmap' | 'history' | 'settings';
interface Notice { kind: 'success' | 'error'; message: string; code: string }

const phases: Record<Phase, string> = {
  idle: '就绪', authenticating: '等待登录', syncing: '同步任务', locating: '读取签到坐标',
  verifying: '核验任务', submitting: '提交签到', confirming: '确认结果',
};
const outcomes: Record<Outcome, string> = {
  success: '签到成功', 'already-signed': '已签到', failed: '失败', unconfirmed: '待确认',
};
const navItems: { id: View; label: string; icon: typeof CalendarCheck }[] = [
  { id: 'today', label: '今日任务', icon: CalendarCheck },
  { id: 'academic', label: '校园服务', icon: GraduationCap },
  { id: 'ocs', label: 'OCS 网课', icon: MonitorPlay },
  { id: 'models', label: 'Pi 助手', icon: Bot },
  { id: 'lepao', label: '乐跑', icon: Activity },
  { id: 'heatmap', label: '打卡热力', icon: CalendarDays },
  { id: 'history', label: '运行记录', icon: History },
  { id: 'settings', label: '偏好设置', icon: Settings2 },
];

function dateTime(value: string | number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(date);
}

function timeWindow(task: Task): string {
  return task.window.map((value) => {
    if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(value)) return value.slice(0, 5);
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(date);
  }).join(' – ');
}

function errorNotice(code: string, message: string): Notice {
  return { kind: 'error', code, message };
}

function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [view, setView] = useState<View>('today');
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [exited, setExited] = useState(false);
  const authenticationNotice = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    const unsubscribe = window.desktop.onState((nextState) => {
      if (active) setState(nextState);
    });
    window.desktop.getState().then((result) => {
      if (!active) return;
      if (result.ok) setState(result.value);
      else setNotice(errorNotice(result.error.code, result.error.message));
    }).catch((error: unknown) => {
      if (active) setNotice(errorNotice('INITIALIZATION_FAILED', error instanceof Error ? error.message : '读取应用状态失败，请重新打开应用。'));
    });
    return () => { active = false; unsubscribe(); };
  }, []);

  useEffect(() => {
    if (state && !settingsDirty) setSettings(state.settings);
  }, [state, settingsDirty]);

  useEffect(() => {
    if (state) setSelected((id) => state.tasks.some((task) => task.id === id && !task.signed) ? id : null);
  }, [state]);

  const authenticationResult = state?.authentication?.result;
  const authenticationMessage = state?.authentication?.message;

  useEffect(() => {
    if (!authenticationResult || authenticationResult === 'pending') {
      authenticationNotice.current = null;
      return;
    }
    const key = `${authenticationResult}:${authenticationMessage ?? ''}`;
    if (authenticationNotice.current === key) return;
    authenticationNotice.current = key;
    if (authenticationResult === 'success') {
      setNotice({ kind: 'success', message: authenticationMessage || '登录成功，登录会话已保存在本机。请查看任务同步状态。', code: '' });
    } else {
      setNotice(errorNotice('AUTHENTICATION_FAILED', authenticationMessage || '学校认证失败，请重新打开登录窗口。'));
    }
  }, [authenticationResult, authenticationMessage]);

  const locked = exited || busy || (state !== null && state.phase !== 'idle');
  const pending = state?.tasks.filter((task) => !task.signed) ?? [];
  const signedCount = state?.tasks.filter((task) => task.signed).length ?? 0;
  const position = state?.settings.location ?? null;
  const confirmations = state?.submissions.filter(entry => entry.account === state.profile?.username && entry.status !== 'confirmed') ?? [];
  function submitted(task: Task): boolean {
    return state !== null && findSubmission(state.submissions, task.studentId, task.date, task.id) !== undefined;
  }
  const authenticationRejected = state?.sessionStatus === 'rejected';
  const sessionLabel = state?.sessionStatus === 'valid' ? '最近验证通过'
    : authenticationRejected ? '需重新登录' : '已保存，待验证';
  const clock = getShanghaiClock(new Date());
  const today = clock.date;
  const leaveToday = state?.settings.leaveDates.includes(today) ?? false;
  const pausedToday = state?.settings.pausedDates.includes(today) ?? false;
  const schedulePaused = state?.schedule.date === today && state.schedule.pausedReason !== null;
  const scheduleMessage = !state ? '' : leaveToday ? '今天已登记请假，手动和自动打卡均已禁止。'
    : !state.settings.scheduleEnabled ? '自动签到尚未开启；登录并保存坐标后，可在偏好设置中开启。'
    : state.rememberedLogin && !state.settings.autoLogin ? '自动登录已关闭；认证失效时需要先手动登录，之后才会继续自动打卡。'
    : pausedToday ? '今天已暂停自动打卡，不会自动查询或提交任务。'
    : authenticationRejected ? '学校认证未通过，请点击重新登录。已保存的设置和当天提交标记会保留。'
    : schedulePaused ? state.schedule.pausedReason
    : confirmations.some(entry => entry.date === today) ? '已有任务等待确认；只读回查不会重新提交，其他独立任务分别判断。'
    : state.settings.scheduleMode === 'random' && clock.time > state.settings.scheduleEndTime ? '今天的随机时间段已结束，不再自动补打。'
    : state.schedule.date === today && state.schedule.targetTime ? `今天计划 ${state.schedule.targetTime} 开始检查；仅在学校任务开放时提交，每项任务独立防重。`
    : '自动签到已开启，正在准备当天计划。';
  const authenticationActive = state?.authentication?.active ?? false;

  async function run(operation: () => Promise<Result<AppState>>, successMessage: string): Promise<void> {
    setBusy(true);
    setNotice(null);
    try {
      const result = await operation();
      if (result.ok) {
        setState(result.value);
        if (successMessage) setNotice({ kind: 'success', message: successMessage, code: '' });
      } else setNotice(errorNotice(result.error.code, result.error.message));
    } catch (error: unknown) {
      setNotice(errorNotice('REQUEST_FAILED', error instanceof Error ? error.message : '操作失败，请重试并查看运行记录。'));
    } finally { setBusy(false); }
  }

  async function openResource(operation: () => Promise<Result<void>>): Promise<void> {
    setBusy(true);
    setNotice(null);
    try {
      const result = await operation();
      if (!result.ok) setNotice(errorNotice(result.error.code, result.error.message));
    } catch (error: unknown) {
      setNotice(errorNotice('OPEN_FAILED', error instanceof Error ? error.message : '打开失败，请检查系统设置。'));
    } finally { setBusy(false); }
  }

  async function checkinSelected(): Promise<void> {
    if (!selected) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await window.desktop.checkin(selected);
      if (!result.ok) {
        setNotice(errorNotice(result.error.code, result.error.message));
        return;
      }
      setState(result.value);
      const task = result.value.tasks.find((item) => item.id === selected);
      if (!task?.signed) {
        const latest = result.value.history.find((record) => record.taskId === selected);
        setNotice(errorNotice('CHECKIN_UNCONFIRMED', latest?.message ?? '提交后尚未确认签到成功，请打开学校页面核实，再同步任务。'));
        return;
      }
      setSelected(null);
      setNotice({ kind: 'success', message: '已确认签到成功，任务状态已更新。', code: '' });
    } catch (error: unknown) {
      setNotice(errorNotice('CHECKIN_FAILED', error instanceof Error ? error.message : '签到失败，请查看运行记录。'));
    } finally { setBusy(false); }
  }

  async function savePreferences(): Promise<void> {
    if (!settings) return;
    await run(async () => {
      const result = await window.desktop.saveSettings({ ...settings, closeToTray: false });
      if (result.ok) setSettingsDirty(false);
      return result;
    }, '偏好设置已保存。');
  }

  function updateSettings(value: Partial<Settings>): void {
    if (!settings) return;
    setSettings({ ...settings, ...value });
    setSettingsDirty(true);
  }

  async function quitProgram(): Promise<void> {
    setBusy(true);
    setNotice(null);
    try {
      const result = await window.desktop.quit();
      if (result.ok) {
        setExited(true);
        setNotice({ kind: 'success', message: '后台已退出，定时签到已停止。请关闭此窗口。', code: '' });
      } else setNotice(errorNotice(result.error.code, result.error.message));
    } catch (error: unknown) {
      setNotice(errorNotice('QUIT_FAILED', error instanceof Error ? error.message : '退出程序失败，请查看运行记录。'));
    } finally { setBusy(false); }
  }

  const currentNav = navItems.find((item) => item.id === view);

  return (
    <>
    <div className="app-shell" inert={authenticationActive}>
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark"><img data-testid="brand-logo" src="/brand-icon.png" alt="" /></div><div><strong>西大日常</strong><span>课程、查寝与乐跑</span></div></div>
        <div className="sidebar-caption">工作台</div>
        <nav aria-label="主要页面">
          {navItems.map(({ id, label, icon: Icon }) => (
            <button key={id} data-testid={`nav-${id}`} className={`nav-item ${view === id ? 'active' : ''}`} onClick={() => setView(id)} aria-current={view === id ? 'page' : undefined}>
              <Icon size={19} /><span>{label}</span>{id === 'today' && pending.length > 0 && <span className="nav-count">{pending.length}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-note"><ShieldCheck size={21} /><strong>每一步都有据可查</strong><p>读取学校任务，使用已保存坐标，提交后再次确认签到状态。</p></div>
        <div className="sidebar-bottom">
          <button data-testid="open-official" className="quiet-button" disabled={locked} onClick={() => void openResource(() => window.desktop.openOfficial())}><ExternalLink size={16} />打开学校页面</button>
          <div className="sidebar-version"><span className="status-dot" /><span data-testid="release-edition">{editionLabel}</span><span>v{state?.version ?? '—'}</span></div>
        </div>
      </aside>

      <main className="main-area">
        <header className="page-header">
          <div><div className="eyebrow">SWU CAMPUS ASSISTANT</div><h1>{currentNav?.label}</h1><p>{view === 'today' ? '保存签到坐标，选择任务并确认今天的签到结果。' : view === 'academic' ? '连接学校教务，在本机查看课表、成绩和考试安排。' : view === 'ocs' ? '管理源码集成 OCS、隔离浏览器与已提供的功能子集。' : view === 'models' ? '管理本机模型配置，使用原生 Pi 诊断会话与外部协作教程。' : view === 'lepao' ? '管理乐跑成员，检查本机环境，查看执行与复核结果。' : view === 'heatmap' ? '把本机签到记录放进日历，查看确认结果和每日详情。' : view === 'history' ? '查看每一次执行结果，以及完整的运行过程。' : '按你的节奏安排签到，设置会保存在这台设备。'}</p></div>
          <div className={`phase-pill ${locked && !exited ? 'working' : ''}`} data-testid="phase-status" aria-live="polite">{locked && !exited ? <LoaderCircle size={15} className="spin" /> : <span className="status-dot" />}{exited ? '已退出' : state ? phases[state.phase] : '加载中'}{busy && state?.phase === 'idle' ? ' · 处理中' : ''}</div>
        </header>

        {notice && <div className={`notice ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'} data-testid="notice"><div>{notice.kind === 'error' ? <AlertCircle size={20} /> : <CheckCircle2 size={20} />}</div><div><strong>{notice.kind === 'error' ? '操作未完成' : '操作完成'}</strong><p>{notice.message}</p>{notice.code && <small>错误代码：{notice.code}</small>}</div><button aria-label="关闭提示" data-testid="dismiss-notice" onClick={() => setNotice(null)}><X size={17} /></button></div>}

        {!state && <div className="panel loading-panel">{notice?.kind === 'error' ? <AlertCircle size={28} /> : <LoaderCircle size={28} className="spin" />}<h2>{notice?.kind === 'error' ? '应用状态读取失败' : '正在读取应用状态'}</h2><p>读取本机保存的账号状态、任务和偏好设置。</p>{notice?.kind === 'error' && <button className="button secondary" data-testid="reload-state" disabled={locked} onClick={() => void run(() => window.desktop.getState(), '应用状态已读取。')}><RefreshCw size={16} />重新读取</button>}</div>}

        {state && view === 'academic' && <CampusServices account={state.profile?.username ?? null} locked={locked} />}
        {state && view === 'ocs' && <Ocs />}
        {state && view === 'models' && <Models />}
        {state && view === 'today' && <>
          <section className="overview-grid" aria-label="今日概况">
            <div className="stat-card"><span className="stat-icon green"><CalendarCheck size={20} /></span><div><span>待签到任务</span><strong>{pending.length}<small>项</small></strong></div></div>
            <div className="stat-card"><span className="stat-icon blue"><CheckCircle2 size={20} /></span><div><span>已完成签到</span><strong>{signedCount}<small>项</small></strong></div></div>
            <div className="stat-card schedule-stat"><span className="stat-icon amber"><Clock3 size={20} /></span><div><span>定时签到 · 北京时间</span><strong>{state.settings.scheduleEnabled ? state.settings.scheduleMode === 'random' ? `${state.settings.scheduleTime}–${state.settings.scheduleEndTime}` : state.settings.scheduleTime : '未开启'}</strong></div></div>
          </section>

          <section className="panel account-panel">
            <div className="account-icon"><UserRound size={23} /></div>
            <div className="account-info"><h2>{state.profile ? state.profile.displayName || state.profile.username : '先登录你的学校账号'}{state.profile && <span data-testid="session-status" className={`tag ${state.sessionStatus === 'valid' ? 'success-tag' : 'pending-tag'}`}>{sessionLabel}</span>}</h2><p>{state.profile ? authenticationRejected ? '学校拒绝了当前认证。可直接重新登录；若仍被拒绝，请在学校页面核查账号权限。' : `账号 ${state.profile.username} · ${state.rememberedLogin ? '已加密保存登录信息' : '未保存密码'}` : '打开登录窗口，输入校园账号与验证码；可选择记住登录。'}</p></div>
            {state.profile ? <div className="account-actions"><button data-testid="relogin-button" disabled={locked} className="button secondary" onClick={() => void run(() => window.desktop.login(), '')}><RefreshCw size={16} />重新登录</button><button data-testid="logout-button" disabled={locked} className="text-button" onClick={() => void run(() => window.desktop.logout(), '已退出登录。')}><LogOut size={16} />退出账号</button></div> : <button data-testid="login-button" disabled={locked} className="button primary" onClick={() => void run(() => window.desktop.login(), '')}>登录学校账号<ArrowRight size={16} /></button>}
          </section>

          <LocationEditor location={state.settings.location} locked={locked} onSave={location => run(() => window.desktop.saveLocation(location), '签到坐标已保存。')} />
          {confirmations.length > 0 && <section className="panel" data-testid="submission-confirmations"><div className="section-header"><div><h2>提交结果核对</h2><p>提交标记先落盘；回查只查询学校结果，不再次提交。可点击同步任务手动核对。</p></div></div><div className="lepao-body">{confirmations.map(entry => <div key={`${entry.account}:${entry.date}:${entry.taskId}`} data-testid="submission-entry"><strong>{entry.title} · {entry.date}</strong><p>{entry.status === 'pending' ? `待回查 · 已检查 ${entry.checks}/3 次` : '自动回查已停止 · 请到学校页面核实'}{entry.lastError && ` · ${entry.lastError}`}</p></div>)}</div></section>}
          <div className="info-note" data-testid="schedule-status"><Clock3 size={17} /><p>{scheduleMessage}</p>{state.settings.scheduleEnabled && schedulePaused && !leaveToday && !pausedToday && <button data-testid="resume-schedule" className="button secondary" disabled={locked || !state.profile} onClick={() => void run(() => window.desktop.saveSettings(state.settings), '已恢复定时检查。')}><RefreshCw size={16} />恢复检查</button>}</div>
          <section className="panel tasks-panel">
            <div className="section-header"><div><h2>今日签到任务 <span className="subtle-count">{state.tasks.length}</span></h2><p>{state.lastSyncedAt ? `上次同步 ${dateTime(state.lastSyncedAt)} · 北京时间` : '登录后同步任务，查看学校当前发布的签到安排。'}</p></div><button data-testid="sync-button" className="button secondary" disabled={locked || !state.profile} onClick={() => void run(() => window.desktop.sync(), '任务已同步。')}><RefreshCw size={16} />同步任务</button></div>
            <div className="flow-strip"><span className={state.profile ? 'done' : ''}><span>1</span>登录账号</span><ChevronRight size={14} /><span className={state.lastSyncedAt ? 'done' : ''}><span>2</span>同步并选择任务</span><ChevronRight size={14} /><span className={position ? 'done' : ''}><span>3</span>使用已保存坐标签到</span></div>
            {state.tasks.length === 0 ? <div className="empty-state" data-testid="tasks-empty"><div className="empty-icon"><CalendarCheck size={30} /></div><h3>{state.profile ? '暂时没有签到任务' : '今天的任务，在这里等你'}</h3><p>{state.profile ? '点击「同步任务」查看最新安排。学校未发布任务时，这里会保持空白。' : '完成登录后，点击「同步任务」获取学校发布的签到任务。'}</p></div> : <>
              <div className="task-selection"><span>选择一项任务进行签到</span><span>时间均为北京时间</span></div>
              <div className="task-list">{state.tasks.map((task) => <label key={task.id} className={`task-card ${task.signed ? 'signed' : ''} ${selected === task.id ? 'selected' : ''}`} data-testid={`task-${task.id}`}><input type="radio" name="checkin-task" data-testid={`task-select-${task.id}`} checked={selected === task.id} disabled={locked || task.signed || submitted(task)} onChange={() => setSelected(task.id)} /><div className="task-content"><div className="task-title"><h3>{task.title}</h3><span className={`tag ${task.signed ? 'success-tag' : 'pending-tag'}`}>{task.signed ? '已签到' : submitted(task) ? '已保护，等待核对' : task.status || '待签到'}</span></div><div className="task-meta"><span><Clock3 size={14} />{task.date} {timeWindow(task)}</span>{task.address && <span><MapPin size={14} />{task.address}</span>}</div>{task.radius && <div className="task-radius">学校要求范围：{task.radius}</div>}</div>{task.signed && <CheckCircle2 size={22} className="signed-check" />}</label>)}</div>
            </>}
            <div className="checkin-footer"><div><strong>{selected ? '已选择 1 项任务' : '选择需要完成的任务'}</strong><p>使用已保存坐标，核验、提交并确认结果。</p></div><button data-testid="checkin-button" className="button primary" disabled={locked || !selected || !state.profile || !position || leaveToday || state.tasks.some(task => task.id === selected && submitted(task))} onClick={() => void checkinSelected()}>{locked ? <LoaderCircle size={17} className="spin" /> : <MapPin size={17} />}使用已保存坐标打卡</button></div>
          </section>

        </>}

        {state && view === 'heatmap' && <Heatmap history={state.history} />}
        {state && view === 'lepao' && <Lepao locked={locked} />}

        {state && view === 'history' && <>
          <section className="panel"><div className="section-header"><div><h2>签到记录</h2><p>记录提交与确认结果；「待确认」请到学校页面核实。</p></div><button data-testid="open-data-folder" className="button secondary" disabled={locked} onClick={() => void openResource(() => window.desktop.openDataFolder())}><FolderOpen size={16} />数据目录</button></div>{state.history.length === 0 ? <div className="empty-state" data-testid="history-empty"><div className="empty-icon"><History size={28} /></div><h3>还没有运行记录</h3><p>完成第一次签到后，执行结果会显示在这里。</p></div> : <div className="history-list" data-testid="history-list">{state.history.map((record) => <div className="history-row" key={record.id}><div className={`record-icon ${record.outcome}`}><CheckCircle2 size={19} /></div><div className="history-main"><h3>{record.taskTitle}</h3><p>{record.message}</p><span>{dateTime(record.timestamp)} · 北京时间 · {record.trigger === 'scheduled' ? '定时执行' : '手动执行'}</span></div><span className={`tag outcome-${record.outcome}`}>{outcomes[record.outcome]}</span></div>)}</div>}</section>
          <section className="panel logs-panel"><div className="section-header"><div><h2>运行日志</h2><p>按时间查看登录、同步、定位和签到过程。</p></div><span className="tag neutral-tag">{state.logs.length} 条</span></div>{state.logs.length === 0 ? <div className="simple-empty" data-testid="logs-empty">暂无日志。执行操作后会自动记录。</div> : <div className="log-list" data-testid="log-list">{state.logs.map((log) => <div className={`log-row log-${log.level}`} key={log.id}><time>{dateTime(log.timestamp)}</time><span className="log-level">{log.level === 'error' ? '错误' : log.level === 'warning' ? '注意' : '信息'}</span><div><span className="log-event">{log.event}</span><p>{log.message}</p>{log.request && <small>{log.request.method} {log.request.host}{log.request.path} · HTTP {log.request.httpStatus ?? '未收到响应'} · {log.request.elapsedMs} ms · {log.request.responseBytes ?? '—'} B</small>}</div></div>)}</div>}</section>
        </>}

        {state && settings && view === 'settings' && <>
          <SchedulePreferences settings={settings} locked={locked} onChange={updateSettings} />
          <section className="panel settings-panel"><div className="section-header"><div><h2>应用行为</h2><p>让助手与你的日常使用方式一致。</p></div><Settings2 size={21} className="section-icon" /></div><div className="setting-row"><div><h3>后台运行与提醒</h3><p>关闭窗口后托盘继续运行。需要验证码、执行异常或结果待确认时提醒；双击托盘或点击通知打开界面。</p></div><button data-testid="test-notification" className="button secondary" disabled={locked} onClick={() => {
            void window.desktop.testNotification().then(result => setNotice(result.ok
              ? { kind: 'success', code: '', message: '提醒已交给 Windows；若未显示，请检查系统通知与勿扰设置。' }
              : errorNotice(result.error.code, result.error.message))).catch(cause => setNotice(errorNotice('NOTIFICATION_FAILED', cause instanceof Error ? cause.message : '后台提醒测试失败。')));
          }}>测试后台提醒</button></div><div className="setting-row"><div><h3>开机启动</h3><p>登录 Windows 后静默启动后台，不弹出窗口；双击程序可打开界面。</p></div><input data-testid="launch-at-login" aria-label="开机启动" type="checkbox" className="toggle" disabled={locked} checked={settings.launchAtLogin} onChange={(event) => updateSettings({ launchAtLogin: event.target.checked })} /></div><div className="setting-row"><div><h3>自动登录（打卡）</h3><p>{state.rememberedLogin ? '认证失效时自动使用已保存密码登录，验证码自动识别成功后直接提交；识别失败会停下等待手动处理。' : '尚未保存登录信息。先在登录窗口勾选“记住登录”，之后可开启自动登录。'}</p></div><input data-testid="auto-login" aria-label="自动登录" type="checkbox" className="toggle" disabled={locked || !state.rememberedLogin} checked={settings.autoLogin} onChange={(event) => updateSettings({ autoLogin: event.target.checked })} /></div><div className="settings-save"><span>{settingsDirty ? '有尚未保存的更改' : '设置已与本地保存内容同步'}</span><button data-testid="save-settings" className="button primary" disabled={locked || !settingsDirty || !/^\d{2}:\d{2}$/.test(settings.scheduleTime)} onClick={() => void savePreferences()}><Check size={16} />保存设置</button></div></section>
          <section className="panel settings-panel"><div className="section-header"><div><h2>记住登录</h2><p>{state.rememberedLogin ? '已用 Windows 加密保存账号密码和学校会话。自动登录可在上方的打卡配置中开启或关闭；验证码会自动识别填入。' : '尚未保存账号密码。登录时勾选“记住登录”，下次可使用已保存密码并自动识别验证码。'}</p></div><button data-testid="forget-login" className="button secondary" disabled={locked || !state.rememberedLogin} onClick={() => void run(() => window.desktop.forgetLogin(), '已删除保存的账号密码和学校会话。')}>忘记登录信息</button></div></section>
          <section className="panel quit-panel"><div><h2>退出程序</h2><p>停止后台运行与定时签到，然后关闭当前窗口。</p></div><button data-testid="quit-button" className="button secondary quit-button" disabled={locked} onClick={() => void quitProgram()}><Power size={16} />退出程序</button></section>
          <section className="panel about-panel"><div className="about-heading"><div className="brand-mark"><img data-testid="about-logo" src="/brand-icon.png" alt="" /></div><div><h2>关于西大日常</h2><p>西南大学查寝与乐跑整合版 · v{state.version}</p></div><Sparkles size={23} /></div><p>由 <strong>查寝打卡助手与乐跑打卡助手</strong>整合为独立项目“西大日常”，分为 1.0.0-alpha 基础版与 1.0.0-beta 含教务版两条分支；两个上游原作者均为 <strong>dan-cun</strong>。查寝模块保留原项目许可证；本整合版以乐跑研究协议 1.0（LRL-1.0）授权，仅限非商业用途。请遵守学校规定，核对所填坐标和签到结果。</p><div className="about-links"><span>项目仓库</span><a data-testid="repository-link" href="https://github.com/dan-cun/swu-daka" target="_blank" rel="noreferrer">github.com/dan-cun/swu-daka <ExternalLink size={13} /></a></div><details className="license-details"><summary data-testid="license-details">使用协议与版权说明</summary><p>Copyright (c) 2026 dan-cun。本项目仅限个人学习、技术研究等非营利目的使用，禁止商用、售卖、收费服务、广告引流或嵌入付费产品及社群。修改和再分发时必须显著标注原项目名称、作者与原始仓库，保留完整声明及版权信息。</p><p>原项目《打卡助手》使用协议与免责声明（v1.0）已随程序保留于 licenses/swu-daka/LICENSE。完整条款以随附文件为准。本应用是个人学习项目，不是学校或平台的官方产品。</p></details><p data-testid="lepao-about">乐跑模块基于 dan-cun 的 <a href="https://github.com/dan-cun/lepao3" target="_blank" rel="noreferrer">https://github.com/dan-cun/lepao3</a>，许可证为乐跑研究协议 1.0（LRL-1.0），本项目为非商业授权软件。本版是其衍生整合版，名称为“西大日常”。修改者：本地项目维护者；修改日期：2026-10-17；修改范围：统一桌面界面、独立引擎通信、安装与本机进程和代理管理。原作者不负责本整合版技术支持，请通过本地项目维护者反馈问题。</p></section>
        </>}
        <footer className="page-footer">西大日常 <span>·</span> 查寝与乐跑整合版 <span>·</span> dan-cun · <a href="https://github.com/dan-cun/lepao3" target="_blank" rel="noreferrer">lepao3</a> · 乐跑研究协议 1.0（LRL-1.0）· 非商业授权软件</footer>
      </main>
    </div>
    {authenticationActive && <div className="login-overlay" role="dialog" aria-modal="true" aria-label="校园账号登录" data-testid="login-modal"><iframe className="login-frame" src="/auth/" title="校园账号登录" data-testid="login-frame" tabIndex={0} onLoad={(event) => event.currentTarget.focus()} /></div>}
    </>
  );
}

export default App;
