import { useRef, useState } from 'react';
import { Code, Download, FolderInput, Puzzle, Trash2, Upload } from 'lucide-react';
import type { OcsState } from '../shared/ocs';
import { tsinghuaExternalScript } from '../shared/ocs-external';
import type { ConfirmOcs, ExecuteOcs } from './OcsTypes';

type ResourceProps = { state: OcsState; disabled: boolean; execute: ExecuteOcs; confirm: ConfirmOcs; section: 'scripts' | 'extensions' };
type ResourceToggleProps = { enabled: boolean; disabled: boolean; testId: string; label: string; save: (enabled: boolean) => Promise<boolean> };

function ResourceToggle({ enabled, disabled, testId, label, save }: ResourceToggleProps) {
  const [pendingChecked, setPendingChecked] = useState<boolean | null>(null);
  const submitting = useRef(false);

  async function update(checked: boolean): Promise<void> {
    if (disabled || submitting.current) return;
    submitting.current = true;
    setPendingChecked(checked);
    try {
      await save(checked);
    } finally {
      submitting.current = false;
      setPendingChecked(null);
    }
  }

  return <label className="ocs-toggle" aria-busy={pendingChecked !== null}><input type="checkbox" data-testid={testId} checked={pendingChecked ?? enabled} disabled={disabled || pendingChecked !== null} onChange={event => void update(event.currentTarget.checked)} />{label}</label>;
}

function TsinghuaScriptCard({ state, disabled, execute }: { state: OcsState; disabled: boolean; execute: ExecuteOcs }) {
  const [confirming, setConfirming] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [failed, setFailed] = useState(false);
  const submitting = useRef(false);
  const imported = state.userScripts.some(script => script.digest === tsinghuaExternalScript.digest);
  const owned = state.browsers.some(browser => browser.owned);
  const blocked = disabled || owned || imported || installing;

  async function install(): Promise<void> {
    if (blocked || submitting.current) return;
    submitting.current = true;
    setInstalling(true);
    setFailed(false);
    try {
      const installed = await execute({ command: 'script-install-tsinghua', confirmed: true });
      if (installed) setConfirming(false);
      else setFailed(true);
    } finally {
      submitting.current = false;
      setInstalling(false);
    }
  }

  return <section className="ocs-box" data-testid="ocs-tsinghua-script-card">
    <div className="ocs-section-heading"><h3>清华社外部脚本 · {tsinghuaExternalScript.version}</h3><span className="ocs-count">{tsinghuaExternalScript.license}</span></div>
    <p className="ocs-help">第三方 {tsinghuaExternalScript.name}，不是 OCS 官方脚本。固定源码安装后默认禁用，请审阅风险后在下方列表自行启用；不自动启动浏览器，也不授予宿主私有配置。完整题型兼容性与整课完成仍未验证。</p>
    <p className="ocs-help" role="status" data-testid="ocs-tsinghua-script-status">{imported ? '已导入此固定源码（SHA-256 匹配），启用状态见下方列表。' : '尚未导入此固定源码；同名或其他版本不视为已安装。'}{owned ? ' 请先停止全部受控浏览器，再安装或修改脚本。' : ''}</p>
    <details className="ocs-config-advanced" data-testid="ocs-tsinghua-script-details"><summary data-testid="ocs-tsinghua-script-details-toggle">使用前必读：自动任务、凭据与语音题风险</summary>
      <p className="ocs-help">启用后进入匹配页面可能恢复脚本上次的自动任务，可能修改学习记录、提交答案并影响成绩；不保证正确率或课程完成。安装、启用和打开网页不是课程成功证据。</p>
      <p className="ocs-help">脚本设置中的 AI Key / GitHub Token 为页面明文，可能被页面或其他脚本读取。不要填写宿主 API 密钥或复用重要凭据；第三方脚本失效上报默认关闭，安装不授权上报，请保持关闭。</p>
      <p className="ocs-help" data-testid="ocs-tsinghua-speech-risk">固定上游旧引擎存在自动点击录音、停止及提交的分支，不能理解为一律跳过语音题。请使用「浏览器」页的受控课程任务核对当前适配状态，遇口语由本人录音；本机朗读也位于该页，仅供练习，不能作为平台录音或评分。此前普通题与翻页的局部通过不代表音视频、口语评分或整课已验证。</p>
      <code className="ocs-path" data-testid="ocs-tsinghua-script-revision">固定 revision：{tsinghuaExternalScript.revision}</code><code className="ocs-path" data-testid="ocs-tsinghua-script-digest">SHA-256：{tsinghuaExternalScript.digest}</code>
      <a className="ocs-path" data-testid="ocs-tsinghua-script-source" href={tsinghuaExternalScript.url} target="_blank" rel="noreferrer">查看固定版本源码</a>
    </details>
    <div className="ocs-actions"><button type="button" className="button secondary" data-testid="ocs-tsinghua-script-install" disabled={blocked} onClick={() => { setFailed(false); setConfirming(true); }}><Download size={16} />{imported ? '此固定版本已导入' : '安装外部脚本…'}</button><a data-testid="ocs-tsinghua-script-project" href={tsinghuaExternalScript.projectUrl} target="_blank" rel="noreferrer">上游项目 · GPL-3.0-only</a></div>
    {confirming && <div className="ocs-dialog-backdrop"><section className="ocs-dialog" role="alertdialog" aria-modal="true" aria-labelledby="ocs-tsinghua-confirm-title" aria-describedby="ocs-tsinghua-confirm-description" data-testid="ocs-tsinghua-confirm-dialog"><h2 id="ocs-tsinghua-confirm-title">安装清华社第三方脚本？</h2><p id="ocs-tsinghua-confirm-description">仅下载并校验固定 {tsinghuaExternalScript.version} 源码，安装后默认禁用，不启动浏览器、不操作课程。之后自行启用时，脚本可能恢复上次自动任务、提交答案并影响成绩；AI Key / GitHub Token 是页面明文，不要填写宿主 API 密钥；第三方脚本失效上报默认关闭，应保持关闭。固定上游旧引擎有自动录音与提交分支，不能认为它总会跳过口语；请使用浏览器页受控任务核对适配状态，由本人录音。旧版普通题和翻页仅有局部通过记录，音视频、口语评分与整课尚未验证。</p><code className="ocs-path">SHA-256：{tsinghuaExternalScript.digest}</code>{failed && <p className="ocs-error" role="alert" data-testid="ocs-tsinghua-install-error">安装未确认成功。请取消对话框，查看页面顶部的具体错误并刷新状态后再决定是否重试。</p>}<div className="ocs-actions"><button type="button" autoFocus className="button secondary" data-testid="ocs-tsinghua-confirm-cancel" disabled={installing} onClick={() => setConfirming(false)}>取消</button><button type="button" className="button primary" data-testid="ocs-tsinghua-confirm-install" disabled={blocked || failed} onClick={() => void install()}>{installing ? '正在安装…' : '确认安装，保持禁用'}</button></div></section></div>}
  </section>;
}

export function Resources({ state, disabled, execute, confirm, section }: ResourceProps) {
  const [url, setUrl] = useState('');
  const [directory, setDirectory] = useState('');
  const [error, setError] = useState('');
  const [reading, setReading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const owned = state.browsers.some(browser => browser.owned);
  const locked = disabled || reading || owned;
  const lockReason = owned ? '仍有浏览器由后台持有，请先停止全部受控浏览器，再修改脚本、授权或扩展。' : disabled ? '后台操作中或状态读取尚未恢复，暂不能修改资源。' : reading ? '正在读取用户脚本，请等待导入结束。' : '';

  async function importFile(file: File): Promise<void> {
    setError('');
    if (!/\.user\.js$/i.test(file.name)) { setError('请选择以 .user.js 结尾的用户脚本文件。'); return; }
    if (file.name.length > 200 || file.size === 0 || file.size > 524288) { setError('脚本必须非空且不超过 512 KiB，文件名最多 200 个字符。'); return; }
    setReading(true);
    try {
      const content = await file.text();
      if (content.length > 524288) throw new Error('脚本文本超过 524288 个字符，未导入。');
      await execute({ command: 'script-import', name: file.name, content });
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : '无法读取用户脚本文件，请检查文件权限和内容。');
    } finally {
      setReading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function downloadScript(): Promise<void> {
    setError('');
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('请输入不包含账号密码的 HTTPS 脚本地址。');
    } catch (cause: unknown) {
      setError(cause instanceof Error && cause.message.startsWith('请输入') ? cause.message : '请输入有效的 HTTPS 脚本地址。');
      return;
    }
    if (await execute({ command: 'script-download', url })) setUrl('');
  }

  async function importExtension(): Promise<void> {
    setError('');
    if (!directory.trim()) { setError('请填写已解压扩展所在的本机目录。'); return; }
    if (await execute({ command: 'extension-import', directory: directory.trim() })) setDirectory('');
  }

  return <div className="ocs-stack" data-testid="ocs-resources">
    {section === 'scripts' && <TsinghuaScriptCard state={state} disabled={locked} execute={execute} />}
    <section className="ocs-box" hidden={section !== 'scripts'}><div className="ocs-section-heading"><div className="ocs-inline-heading"><Code size={20} /><h2>用户脚本</h2></div><span className="ocs-count">{state.userScripts.length} 个</span></div>
      <p className="ocs-help">启用后按匹配页面范围执行已审阅的本地源码，不通过脚本管理器安装。支持 grant-none，以及隔离世界内信息、持久存储、值监听、Tab 数据和样式共 11 项基础 GM 子集；另有两种显式网络声明及 GM_getResourceText、GM_getResourceURL。GM 写入需等待持久化；网络仅访问 @connect 指定的公共 HTTPS 域名，不携带浏览器 Cookie，资源仅限固定内置 CSS 或有界文本 data URL。unsafeWindow、GM_notification、@require 和本机连接仍不支持，不代表完整 OCSJS 或课程执行。</p>
      <p className="ocs-help" data-testid="ocs-script-sync-scope">私有配置同步需要总开关开启、脚本启用及逐脚本精确摘要授权，缺一不可；仅在下次启动前将 23 个 flat scalar 字段和 common.settings.answererWrappers 写入该版本的隔离 GM。题库包装配置可能含凭据，脚本可自行披露，已披露的秘密无法召回；更换源码后须重新审阅和授权。</p>
      {lockReason && <p className="ocs-help" data-testid="ocs-resource-locked">{lockReason}</p>}
      <div className="ocs-import-row"><label className="ocs-file-input">本地 .user.js 文件<input ref={fileInput} data-testid="ocs-script-file" type="file" accept=".user.js,.js" disabled={locked} onChange={event => { const file = event.currentTarget.files?.[0]; if (file) void importFile(file); }} /></label><span className="ocs-muted"><Upload size={14} />{reading ? '正在读取文件…' : '读取内容后导入，最多 512 KiB'}</span></div>
      <form className="ocs-import-row" onSubmit={event => { event.preventDefault(); void downloadScript(); }}><label className="ocs-grow">HTTPS 脚本地址<input data-testid="ocs-script-url" type="url" maxLength={2000} required placeholder="https://…/script.user.js" value={url} disabled={locked} onChange={event => setUrl(event.target.value)} /></label><button className="button secondary" type="submit" data-testid="ocs-script-download" disabled={locked || !url.trim()}><Download size={16} />下载并导入</button></form>
      <div className="ocs-resource-list">{state.userScripts.map(script => <article className="ocs-resource" key={script.id} data-testid={`ocs-script-${script.id}`}>
        <div className="ocs-resource-description"><strong>{script.name}</strong><span className="ocs-muted">版本 {script.version || '未声明'}</span><p className="ocs-path">{script.source}</p><code className="ocs-path" data-testid={`ocs-script-digest-${script.id}`}>SHA-256：{script.digest}</code><span className="ocs-muted" data-testid={`ocs-script-sync-status-${script.id}`}>{script.configSyncAuthorized ? '已授权此精确源码版本' : '尚未授权私有配置'} · {!script.enabled ? '脚本已禁用，不同步' : !state.settings.syncEnabled ? '总开关关闭，不同步' : script.configSyncAuthorized ? '下次启动前同步' : '需单独授权'}</span></div>
        <div className="ocs-resource-actions" title={lockReason}><ResourceToggle enabled={script.enabled} disabled={locked} testId={`ocs-script-enable-${script.id}`} label="启用源码注入" save={enabled => execute({ command: 'script-enable', id: script.id, enabled })} />
          <button type="button" className="button secondary" data-testid={`ocs-script-config-sync-${script.id}`} disabled={locked} onClick={() => confirm({ title: `${script.configSyncAuthorized ? '撤销' : '授予'}「${script.name}」的私有配置授权？`, description: `脚本 UUID：${script.id}；SHA-256：${script.digest}。${script.configSyncAuthorized ? '将跨 profile 恢复此版本的原 GM 值或移除注入值；脚本已经读取或披露的秘密无法召回。' : '仅当总开关开启且此脚本启用时，下次启动前将 23 个 flat scalar 字段和 common.settings.answererWrappers（可能含题库凭据）提供给这一个精确脚本版本的 isolated GM。脚本自己可以披露这些数据，已披露的秘密无法召回；源码更换后必须重新审阅授权。'}普通页面无权读取，不代表完整 OCSJS 或课程成功。`, command: { command: 'script-config-sync', id: script.id, digest: script.digest, authorized: !script.configSyncAuthorized, confirmed: true } })}>{script.configSyncAuthorized ? '撤销私有配置授权' : '授权此版本私有配置'}</button>
          <button type="button" className="ocs-icon-button ocs-danger-text" data-testid={`ocs-script-delete-${script.id}`} aria-label={`删除脚本 ${script.name}`} disabled={locked} onClick={() => confirm({ title: `删除用户脚本「${script.name}」？`, description: '将恢复各 profile 的原 GM 值或移除同步注入值，再移除此脚本的管理记录及源码副本；已披露的秘密无法召回。不会删除浏览器 profile 或登录资料，也不会管理脚本管理器中另行安装的副本。', command: { command: 'script-delete', id: script.id } })}><Trash2 size={16} /></button>
        </div></article>)}</div>
      {state.userScripts.length === 0 && <p className="ocs-empty ocs-compact-empty" data-testid="ocs-script-empty">尚未导入用户脚本。没有脚本不等于已具备平台内功能。</p>}
    </section>
    <section className="ocs-box" hidden={section !== 'extensions'}><div className="ocs-section-heading"><div className="ocs-inline-heading"><Puzzle size={20} /><h2>脚本管理扩展</h2></div><span className="ocs-count">{state.extensions.length} 个</span></div><p className="ocs-help">仅导入本机已解压的 Manifest V3 扩展目录，目录应直接包含 manifest.json。不会自动访问商店、安装完整 OCS 应用或读取其他浏览器的资料。扩展和脚本的实际载入结果以后台日志为准。</p>
      <form className="ocs-import-row" onSubmit={event => { event.preventDefault(); void importExtension(); }}><label className="ocs-grow">已解压扩展目录<input data-testid="ocs-extension-directory" maxLength={2000} required value={directory} disabled={locked} onChange={event => setDirectory(event.target.value)} placeholder="填写扩展目录的完整路径" spellCheck={false} /></label><button className="button secondary" type="submit" data-testid="ocs-extension-import" disabled={locked || !directory.trim()}><FolderInput size={16} />导入扩展</button></form>
      <div className="ocs-resource-list">{state.extensions.map(extension => <article className="ocs-resource" key={extension.id} data-testid={`ocs-extension-${extension.id}`}><div className="ocs-resource-description"><strong>{extension.name}</strong><span className="ocs-muted">Manifest V3 · 版本 {extension.version || '未声明'}</span></div><div className="ocs-resource-actions"><ResourceToggle enabled={extension.enabled} disabled={locked} testId={`ocs-extension-enable-${extension.id}`} label="启用" save={enabled => execute({ command: 'extension-enable', id: extension.id, enabled })} /><button type="button" className="ocs-icon-button ocs-danger-text" data-testid={`ocs-extension-delete-${extension.id}`} aria-label={`删除扩展 ${extension.name}`} disabled={locked} onClick={() => confirm({ title: `删除扩展「${extension.name}」？`, description: '将移除此扩展的管理记录及后台管理的副本，不删除浏览器 profile。对已运行浏览器是否生效以后台结果为准；请停止后重新启动并检查。', command: { command: 'extension-delete', id: extension.id } })}><Trash2 size={16} /></button></div></article>)}</div>
      {state.extensions.length === 0 && <p className="ocs-empty ocs-compact-empty" data-testid="ocs-extension-empty">尚未导入 MV3 脚本管理扩展。</p>}
    </section>
    {error && <p className="ocs-error" role="alert" data-testid="ocs-resource-error">{error}</p>}
  </div>;
}
