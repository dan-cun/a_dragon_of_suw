import { useEffect, useState } from 'react';
import { Activity, Play, Square, RefreshCw, UserPlus, Trash2, ShieldCheck, FolderOpen, ArrowRight, Check, CircleHelp, LoaderCircle } from 'lucide-react';
import type { LepaoCommand, LepaoState } from '../shared/lepao';
import { lepaoGuidance, lepaoResult, phaseNames } from './lepao-guide';
import './lepao.css';

const actionNames: Record<string, string> = { check: '环境检查', certificate: '安装当前用户证书', capture: '采集会话', dry: '干跑验证', run: '乐跑执行' };
const sessionNames = { missing: '未保存会话', available: '本地会话待平台验证', expired: '本地保留期限已到', consumed: '会话已用于提交；请核对结果，这不是失败提示', invalid: '会话保存时间无效，已清除凭据，请重新采集' };
const steps = [
  { id: 'lepao-members', title: '添加成员', description: '填写本人乐跑资料' },
  { id: 'lepao-environment', title: '准备电脑', description: '检查环境与证书' },
  { id: 'lepao-capture-step', title: '采集会话', description: '配合电脑微信登录' },
  { id: 'lepao-verify-step', title: '验证与结果', description: '验证后核对平台记录' },
];

export default function Lepao({ locked }: { locked: boolean }) {
  const [state, setState] = useState<LepaoState | null>(null);
  const [error, setError] = useState('');
  const [stateError, setStateError] = useState('');
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [proxyConsent, setProxyConsent] = useState(false);
  const [selected, setSelected] = useState('');
  const [name, setName] = useState('');
  const [student, setStudent] = useState('');
  const [school, setSchool] = useState('837');
  const [connection, setConnection] = useState(0);
  const [message, setMessage] = useState('');
  const [viewStep, setViewStep] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll(): Promise<void> {
      try {
        const result = await window.lepao.execute({ command: 'state' });
        if (!active) return;
        if (!result.ok) { setStateError(result.error.message); return; }
        setStateError('');
        setState(result.value);
        timer = setTimeout(() => void poll(), 1500);
      } catch (cause) { if (active) setStateError(cause instanceof Error ? cause.message : '乐跑状态读取失败。'); }
    }
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [connection]);

  useEffect(() => {
    if (state !== null) setSelected(current => state.members.some(member => member.key === current)
      ? current : state.members.find(member => member.active)?.key ?? state.members[0]?.key ?? '');
  }, [state]);

  async function execute(command: LepaoCommand): Promise<void> {
    setPending(true); setError(''); setMessage(''); setRemoveTarget(null);
    if (command.command === 'capture' || command.command === 'run') setProxyConsent(false);
    try {
      const result = await window.lepao.execute(command);
      if (!result.ok) { setError(result.error.message); return; }
      setState(result.value);
      if (command.command === 'add') { setName(''); setStudent(''); }
      if (command.command === 'stop') setMessage(result.value.busy ? '停止请求已发出。请等待当前调用结束和代理恢复，完成后再退出。' : result.value.proxyRecoveryNeeded ? '仍有待恢复的代理备份，请查看错误和运行记录。' : '停止检查已完成，未检测到待恢复代理备份。');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '乐跑操作失败。'); }
    finally { setPending(false); }
  }
  const busy = state?.busy === true;
  const disabled = locked || pending || busy || state === null || stateError !== '' || state.proxyRecoveryNeeded;
  const operationBlock = locked ? '查寝操作正在进行，请等待当前操作完成。' : pending ? '请求正在发送，请稍候。' : stateError ? '当前状态读取失败，请先重新读取，核实后再开始新操作。' : busy ? '已有乐跑操作正在进行，请等待完成或停止并恢复代理。' : null;
  const cap = state?.capabilities;
  const guide = lepaoGuidance(state, selected, new Date());
  const result = lepaoResult(state, selected);
  const captureBlock = guide.captureBlock ?? (!proxyConsent ? '默认不改动网络。采集前请明确允许本次临时切换系统代理。' : null);
  const recent = guide.member?.lastSubmission;
  useEffect(() => { setProxyConsent(false); setRemoveTarget(null); }, [selected]);
  useEffect(() => { if (busy || locked || stateError) { setRemoveTarget(null); setProxyConsent(false); } }, [busy, locked, stateError]);
  const currentStep = state?.proxyRecoveryNeeded && !busy ? 2 : busy && (state.action === 'check' || state.action === 'certificate') ? 2 : busy && state.action === 'run' && state.operation && ['executing', 'confirming', 'restoring'].includes(state.operation.phase) ? 4 : busy && (state.action === 'capture' || state.action === 'run') ? 3 : busy && state.action === 'dry' ? 4 : guide.step;
  const shownStep = viewStep ?? currentStep;
  useEffect(() => { setViewStep(null); }, [currentStep, selected]);
  useEffect(() => {
    const step = steps[shownStep - 1];
    if (step === undefined) throw new Error('乐跑引导步骤不存在。');
    const element = document.getElementById(step.id);
    if (element === null) throw new Error('乐跑引导区域尚未加载。');
    element.focus({ preventScroll: true });
  }, [shownStep]);
  const completed = [guide.member !== undefined, guide.environmentBlock === null, guide.member?.sessionState === 'available' || guide.hasTodaySubmission, guide.hasTodaySubmission && recent?.status === 'valid'];
  const nextTitle = state?.proxyRecoveryNeeded && !busy ? '先恢复上次的网络设置'
    : locked ? '正在进行查寝操作，请稍后继续'
    : busy && state.operation ? phaseNames[state.operation.phase] : busy ? actionNames[state.action] ?? '当前操作正在进行'
    : guide.hasTodaySubmission ? '今日已有乐跑提交记录，请先核对结果'
    : guide.step === 1 ? '先添加并选择一个乐跑成员'
    : guide.step === 2 ? '下一步：准备这台电脑'
    : guide.step === 3 ? '下一步：配合电脑微信采集会话'
    : '准备就绪：可以验证已采集的会话';
  const nextMessage = state?.proxyRecoveryNeeded && !busy ? '上次代理进程或网络设置尚未完成清理。先点击“停止并恢复代理”，完成后再继续。'
    : locked ? '查寝与乐跑操作互斥，当前操作结束后即可继续。'
    : busy ? result.message
    : guide.hasTodaySubmission ? '已有提交记录不需要重新采集来证明成功。会话已使用是正常状态，先在小程序核对，勿重复执行。'
    : guide.step === 1 ? '查寝账号不会自动带入乐跑。这里填写姓名、学号和学校编号，再选择该成员。'
    : guide.step === 2 ? guide.environmentBlock
    : guide.step === 3 ? '采集由本程序发起，再到电脑微信打开小程序；只采集会话不会提交运动记录。'
    : '先用“不提交”验证检查会话。验证完成不代表已有运动记录，最终结果需在小程序核对。';

  return <div className="lepao-view" data-testid="lepao-view">
    <section className="panel lepao-panel lepao-guide-header">
      <div className="section-header"><div><h2><Activity size={20} /> 乐跑使用引导</h2></div><span className={`tag ${busy ? 'pending-tag' : 'neutral-tag'}`} data-testid="lepao-phase">{stateError ? '状态读取失败' : !state ? '准备中' : busy && state.operation ? phaseNames[state.operation.phase] : busy ? '执行中' : '空闲'}</span></div>
      <div className="lepao-body">
        <p className="lepao-attribution">基于 dan-cun / <a href="https://github.com/dan-cun/lepao3" target="_blank" rel="noreferrer">lepao3</a> · 乐跑研究协议 1.0（LRL-1.0）· 非商业授权软件</p>
        {(stateError || error) && <div className="notice error" role="alert" data-testid="lepao-error"><div><p>{stateError || error}</p>{stateError && <p>状态更新已停止，下方保留上次读取的信息。请重新读取；若需中止，仍可请求停止并恢复代理。</p>}</div><button data-testid="lepao-reconnect" className="button secondary" disabled={locked || pending} onClick={() => { setError(''); setConnection(value => value + 1); }}>重新读取状态</button></div>}
        {!state && !stateError && !error && <p>正在启动内置乐跑引擎…</p>}
        <ol className="lepao-steps" aria-label="乐跑使用步骤" data-testid="lepao-guide">
          {steps.map((step, index) => <li key={step.id} className={index + 1 === currentStep ? 'current' : completed[index] ? 'completed' : ''} aria-current={index + 1 === currentStep ? 'step' : undefined} data-testid={`lepao-guide-step-${index + 1}`}>
            <button type="button" aria-expanded={shownStep === index + 1} aria-controls={step.id} onClick={() => setViewStep(index + 1)}><span className="lepao-step-number">{completed[index] && index + 1 !== currentStep ? <Check size={16} /> : index + 1}</span><span><strong>{step.title}</strong><small>{step.description}</small></span></button>
          </li>)}
        </ol>
        {(locked || state?.proxyRecoveryNeeded && !busy || shownStep !== currentStep) && <div className="lepao-next" data-testid="lepao-next" aria-live="polite">
          <div><h3>{busy && <LoaderCircle size={18} className="spin" />}{nextTitle}</h3><p>{nextMessage}</p></div>
          {state?.proxyRecoveryNeeded && !busy && <button className="button primary" disabled={locked || pending} onClick={() => void execute({ command: 'stop' })}>停止并恢复代理</button>}
          {!busy && shownStep !== currentStep && <button data-testid="lepao-next-action" className="button secondary" onClick={() => setViewStep(null)}>返回当前步骤<ArrowRight size={16} /></button>}
        </div>}
        {(busy || stateError !== '' && state !== null) && <button data-testid="lepao-stop" className="button secondary lepao-stop" disabled={locked || pending} onClick={() => void execute({ command: 'stop' })}><Square size={16} />停止并恢复代理</button>}
        {message && <p role="status" data-testid="lepao-action-message">{message}</p>}
        <div className="lepao-toolbar"><label>本次成员 <select data-testid="lepao-member" value={selected} disabled={disabled || state?.members.length === 0} onChange={event => setSelected(event.target.value)}><option value="">请选择成员</option>{state?.members.map(member => <option key={member.key} value={member.key}>{member.label} · {member.student}</option>)}</select></label></div>
        <p data-testid="lepao-member-hint">{guide.member ? `已选择 ${guide.member.label}，请使用对应账号登录小程序。` : '乐跑使用独立资料。添加后自动选择成员，可在此切换。'}</p>
        {guide.member && <p data-testid="lepao-session-state">{sessionNames[guide.member.sessionState]}{guide.member.sessionState === 'available' && guide.member.expiresAt && ` · 本地保留截止 ${new Date(guide.member.expiresAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`}</p>}
        <label className="lepao-proxy-consent"><input data-testid="lepao-proxy-consent" type="checkbox" checked={proxyConsent} disabled={disabled} onChange={event => setProxyConsent(event.target.checked)} /><span>允许本次采集临时切换 Windows 系统代理，结束后核对恢复。<small>默认关闭，每次采集单独选择；不修改 Clash 等代理软件的节点、规则、订阅或自启动设置。不勾选仍可查看记录和验证已保存会话。</small></span></label>
        {recent && <div className="lepao-result-card" data-testid="lepao-recent-submission"><strong>最近提交 · {recent.status === 'valid' ? '平台曾确认有效' : recent.status === 'invalid' ? '平台返回无效' : '结果待核对'}</strong><p>{new Date(recent.submittedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}{recent.distanceKm !== null && ` · ${recent.distanceKm.toFixed(2)} 公里`}{recent.durationSeconds !== null && ` · ${Math.floor(recent.durationSeconds / 60)} 分 ${Math.floor(recent.durationSeconds % 60)} 秒`}</p><small>这是本机保存的上次平台结果，重启后保留，不代表实时查询；最终记录请在小程序核对。</small></div>}
        {state?.operation && <div className="lepao-result-card" data-testid="lepao-result" role="status"><strong>{result.title}</strong><p>{result.message}</p>{result.context && <small data-testid="lepao-result-context">{result.context}</small>}</div>}
      </div>
    </section>
    <section className="panel lepao-panel lepao-step-section" id="lepao-members" hidden={shownStep !== 1} tabIndex={-1}>
      <div className="section-header"><div><h2><span className="lepao-step-number">1</span>添加并选择成员</h2><p>填写本人的乐跑资料，姓名用于本机辨认，学号与学校须对应小程序里的账号。</p></div></div>
      <div className="lepao-body">
        <form className="lepao-member-form" onSubmit={event => { event.preventDefault(); void execute({ command: 'add', name, student, school: Number(school) }); }}>
          <label>姓名或称呼<input data-testid="lepao-name" value={name} maxLength={80} disabled={disabled} onChange={event => setName(event.target.value)} required /></label>
          <label>本人学号<input data-testid="lepao-student" value={student} pattern="[A-Za-z0-9_-]{3,40}" disabled={disabled} onChange={event => setStudent(event.target.value)} required /></label>
          <label>学校编号<input data-testid="lepao-school" type="number" min="1" max="100000" value={school} disabled={disabled} onChange={event => setSchool(event.target.value)} required /></label>
          <button data-testid="lepao-add" className="button primary" type="submit" disabled={disabled}><UserPlus size={16} />添加成员</button>
        </form>
        <p className="lepao-help">学校编号与学号不同。837 仅沿用上游配置，尚未验证其学校对应关系，请按本人小程序资料核对；查寝登录信息不会自动填入。</p>

      </div>
    </section>
    <section className="panel lepao-panel lepao-step-section" id="lepao-environment" hidden={shownStep !== 2} tabIndex={-1}>
      <div className="section-header"><div><h2><span className="lepao-step-number">2</span>准备这台电脑</h2><p>先检查本机环境；首次使用时，再按检测结果安装证书。</p></div></div>
      <div className="lepao-body">
        <div className="lepao-capabilities" data-testid="lepao-capabilities">
          <span>代理引擎：{cap ? cap.proxyReady ? '就绪' : '不可用' : '待检查'}</span>
          <span>电脑微信：{cap ? cap.wechatFound ? '已找到' : '未找到' : '待检查'}</span>
          <span>当前用户证书：{cap ? cap.certificateTrusted ? '已信任' : '未信任' : '待检查'}</span>
          <span>出口：{cap ? cap.upstreamMode === 'direct' ? '本机直连' : cap.upstreamReady ? '沿用系统代理' : '系统代理不可达' : '待检查'}</span>
        </div>
        {cap && !cap.certificateTrusted && <p>{cap.certificatePresent ? '本应用的代理证书已生成，尚未被当前用户信任。' : '首次采集前，需要生成并信任本应用的代理证书。'}点击“安装证书”将其加入当前 Windows 用户的受信任根证书库。</p>}
        {state?.proxyRecoveryNeeded && !busy && <p role="alert">代理进程或网络设置尚未恢复，请点击“停止并恢复代理”核对并处理。</p>}
        <div className="lepao-toolbar">
          <button data-testid="lepao-check" className={`button ${!cap || cap.certificateTrusted ? 'primary' : 'secondary'}`} disabled={disabled} onClick={() => void execute({ command: 'check' })}><RefreshCw size={16} />检查本机环境</button>
          <button data-testid="lepao-certificate" className={`button ${cap && !cap.certificateTrusted ? 'primary' : 'secondary'}`} disabled={disabled || !cap || !cap.proxyReady || !cap.licenseValid || cap.certificateTrusted} onClick={() => void execute({ command: 'certificate' })}><ShieldCheck size={16} />安装证书</button>
          <button data-testid="lepao-data" className="button secondary" disabled={locked || pending} onClick={() => { void window.desktop.openDataFolder().then(result => { if (!result.ok) setError(result.error.message); }).catch(cause => setError(cause instanceof Error ? cause.message : '打开数据目录失败。')); }}><FolderOpen size={16} />数据目录</button>
        </div>
        <p>电脑微信需已安装并登录。若检查未找到微信，可先打开电脑微信，再重新检测；手机微信不能替代本机采集。</p>
        {cap && !cap.licenseValid && <p role="alert">随包声明文件校验未通过，请重新安装完整安装包。</p>}
        {guide.environmentBlock && <p className="lepao-block-reason" data-testid="lepao-environment-reason">{guide.environmentBlock}</p>}
        <details className="lepao-faq" data-testid="lepao-certificate-help"><summary><CircleHelp size={16} />为什么需要证书与代理？</summary><p>采集时本程序会临时调整当前用户的系统代理，读取乐跑登录会话；结束后恢复。安装证书会将本应用证书加入当前 Windows 用户的受信任根证书库。确认这是你信任的程序后，再点击上方安装。</p><p>证书通常每台电脑准备一次；登录会话可能过期或被使用，每次使用前仍需核对成员状态。</p></details>
      </div>
    </section>
    <section className="panel lepao-panel lepao-step-section" id="lepao-capture-step" hidden={shownStep !== 3} tabIndex={-1}>
      <div className="section-header"><div><h2><span className="lepao-step-number">3</span>采集登录会话</h2><p>使用电脑微信，按下面顺序完成；本步骤不提交运动记录。</p></div></div>
      <div className="lepao-body">
        <ol className="lepao-instructions">
          <li><strong>在这里开始采集</strong><span>确认成员无误，并明确允许本次临时切换系统代理后，点击“开始采集登录会话”。</span></li>
          <li><strong>让电脑微信使用新代理</strong><span>等上方显示“等待电脑微信登录”后，若微信此前已打开，先从微信菜单正常退出再重开。打开“数体智慧体育 → 校园乐跑”，使用对应成员账号；不用点击“开始乐跑”。</span></li>
          <li><strong>回到这里等待结果</strong><span>看到“会话采集完成”后，再进入第 4 步。等待期间不用反复点击采集。</span></li>
        </ol>
        <div className="lepao-action-row"><button data-testid="lepao-capture" className="button primary" aria-describedby="lepao-capture-reason" disabled={disabled || captureBlock !== null} onClick={() => void execute({ command: 'capture', member: selected, allowSystemProxy: true })}>开始采集登录会话<ArrowRight size={16} /></button><span id="lepao-capture-reason" data-testid="lepao-capture-reason">{operationBlock ?? captureBlock ?? '成员和本机条件已准备好，可以开始采集。'}</span></div>
        <details className="lepao-faq"><summary><CircleHelp size={16} />一直没有采集到会话怎么办？</summary><p>先确认使用的是这台电脑上的微信。采集前已打开的微信可能仍使用旧代理，应从微信菜单正常退出再重开；只关闭小程序窗口可能不够。小程序账号应与所选成员一致。检查第 2 步的证书和网络，再查看下方运行记录。若已结束并显示超时，可重新开始一次采集后再进入小程序。</p><p>需要中止时，点击页面上方“停止并恢复代理”，等代理恢复完成后再关闭程序。</p></details>
      </div>
    </section>
    <section className="panel lepao-panel lepao-step-section" id="lepao-verify-step" hidden={shownStep !== 4} tabIndex={-1}>
      <div className="section-header"><div><h2><span className="lepao-step-number">4</span>验证会话并核对结果</h2><p>先验证当前会话；不同操作的“成功”含义会在下方分别说明。</p></div></div>
      <div className="lepao-body">
        <div className="lepao-action-row"><button data-testid="lepao-dry" className="button primary" aria-describedby="lepao-dry-reason" disabled={disabled || guide.dryBlock !== null} onClick={() => void execute({ command: 'dry', member: selected })}>验证当前会话 · 不提交</button><span id="lepao-dry-reason" data-testid="lepao-dry-reason">{operationBlock ?? guide.dryBlock ?? '读取平台配置与额度；不改系统代理，不上传或提交运动记录。'}</span></div>

        <details className="lepao-faq lepao-full-run" data-testid="lepao-full-run">
          <summary><Play size={16} />完整执行入口 · 会向平台提交</summary>
          <p>完整执行会重新采集登录会话，然后执行并提交，需要再次配合电脑微信。开始后按运行记录提示操作；进入执行阶段后，等待结束再操作小程序。</p>
          <p>“采集完成”和“不提交验证完成”都不代表已有运动记录。完整执行后，到小程序“我的跑步”查看最终记录；待复核时先核对，避免重复执行。</p>
          <button data-testid="lepao-run" className="button secondary" disabled={disabled || captureBlock !== null} onClick={() => void execute({ command: 'run', member: selected, allowSystemProxy: true })}><Play size={16} />采集并完整执行 · 会提交</button>
          {captureBlock && <p className="lepao-block-reason">{captureBlock}</p>}
        </details>
      </div>
    </section>
    <details className="panel lepao-panel lepao-maintenance" data-testid="lepao-privacy"><summary>会话与采集文件 · 按需维护</summary>
      <div className="section-header"><div><h2>会话与采集文件</h2><p>配置、会话及本地执行记录使用 Windows 当前用户加密。</p></div><ShieldCheck size={21} /></div>
      <div className="lepao-body">
        <p>会话本地最多保留 24 小时，使用后清除。平台可提前令其失效；本地有会话不代表平台仍接受。</p>

        <p data-testid="lepao-raw-files">待清理采集文件 {state?.privacy?.rawFiles ?? 0} 个 · {state?.privacy?.rawBytes ?? 0} 字节。采集结束后自动清理；正常采集不保存原始流量文件。</p>
        <p>清除会话保留成员资料；删除成员同时清除其会话、可归属的执行记录及共享采集材料。代理证书单独保留。</p>
        <div className="lepao-toolbar"><button data-testid="lepao-activate" className="button secondary" disabled={disabled || !selected} onClick={() => void execute({ command: 'activate', member: selected })}>设为默认成员</button><button data-testid="lepao-forget" className="button secondary" disabled={disabled || !selected} onClick={() => void execute({ command: 'forget', member: selected })}>清除所选会话</button><button data-testid="lepao-remove" className="button secondary" disabled={disabled || !selected} onClick={() => setRemoveTarget(selected)}><Trash2 size={16} />删除所选成员</button><button data-testid="lepao-cleanup" className="button secondary" disabled={disabled} onClick={() => void execute({ command: 'cleanup' })}>清理采集文件</button></div>
        {removeTarget === selected && guide.member && <div className="lepao-result-card" role="group" aria-labelledby="lepao-remove-title" data-testid="lepao-remove-confirmation"><strong id="lepao-remove-title">确认删除 {guide.member.label}？</strong><p>将删除该成员的本机资料、会话和本地执行记录，并清理共享采集文件；此操作不可撤销。平台上的运动记录不会被删除。</p><div className="lepao-toolbar"><button data-testid="lepao-remove-cancel" className="button secondary" autoFocus onClick={() => setRemoveTarget(null)}>取消</button><button data-testid="lepao-remove-confirm" className="button secondary" disabled={disabled} onClick={() => void execute({ command: 'remove', member: selected })}>确认删除成员及本地记录</button></div></div>}
      </div>
    </details>
    <details className="panel lepao-panel lepao-maintenance" data-testid="lepao-log-panel"><summary>运行记录 · 排查时展开</summary><div className="section-header"><div><h2>乐跑运行记录</h2><p>仅显示本次后台进程的脱敏日志；凭据和抓取数据保存在本机独立目录。</p></div></div><div className="lepao-body lepao-logs" data-testid="lepao-logs">{state?.logs.map(entry => <div key={entry.id} className={`log-row log-${entry.level}`}><time>{new Date(entry.time).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}</time><span className="log-level">{entry.level === 'error' ? '错误' : entry.level === 'warning' ? '注意' : '信息'}</span><p>{entry.message}</p></div>)}</div></details>
  </div>;
}
