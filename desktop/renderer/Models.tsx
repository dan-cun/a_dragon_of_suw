import { useEffect, useState } from 'react';
import { Bot, Plus, Save, Trash2 } from 'lucide-react';
import { modelProtocols, modelsCommandSchema, providerMetadataSchema, type ModelsCommand, type ModelsState, type PublicModelProvider } from '../shared/models';
import PiAssistance from './PiAssistance';
import PiChat from './PiChat';
import './modules.css';

function newProvider(): PublicModelProvider {
  return { id: crypto.randomUUID(), name: '', protocol: 'openaiChatCompletions', baseUrl: '', modelId: '', timeoutSeconds: 120, contextWindow: null, maxTokens: null, vision: null, tools: null, hasApiKey: false, headerNames: [], hasPayloadParameters: false };
}
export default function Models() {
  const [state, setState] = useState<ModelsState | null>(null);
  const [form, setForm] = useState(newProvider);
  const [apiKey, setApiKey] = useState('');
  const [headers, setHeaders] = useState('');
  const [payload, setPayload] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [piDraft, setPiDraft] = useState({ text: '', revision: 0 });
  function updatePiDraft(text: string): void { setPiDraft(current => ({ text, revision: current.revision + 1 })); }
  useEffect(() => {
    let mounted = true;
    window.models.execute({ command: 'state' }).then(result => { if (mounted) { if (result.ok) setState(result.value); else setError(result.error.message); } }).catch((cause: unknown) => { if (mounted) setError(cause instanceof Error ? cause.message : '读取模型配置失败。'); });
    return () => { mounted = false; };
  }, []);
  function select(provider: PublicModelProvider): void { setForm(provider); setApiKey(''); setHeaders(''); setPayload(''); setError(''); setMessage(''); }
  async function execute(command: ModelsCommand): Promise<void> {
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await window.models.execute(command);
      if (!result.ok) { setError(result.error.message); return; }
      setState(result.value); setApiKey(''); setHeaders(''); setPayload('');
      const saved = result.value.providers.find(value => value.id === form.id);
      setForm(saved ?? newProvider());
      setMessage(command.command === 'save' ? '配置已校验并加密保存。本次保存未发送模型请求。' : '配置已更新。');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '模型配置操作失败。'); }
    finally { setBusy(false); }
  }
  async function save(): Promise<void> {
    const { hasApiKey: _key, headerNames: _headers, hasPayloadParameters: _payload, ...metadata } = form;
    const checked = providerMetadataSchema.safeParse(metadata);
    if (!checked.success) { setError('请检查名称、模型 ID、接口地址和数值范围。接口地址须为 HTTPS，本机服务可用 HTTP；地址中不要包含密钥。'); return; }
    try {
      const advancedHeaders: unknown = headers.trim() ? JSON.parse(headers) : undefined;
      const advancedPayload: unknown = payload.trim() ? JSON.parse(payload) : undefined;
      const command = modelsCommandSchema.safeParse({ command: 'save', provider: { ...checked.data, ...(apiKey ? { apiKey } : {}), ...(advancedHeaders === undefined ? {} : { headers: advancedHeaders }), ...(advancedPayload === undefined ? {} : { payloadParameters: advancedPayload }) } });
      if (!command.success) { setError('自定义请求头或参数格式无效。不得覆盖模型、对话、工具或流式协议字段；请求头不得包含换行。'); return; }
      await execute(command.data);
    } catch { setError('请求头与请求参数必须是合法 JSON 对象。'); }
  }
  const saved = state?.providers.some(value => value.id === form.id) === true;
  return <div className="module-page" data-testid="models-page">
    <section className="panel module-panel"><div className="module-heading"><Bot size={28} /><div><h2>Pi 助手</h2><p>模型配置、原生诊断会话与使用教程</p></div></div><p className="module-description">模型配置与诊断会话分别管理。保存配置不会发送模型请求；原生会话的实时状态见下方会话区。默认诊断仅分析本人提供的脱敏文本，无工具。本人明确启用受控 OCS 联动且所选服务商声明支持工具时，可读取最小 OCS 概览，并申请启动、聚焦或停止已保存浏览器；每项动作均需本人逐次确认。Pi 不提供登录、课程或学校提交工具。</p></section>
    <PiChat providers={state?.providers ?? []} text={piDraft.text} draftRevision={piDraft.revision} onTextChange={updatePiDraft} />
    <PiAssistance modelCount={state?.providers.length ?? null} onUsePrompt={updatePiDraft} />
    <section className="panel module-panel"><div className="module-heading"><h2>模型配置</h2><button className="button secondary" data-testid="model-deepseek-preset" disabled={busy} onClick={() => { select({ ...newProvider(), name: 'DeepSeek API', protocol: 'openaiChatCompletions', baseUrl: 'https://api.deepseek.com', modelId: 'deepseek-flash' }); setMessage('已新建 DeepSeek 推荐草稿，请本人填写 API Key 后校验并保存；尚未保存或发送请求。'); }}>新建 DeepSeek 推荐配置</button><button className="button secondary" data-testid="model-new" disabled={busy} onClick={() => select(newProvider())}><Plus size={15} />新增其他配置</button></div><p className="module-description">优先推荐本人申请的 DeepSeek 等国产模型 API，无需部署模型权重；不限制厂商或地区，也可通过「新增其他配置」按兼容协议配置其他服务。是否可用取决于本应用已实现的适配器及服务商实际接口，不保证所有模型支持视觉或工具；未知能力保持未知；默认会话仅文本诊断。只有服务商明确支持工具且本人启用联动时，才开放受逐次审批限制的 OCS 浏览器动作。推荐按钮仅填写 DeepSeek 公开字段，不填写密钥、不自动保存或调用。<a href="https://api-docs.deepseek.com/" target="_blank" rel="noreferrer" title="DeepSeek 官方列出当前 API 根地址与 deepseek-flash、deepseek-v4-pro 模型名">DeepSeek 官方配置说明 ↗</a></p><div className="model-list" data-testid="model-list">{state?.providers.map(provider => <button key={provider.id} className={provider.id === form.id ? 'selected' : ''} data-testid={`model-select-${provider.id}`} onClick={() => select(provider)} disabled={busy}>{provider.name}<small>{provider.modelId} · {provider.hasApiKey ? '已保存密钥' : '未保存密钥'}</small></button>)}{state?.providers.length === 0 && <p data-testid="models-empty">尚未添加模型。</p>}</div>
      <form className="model-form" onSubmit={event => { event.preventDefault(); void save(); }}>
        <label>配置名称<input data-testid="model-name" value={form.name} maxLength={80} disabled={busy} onChange={event => setForm({ ...form, name: event.target.value })} /></label>
        <label>接口协议<select data-testid="model-protocol" value={form.protocol} disabled={busy} onChange={event => setForm({ ...form, protocol: event.target.value as PublicModelProvider['protocol'] })}>{modelProtocols.map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></label>
        <label className="model-wide">接口地址<input data-testid="model-base-url" value={form.baseUrl} disabled={busy} placeholder="https://接口服务地址/v1" onChange={event => setForm({ ...form, baseUrl: event.target.value })} /></label>
        <label>模型 ID<input data-testid="model-id" value={form.modelId} disabled={busy} onChange={event => setForm({ ...form, modelId: event.target.value })} /></label>
        <label>API Key<input data-testid="model-api-key" type="password" autoComplete="new-password" value={apiKey} disabled={busy} placeholder={form.hasApiKey ? '已保存；留空保留原密钥' : '仅保存在本机 Windows 加密存储'} onChange={event => setApiKey(event.target.value)} /></label>
        <details className="model-wide model-advanced"><summary data-testid="model-advanced">高级配置与能力标记</summary><div className="model-form"><label>请求超时（秒）<input data-testid="model-timeout" type="number" min="5" max="600" value={form.timeoutSeconds} onChange={event => setForm({ ...form, timeoutSeconds: Number(event.target.value) })} /></label><label>上下文上限（未知留空）<input data-testid="model-context" type="number" value={form.contextWindow ?? ''} onChange={event => setForm({ ...form, contextWindow: event.target.value ? Number(event.target.value) : null })} /></label><label>输出上限（未知留空）<input data-testid="model-max-tokens" type="number" value={form.maxTokens ?? ''} onChange={event => setForm({ ...form, maxTokens: event.target.value ? Number(event.target.value) : null })} /></label>{(['vision', 'tools'] as const).map(field => <label key={field}>{field === 'vision' ? '图片输入' : '工具调用'}<select data-testid={`model-${field}`} value={form[field] === null ? 'unknown' : String(form[field])} onChange={event => setForm({ ...form, [field]: event.target.value === 'unknown' ? null : event.target.value === 'true' })}><option value="unknown">未知</option><option value="true">支持</option><option value="false">不支持</option></select></label>)}<label className="model-wide">请求头 JSON（已保存值不回显，留空保留）<textarea data-testid="model-headers" value={headers} onChange={event => setHeaders(event.target.value)} placeholder={form.headerNames.length ? `已保存字段：${form.headerNames.join(', ')}` : '{}'} /></label><label className="model-wide">额外请求参数 JSON（留空保留）<textarea data-testid="model-payload" value={payload} onChange={event => setPayload(event.target.value)} placeholder={form.hasPayloadParameters ? '已保存额外参数' : '{}'} /></label></div></details>
        <div className="module-actions model-wide"><button className="button primary" type="submit" data-testid="model-save" disabled={busy || !state}><Save size={16} />校验并保存</button><button className="button secondary" type="button" data-testid="model-forget-key" disabled={busy || !saved || !(form.hasApiKey || form.headerNames.length)} onClick={() => void execute({ command: 'forget-key', id: form.id })}>忘记密钥与请求头</button><button className="button secondary" type="button" data-testid="model-remove" disabled={busy || !saved} onClick={() => void execute({ command: 'remove', id: form.id })}><Trash2 size={16} />删除配置</button></div>
      </form>{error && <p role="alert" className="module-error" data-testid="model-error">{error}</p>}{message && <p role="status" className="module-description" data-testid="model-result">{message}</p>}
    </section>
  </div>;
}
