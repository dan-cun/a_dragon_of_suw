import { useState } from 'react';
import { CheckCircle2, CircleHelp, Code, FolderOpen, ListChecks, MonitorPlay, RefreshCw, ScrollText, Settings2, Square, XCircle } from 'lucide-react';
import { BrowserManager } from './OcsBrowserManager';
import { Resources } from './OcsResources';
import { Settings } from './OcsSettings';
import { Logs } from './OcsLogs';
import { formatTime } from './OcsTypes';
import type { Confirmation } from './OcsTypes';
import { useOcsController } from './OcsController';
import './ocs.css';

const tabs = [
  { id: 'browsers', label: '浏览器', icon: MonitorPlay },
  { id: 'scripts', label: '用户脚本', icon: Code },
  { id: 'extensions', label: '扩展资源', icon: FolderOpen },
  { id: 'settings', label: '设置', icon: Settings2 },
  { id: 'logs', label: '日志', icon: ScrollText },
  { id: 'capabilities', label: '能力说明', icon: ListChecks }
] as const;
type Tab = typeof tabs[number]['id'];

export default function Ocs() {
  const { state, busy, refreshing, error, updatedAt, execute, refresh } = useOcsController();
  const [tab, setTab] = useState<Tab>('browsers');
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const disabled = busy || !!error || !state;
  const activeCount = state?.browsers.filter(browser => browser.owned).length ?? 0;
  const confirmationDisabled = disabled || !!state?.browsers.some(browser => browser.owned && confirmation?.command.command === 'browser-delete' && confirmation.command.id === browser.id);
  async function confirmOperation(): Promise<void> {
    if (confirmation && !confirmationDisabled && await execute(confirmation.command)) setConfirmation(null);
  }

  return <div className="ocs-page" data-testid="ocs-page" aria-busy={busy}>
    <section className="panel ocs-header">
      <div className="ocs-heading"><div className="ocs-heading-icon"><MonitorPlay size={24} /></div><div className="ocs-grow"><h2>OCS 网课助手</h2><p>官方源码适配 · 统一管理 · v{state?.version ?? '2.12.0'}</p></div><span className={`ocs-phase ${state?.phase === 'ready' ? 'running' : 'stopped'}`} data-testid="ocs-phase">{state?.phase === 'ready' ? '源码服务就绪' : state?.phase === 'unavailable' ? '浏览器不可用' : '读取中'}</span></div>
      <p className="ocs-message" data-testid="ocs-message">{state?.message ?? '正在读取本机 OCS 源码服务状态…'}</p>
      <div className="ocs-header-summary"><span>{state?.browsers.length ?? 0} 个浏览器</span><span>{activeCount} 个活动实例</span><span>{state?.userScripts.filter(script => script.enabled).length ?? 0} 个启用脚本</span><span data-testid="ocs-updated">{updatedAt ? `最近读取 ${formatTime(updatedAt)}` : '尚未取得状态'}</span></div>
      <div className="ocs-actions"><button type="button" className="button secondary" data-testid="ocs-refresh" disabled={busy || refreshing} onClick={() => void refresh()}><RefreshCw size={16} />{busy ? '正在处理…' : refreshing ? '正在读取…' : error ? '重新读取并恢复刷新' : '刷新状态'}</button><button type="button" className="button secondary" data-testid="ocs-browsers-stop" disabled={disabled || activeCount === 0} onClick={() => setConfirmation({ title: '停止全部 OCS 浏览器？', description: `将请求停止当前 ${activeCount} 个活动实例，正在进行的网课页面操作可能中断。不会删除浏览器资料；中断后的课程结果需要自行核对。`, command: { command: 'browsers-stop' } })}><Square size={15} />停止全部浏览器</button><button type="button" className="button secondary" data-testid="ocs-data" disabled={busy || !state || !!error} onClick={() => void execute({ command: 'data' })}><FolderOpen size={16} />数据目录</button></div>
      {error && <div className="ocs-error ocs-refresh-error" role="alert" data-testid="ocs-error"><strong>自动刷新已停止</strong><p>{error}</p><p>已保留上次结果。请手动重新读取；恢复之前不接受新的管理操作。页面切换不会关闭后台浏览器。</p></div>}
      <p className="ocs-help">管理功能均在当前主应用内完成；启动的是隔离的受控浏览器，不是另一个 OCS 管理窗口。切换导航只停止本页刷新，不会停止浏览器。</p>
    </section>
    {state ? <section className="panel ocs-content">
      <div className="ocs-tabs" role="tablist" aria-label="OCS 管理功能">{tabs.map(({ id, label, icon: Icon }) => <button key={id} type="button" role="tab" id={`ocs-tab-${id}`} data-testid={`ocs-tab-${id}`} aria-selected={tab === id} aria-controls={`ocs-panel-${id}`} className={tab === id ? 'selected' : ''} onClick={() => setTab(id)}><Icon size={16} />{label}</button>)}</div>
      <div className="ocs-tab-panel" id="ocs-panel-browsers" role="tabpanel" aria-labelledby="ocs-tab-browsers" hidden={tab !== 'browsers'}><BrowserManager state={state} disabled={disabled} execute={execute} confirm={setConfirmation} /></div>
      <div className="ocs-tab-panel" id={tab === 'scripts' ? 'ocs-panel-scripts' : 'ocs-panel-extensions'} role="tabpanel" aria-labelledby={tab === 'scripts' ? 'ocs-tab-scripts' : 'ocs-tab-extensions'} hidden={tab !== 'scripts' && tab !== 'extensions'}><Resources state={state} disabled={disabled} execute={execute} confirm={setConfirmation} section={tab === 'scripts' ? 'scripts' : 'extensions'} /></div>
      <div className="ocs-tab-panel" id="ocs-panel-settings" role="tabpanel" aria-labelledby="ocs-tab-settings" hidden={tab !== 'settings'}><Settings settings={state.settings} disabled={disabled || activeCount > 0} execute={execute} /></div>
      <div className="ocs-tab-panel" id="ocs-panel-logs" role="tabpanel" aria-labelledby="ocs-tab-logs" hidden={tab !== 'logs'}><Logs state={state} /></div>
      <div className="ocs-tab-panel ocs-stack" id="ocs-panel-capabilities" role="tabpanel" aria-labelledby="ocs-tab-capabilities" hidden={tab !== 'capabilities'} data-testid="ocs-capabilities"><div><h2>真实能力与边界</h2><p className="ocs-help">以下由当前后台能力清单返回。页面存在、浏览器启动或截图出现均不代表平台课程已完成。</p></div><div className="ocs-capability-list">{state.capabilities.map(capability => <article className="ocs-capability" key={capability.id} data-testid={`ocs-capability-${capability.id}`}>{capability.available ? <CheckCircle2 size={20} className="ocs-success-text" /> : <XCircle size={20} className="ocs-muted" />}<div><h3>{capability.label}<span className={capability.available ? 'ocs-success-text' : 'ocs-muted'}>{capability.available ? '已提供' : '未提供'}</span></h3><p>{capability.detail}</p></div></article>)}</div>{state.capabilities.length === 0 && <p className="ocs-empty" data-testid="ocs-capabilities-empty">后台尚未返回能力说明，不能据此认定完整支持。</p>}<div className="ocs-box"><div className="ocs-inline-heading"><CircleHelp size={18} /><h3>源码与私有数据边界</h3></div><p className="ocs-help">界面字段依据 OCS Desktop 2.12.0 的浏览器、脚本、自动化与配置结构适配。官方源码保存在 vendor/ocs/source；不通过官网 iframe 提供功能，不使用校园登录会话，也不导入其他软件的账号数据。</p><label className="ocs-readonly-label">隔离数据目录<code className="ocs-path" data-testid="ocs-data-path">{state.dataDirectory}</code></label><label className="ocs-readonly-label">受控浏览器程序<code className="ocs-path" data-testid="ocs-browser-executable">{state.browserExecutable || '后台尚未提供可用路径'}</code></label></div></div>
    </section> : <section className="panel ocs-empty" data-testid="ocs-loading"><MonitorPlay size={30} /><h3>{error ? '尚未取得 OCS 状态' : '正在读取 OCS 源码服务'}</h3><p>{error ? '请使用上方按钮手动重新读取。' : '取得后台状态后显示浏览器、脚本、扩展与配置。'}</p></section>}
    {confirmation && <div className="ocs-dialog-backdrop"><section className="ocs-dialog" role="alertdialog" aria-modal="true" aria-labelledby="ocs-confirm-title" aria-describedby="ocs-confirm-description" data-testid="ocs-confirm-dialog"><h2 id="ocs-confirm-title">{confirmation.title}</h2><p id="ocs-confirm-description">{confirmation.description}</p>{error && <p className="ocs-error">操作未确认成功：{error}</p>}<div className="ocs-actions"><button type="button" autoFocus className="button secondary" data-testid="ocs-confirm-cancel" disabled={busy} onClick={() => setConfirmation(null)}>取消</button><button type="button" className="button ocs-danger-button" data-testid={['browser-delete', 'script-delete', 'extension-delete'].includes(confirmation.command.command) ? 'ocs-confirm-delete' : 'ocs-confirm-submit'} disabled={confirmationDisabled} onClick={() => void confirmOperation()}>确认操作</button></div></section></div>}
  </div>;
}
