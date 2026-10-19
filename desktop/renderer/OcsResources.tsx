import { useRef, useState } from 'react';
import { Code, Download, FolderInput, Puzzle, Trash2, Upload } from 'lucide-react';
import type { OcsState } from '../shared/ocs';
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
