import { useEffect, useRef, useState } from 'react';
import type { PublicModelProvider } from '../shared/models';
import { piStateSchema, type PiCommand, type PiState } from '../shared/pi';

interface PiChatProps { providers: readonly PublicModelProvider[]; text: string; draftRevision: number; onTextChange: (text: string) => void }
const phaseLabels: Record<PiState['phase'], string> = { stopped: '已停止', starting: '正在启动', ready: '会话已准备（非连通证明）', running: '正在请求模型', error: '会话错误' };
const approvalActionLabels: Record<NonNullable<PiState['approval']>['action'], string> = {
  'browser-start': '启动浏览器',
  'browser-stop': '停止浏览器',
  'browser-focus': '聚焦浏览器',
};

/** Render the native diagnostic session using public, validated state only. */
export default function PiChat({ providers, text, draftRevision, onTextChange }: PiChatProps) {
  const [state, setState] = useState<PiState | null>(null);
  const [providerId, setProviderId] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [confirmedToolResults, setConfirmedToolResults] = useState(false);
  const [ocsToolsEnabled, setOcsToolsEnabled] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [fresh, setFresh] = useState(false);
  const epoch = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { setConfirmed(false); setConfirmedToolResults(false); }, [text, draftRevision, providerId, state?.model?.providerId, ocsToolsEnabled]);
  useEffect(() => {
    mounted.current = true;
    void execute({ command: 'state' });
    return () => { mounted.current = false; epoch.current += 1; };
  }, []);
  useEffect(() => {
    if (!state?.busy || pending || !fresh) return;
    let cancelled = false;
    const generation = epoch.current;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const result = await window.pi.execute({ command: 'state' });
          if (cancelled || !mounted.current || generation !== epoch.current) return;
          if (!result.ok) throw new Error(result.error.message);
          setState(piStateSchema.parse(result.value));
        } catch (cause) {
          if (cancelled || !mounted.current || generation !== epoch.current) return;
          setFresh(false);
          setError(cause instanceof Error ? cause.message : '读取 Pi 实时状态失败，请手动刷新；不会重试发送。');
        }
      })();
    }, 700);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [state, pending, fresh]);
  async function execute(command: PiCommand): Promise<void> {
    const generation = ++epoch.current;
    setPending(true); setError('');
    if (command.command !== 'state') setConfirmed(false);
    try {
      if (!window.pi || typeof window.pi.execute !== 'function') throw new Error('当前应用没有接入 Pi 会话桥接，请更新应用；未发送模型请求。');
      const result = await window.pi.execute(command);
      if (!mounted.current || generation !== epoch.current) return;
      if (!result.ok) throw new Error(result.error.message);
      setState(piStateSchema.parse(result.value)); setFresh(true);
    } catch (cause) {
      if (!mounted.current || generation !== epoch.current) return;
      setFresh(false); setConfirmed(false);
      setError(cause instanceof Error ? cause.message : 'Pi 操作失败，请检查当前状态；不会自动重试。');
    } finally { if (mounted.current && generation === epoch.current) setPending(false); }
  }
  const selectedProvider = providers.find(provider => provider.id === providerId);
  const selected = selectedProvider !== undefined;
  const canSend = selected && fresh && !pending && state?.phase === 'ready' && !state.busy && state.model?.providerId === providerId && text.trim().length > 0 && text.length <= 16000 && confirmed && (!ocsToolsEnabled || confirmedToolResults);
  return <section className="panel module-panel pi-chat" data-testid="pi-chat">
    <div className="module-heading"><div><h2>原生 Pi 会话</h2><p>{ocsToolsEnabled ? '受控 OCS 工具 · 每项动作逐次审批' : '本人发送 · 仅文本诊断 · 无执行工具'}</p></div><span className="module-badge" data-testid="pi-status">{fresh && state ? phaseLabels[state.phase] : '实时状态未确认'}</span></div>
    <p className="module-description">本应用使用官方 Pi Agent 核心引擎与模型 SDK，不安装独立 coding-agent CLI。选择已保存配置后启动内存会话。启动不发送模型请求，不代表鉴权或连通性验证。本人确认并点击发送后，对话会发送给所选服务商，可能计费；费用未知。默认诊断模式没有执行工具。可选启用受控 OCS 联动，但仅当所选服务商能力明确为 tools=true；只开放最小概览及已保存浏览器的启动、停止、聚焦，动作逐次等待本机审批。不会导航、登录、填表、访问课程或提交学校记录。服务商能力及配置应本人预先核实。</p>
    <div className="model-form"><label className="model-wide">本次使用的已保存模型<select data-testid="pi-provider" value={providerId} disabled={pending || state?.busy} onChange={event => { setProviderId(event.target.value); setConfirmed(false); setConfirmedToolResults(false); }}><option value="">请明确选择模型</option>{providers.map(provider => <option key={provider.id} value={provider.id}>{provider.name} · {provider.modelId}</option>)}</select></label></div>
    <label className="pi-chat-consent"><input data-testid="pi-ocs-enabled" type="checkbox" checked={ocsToolsEnabled} disabled={pending || state?.busy || selectedProvider?.tools !== true} onChange={event => { setOcsToolsEnabled(event.target.checked); setConfirmed(false); setConfirmedToolResults(false); }} />启动时启用受控 OCS 联动（需要服务商明确声明 tools=true；每项浏览器动作仍需单独审批）</label>
    <div className="module-actions pi-chat-actions"><button className="button secondary" type="button" data-testid="pi-start" disabled={!fresh || !selected || (ocsToolsEnabled && selectedProvider?.tools !== true) || pending || state?.busy} onClick={() => void execute({ command: 'start', providerId, ocsToolsEnabled })}>启动会话（不调用模型）</button><button className="button secondary" type="button" data-testid="pi-refresh" disabled={pending} onClick={() => void execute({ command: 'state' })}>刷新状态</button><button className="button secondary" type="button" data-testid="pi-stop" disabled={pending || state?.phase === 'starting'} onClick={() => void execute({ command: 'stop' })}>停止会话 / 取消请求</button><button className="button secondary" type="button" data-testid="pi-clear" disabled={pending || state?.busy} onClick={() => { setConfirmed(false); setConfirmedToolResults(false); void execute({ command: 'clear' }); }}>清空内存会话</button></div>
    {state?.approval && <section className="pi-ocs-approval" aria-live="assertive" data-testid="pi-ocs-approval"><h3>Pi 请求本机 OCS 动作审批</h3><p>动作：{approvalActionLabels[state.approval.action]}；目标资料 ID：<code>{state.approval.browserId}</code></p><p>工具调用 ID：<code>{state.approval.toolCallId}</code> · 本机请求编号：<code>{state.approval.approvalId}</code></p><p>宿主风险说明：{state.approval.risk}</p><p>此为一次性动作确认，不会授权后续动作；拒绝、停止会话或等待超时均不会执行。</p><div className="module-actions"><button className="button primary" type="button" data-testid="pi-ocs-approve" disabled={!fresh || pending || !state.busy} onClick={() => void execute({ command: 'approval', approvalId: state.approval!.approvalId, approved: true })}>只批准此项动作</button><button className="button secondary" type="button" data-testid="pi-ocs-deny" disabled={!fresh || pending || !state.busy} onClick={() => void execute({ command: 'approval', approvalId: state.approval!.approvalId, approved: false })}>拒绝此项动作</button></div></section>}
    {state && <p data-testid="pi-runtime-info">后端报告：{state.runtime} · SDK {state.sdkVersion} · {state.mode} · 工具 {state.tools.length} · 费用未知。{state.model ? `会话模型：${state.model.name} / ${state.model.modelId}（${state.model.protocol}）` : '尚无会话模型。'}{!fresh && '以上为上次状态，不代表当前实时状态。'}</p>}
    {pending && <p role="status" data-testid="pi-pending">正在处理本机会话操作，请稍候。</p>}
    {error && <p className="module-error" role="alert" data-testid="pi-error">{error}</p>}
    {state?.lastError && <p className="module-error" role="alert" data-testid="pi-runtime-error">{state.lastError}</p>}
    <div className="pi-chat-messages" data-testid="pi-messages" aria-live="polite">{state?.messages.map(message => <article key={message.id} data-testid={`pi-message-${message.id}`}><strong>{message.role === 'user' ? '本人' : 'Pi'}</strong><p>{message.text || '等待模型文本…'}</p></article>)}</div>
    <div className="model-form"><label className="model-wide">诊断草稿（最多 16000 字符）<textarea data-testid="pi-draft" value={text} maxLength={16000} disabled={pending || state?.busy} onChange={event => { setConfirmed(false); onTextChange(event.target.value); }} placeholder="只输入本人审阅过的脱敏问题，不要填写密钥、账号、Cookie 或课程隐私。" /></label></div>
    <label className="pi-chat-consent"><input data-testid="pi-send-confirmed" type="checkbox" checked={confirmed} disabled={pending || state?.busy || !text.trim()} onChange={event => setConfirmed(event.target.checked)} />我已检查草稿不含隐私，同意把本次对话发送给所选模型服务商，并理解可能计费。</label>
    {ocsToolsEnabled && <label className="pi-chat-consent"><input data-testid="pi-tool-results-confirmed" type="checkbox" checked={confirmedToolResults} disabled={pending || state?.busy || !text.trim()} onChange={event => setConfirmedToolResults(event.target.checked)} />我明确同意将本轮产生的最小 OCS 工具结果继续发送给所选模型服务商；这不代表批准任何 OCS 动作。</label>}
    <div className="module-actions"><button className="button primary" type="button" data-testid="pi-send" disabled={!canSend} onClick={() => void execute({ command: 'prompt', text: text.trim(), confirmed: true, confirmedToolResults: ocsToolsEnabled && confirmedToolResults })}>确认发送诊断问题</button><button className="button secondary" type="button" data-testid="pi-draft-clear" disabled={pending || state?.busy} onClick={() => { setConfirmed(false); setConfirmedToolResults(false); onTextChange(''); }}>清空草稿</button></div>
    <p>任意草稿或模型变化均需重新确认；模型回复仅为建议，不是已操作证明。停止不保证服务商未计费；清空仅清除本应用内存会话，不撤回服务商记录、草稿或剪贴板。离开此页不停止后台会话，需要时请先停止。</p>
  </section>;
}
