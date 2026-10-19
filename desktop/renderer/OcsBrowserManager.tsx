import { useState } from 'react';
import { Camera, CircleStop, Folder, Focus, MonitorPlay, Pencil, Play, Plus, Search, Trash2, X } from 'lucide-react';
import type { OcsBrowser, OcsState } from '../shared/ocs';
import { isSupportedOcsLogin, OCS_SUPPORTED_LOGINS, OCS_UNSUPPORTED_LOGINS } from '../shared/ocs-login';
import { browserPhaseLabels, emptyMetadata, formatTime, metadataFromBrowser } from './OcsTypes';
import type { AutomationDefinition, BrowserMetadata, ConfirmOcs, ExecuteOcs } from './OcsTypes';

type BrowserManagerProps = { state: OcsState; disabled: boolean; execute: ExecuteOcs; confirm: ConfirmOcs };
type BrowserEditorProps = { browser: OcsBrowser | null; disabled: boolean; execute: ExecuteOcs; close: () => void };

function BrowserEditor({ browser, disabled, execute, close }: BrowserEditorProps) {
  const [draft, setDraft] = useState<BrowserMetadata>(() => browser ? metadataFromBrowser(browser) : emptyMetadata());
  const [tags, setTags] = useState(browser?.tags.join(', ') ?? '');
  const [error, setError] = useState('');
  async function save(): Promise<void> {
    const tagList = [...new Set(tags.split(/[,，\n]/).map(value => value.trim()).filter(Boolean))];
    if (!draft.name.trim()) { setError('请填写浏览器名称。'); return; }
    if (tagList.length > 20 || tagList.some(tag => tag.length > 40)) { setError('最多 20 个标签，每个标签最多 40 个字符。'); return; }
    if (draft.startUrl !== 'about:blank') {
      try {
        const url = new URL(draft.startUrl);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid-url');
      } catch { setError('起始页面必须是无账号密码的 HTTP(S) 地址或 about:blank。'); return; }
    }
    const metadata: BrowserMetadata = { ...draft, name: draft.name.trim(), tags: tagList };
    setError('');
    const saved = await execute(browser ? { command: 'browser-update', id: browser.id, browser: metadata } : { command: 'browser-create', browser: metadata });
    if (saved) close();
  }
  return <section className="ocs-box ocs-editor" data-testid="ocs-browser-editor">
    <div className="ocs-section-heading"><h3>{browser ? `编辑 ${browser.name}` : '新建隔离浏览器'}</h3><button type="button" className="ocs-icon-button" aria-label="关闭编辑" data-testid="ocs-browser-editor-close" disabled={disabled} onClick={close}><X size={17} /></button></div>
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <fieldset disabled={disabled} className="ocs-form-grid">
        <label>名称<input data-testid="ocs-browser-name" maxLength={100} required value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} placeholder="例如：学习浏览器" /></label>
        <label>文件夹<input data-testid="ocs-browser-folder" maxLength={100} value={draft.folder} onChange={event => setDraft({ ...draft, folder: event.target.value })} placeholder="留空表示未分组" /></label>
        <label className="ocs-wide">起始页面<input data-testid="ocs-browser-url" maxLength={2000} required value={draft.startUrl} onChange={event => setDraft({ ...draft, startUrl: event.target.value })} spellCheck={false} /></label>
        <label className="ocs-wide">标签<input data-testid="ocs-browser-tags" value={tags} onChange={event => setTags(event.target.value)} placeholder="用逗号分隔，最多 20 个" /></label>
        <label className="ocs-wide">备注<textarea data-testid="ocs-browser-notes" maxLength={2000} rows={3} value={draft.notes} onChange={event => setDraft({ ...draft, notes: event.target.value })} /></label>
      </fieldset>
      {error && <p className="ocs-error" role="alert" data-testid="ocs-browser-form-error">{error}</p>}
      <div className="ocs-actions"><button className="button primary" data-testid={browser ? 'ocs-browser-save' : 'ocs-browser-create'} disabled={disabled} type="submit">{browser ? '保存修改' : '创建浏览器'}</button><button className="button secondary" data-testid="ocs-browser-cancel" disabled={disabled} type="button" onClick={close}>取消</button></div>
    </form>
  </section>;
}

function AutomationForm({ browser, catalog, run, disabled, execute, confirm }: { browser: OcsBrowser; catalog: AutomationDefinition[]; run: OcsState['automationRun']; disabled: boolean; execute: ExecuteOcs; confirm: ConfirmOcs }) {
  const [name, setName] = useState(browser.automationName ?? catalog[0]?.name ?? '');
  const [values, setValues] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const definition = catalog.find(item => item.name === name);
  const hasDraft = Object.keys(values).length > 0;
  const unsupportedReason = isSupportedOcsLogin(name) ? '' : Object.entries(OCS_UNSUPPORTED_LOGINS).find(([entry]) => entry === name)?.[1] ?? '此条目不是已支持的平台登录；通用页面导航不属于登录操作，不能在此执行。';
  const runBlockedReason = disabled ? '后台操作中或状态读取尚未恢复，请先等待或刷新。' : !definition ? '当前脚本不在后台目录中，请刷新。' : unsupportedReason || (!browser.automationName ? '请先保存所选浏览器的登录配置。' : name !== browser.automationName ? '当前选择与已保存脚本不一致，请先保存或重新选择已保存脚本。' : hasDraft ? '有未保存的参数草稿，请先保存；执行只使用后台已保存配置。' : !browser.owned || browser.phase !== 'running' ? '请先启动所选受控浏览器，并等待后台确认运行。' : '');
  async function save(): Promise<void> {
    if (!definition) return;
    const submitted = definition.fields.filter(field => Object.hasOwn(values, field.key)).map(field => ({ key: field.key, value: values[field.key] ?? '' }));
    if (await execute({ command: 'automation-save', id: browser.id, name, values: submitted })) { setValues({}); setSaved(true); }
  }
  return <section className="ocs-box" data-testid="ocs-automation">
    <div className="ocs-section-heading"><h3>官方自动化脚本</h3><span className="ocs-muted">{browser.automationName ? `已配置：${browser.automationName}` : '尚未配置'}</span></div>
    <p className="ocs-help">参数来自官方脚本目录，仅用于所选网课平台；不会读取或共享校园登录。已保存参数不回显，未修改的参数由后台保留或使用官方默认值。密码留空保留，清除配置会删除全部已存参数。保存本身不执行脚本。</p>
    <p className="ocs-help">单次登录支持子集：{OCS_SUPPORTED_LOGINS.join('、')}。其他登录和通用导航不能从登录按钮执行；支持不代表平台登录已成功。</p>
    <p className="ocs-help" data-testid="ocs-automation-support">{unsupportedReason || '当前脚本属于已支持的单次登录子集；仍须核对已保存配置、受控浏览器和本次独立确认。'}</p>
    {catalog.length === 0 ? <p className="ocs-empty" data-testid="ocs-automation-empty">后台未提供可用的官方自动化脚本。</p> : <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <fieldset disabled={disabled} className="ocs-form-grid">
        <label className="ocs-wide">脚本<select data-testid="ocs-automation-name" value={name} onChange={event => { setName(event.target.value); setValues({}); setSaved(false); }}>{catalog.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}</select></label>
        {definition?.fields.map(field => <label key={field.key}>{field.label}{field.secret && <span className="ocs-muted"> · 不回显</span>}<input data-testid={`ocs-automation-field-${field.key}`} type={field.secret ? 'password' : 'text'} maxLength={2000} autoComplete="off" value={values[field.key] ?? ''} placeholder={field.secret ? '留空保留已存密码' : field.initialValue ? `官方默认：${field.initialValue}` : '未修改则保留已存参数'} onChange={event => { setValues({ ...values, [field.key]: event.target.value }); setSaved(false); }} /></label>)}
      </fieldset>
      <div className="ocs-actions"><button type="submit" className="button primary" data-testid="ocs-automation-save" disabled={disabled || !definition}>保存脚本配置</button><button type="button" className="button secondary" data-testid="ocs-automation-clear" disabled={disabled || !browser.automationName} onClick={() => confirm({ title: `清除 ${browser.name} 的自动化配置？`, description: '将清除所选浏览器的全部自动化参数（含密码），不删除浏览器及其资料。', command: { command: 'automation-clear', id: browser.id } })}>清除已存配置</button></div>
      {saved && <p className="ocs-success" role="status" data-testid="ocs-automation-saved">配置已保存。输入框已清空，私有参数不会返回页面；保存和启动都不会执行登录。</p>}
    </form>}
    <div className="ocs-actions"><button type="button" className="button secondary" data-testid="ocs-automation-run" disabled={runBlockedReason !== ''} title={runBlockedReason} onClick={() => confirm({ title: `确认在「${browser.name}」执行一次登录？`, description: `将使用当前受控浏览器已保存的「${browser.automationName}」配置，而非输入框草稿；最多一次提交。平台可能收费或触发认证、风控，验证码和 MFA 须本人处理；不自动重试，不代表登录或课程成功。请核对浏览器及脚本名称，再独立确认本次操作。`, command: { command: 'automation-run', id: browser.id, name, confirmed: true } })}><Play size={14} />单独确认一次登录</button></div>
    <p className="ocs-help" data-testid="ocs-automation-run-reason">{runBlockedReason || '仅使用后台已保存配置；点击后还需单独确认。后台会明确拒绝未支持脚本，不会将提交当作登录成功。'}</p>
    {run ? <div className="ocs-box" role="status" data-testid="ocs-automation-result" data-status={run.result.status}>
      <h3 data-testid="ocs-automation-result-status">{run.result.status === 'unsupported' ? '未支持此登录脚本 · 尚未提交' : run.result.status === 'awaiting-user' ? '尚未提交 · 等待本人处理' : '已派发 1 次登录提交 · 待本人核验'}</h3>
      <p className="ocs-help" data-testid="ocs-automation-result-name">本次脚本：{run.result.name}</p><p className="ocs-help" data-testid="ocs-automation-result-time">记录时间：<time dateTime={run.at}>{formatTime(run.at)}</time> · 提交尝试 {run.result.submitAttempts} 次</p>
      <p className="ocs-help" data-testid="ocs-automation-result-detail">{run.result.status === 'unsupported' ? run.result.reason : run.result.message}</p><p className="ocs-help">平台身份未验证。请本人在所选浏览器核对验证码、MFA 和平台结果，不代表登录或课程成功，勿盲目重试。</p>
    </div> : <p className="ocs-help" data-testid="ocs-automation-result-empty">此浏览器尚无单次登录执行结果；配置保存和浏览器运行均不是登录成功证据。</p>}
  </section>;
}

export function BrowserManager({ state, disabled, execute, confirm }: BrowserManagerProps) {
  const [search, setSearch] = useState('');
  const [folder, setFolder] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [editor, setEditor] = useState<{ browser: OcsBrowser | null } | null>(null);
  const selected = state.browsers.find(browser => browser.id === selectedId);
  const query = search.trim().toLocaleLowerCase();
  const folders = [...new Set(state.browsers.map(browser => browser.folder).filter(Boolean))].sort();
  const browsers = state.browsers.filter(browser => (!folder || browser.folder === folder) && [browser.name, browser.folder, browser.notes, ...browser.tags].some(value => value.toLocaleLowerCase().includes(query)));
  const preview = state.preview?.browserId === selected?.id ? state.preview : null;
  return <div className="ocs-stack" data-testid="ocs-browsers">
    <div className="ocs-toolbar"><div><h2>浏览器资料库</h2><p>独立资料 · 文件夹与标签 · 官方自动化</p></div><button className="button primary" type="button" data-testid="ocs-browser-new" disabled={disabled} onClick={() => setEditor({ browser: null })}><Plus size={16} />新建浏览器</button></div>
    <div className="ocs-filters"><label className="ocs-search"><Search size={16} /><input data-testid="ocs-browser-search" aria-label="搜索浏览器" type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索名称、标签或备注" /></label><select data-testid="ocs-browser-folder-filter" aria-label="按文件夹筛选" value={folder} onChange={event => setFolder(event.target.value)}><option value="">全部文件夹</option>{folders.map(item => <option key={item} value={item}>{item}</option>)}</select><span className="ocs-muted">{browsers.length} / {state.browsers.length} 个</span></div>
    {editor && <BrowserEditor key={editor.browser?.id ?? 'new'} browser={editor.browser} disabled={disabled || state.browsers.some(browser => browser.id === editor.browser?.id && browser.owned)} execute={execute} close={() => setEditor(null)} />}
    <div className="ocs-browser-grid">
      {browsers.map(browser => <article className={`ocs-browser-card ${selectedId === browser.id ? 'selected' : ''}`} key={browser.id} data-testid={`ocs-browser-row-${browser.id}`}>
        <button className="ocs-browser-select" type="button" data-testid={`ocs-browser-select-${browser.id}`} aria-pressed={selectedId === browser.id} onClick={() => setSelectedId(browser.id)}><MonitorPlay size={21} /><strong>{browser.name}</strong><span className={`ocs-phase ${browser.phase}`} data-testid={`ocs-browser-phase-${browser.id}`}>{browserPhaseLabels[browser.phase]}</span></button>
        <p className="ocs-browser-folder"><Folder size={13} />{browser.folder || '未分组'}</p>
        <p className="ocs-notes">{browser.notes || '暂无备注'}</p>
        <div className="ocs-tags">{browser.tags.map(tag => <span key={tag}>{tag}</span>)}</div>
        {browser.lastError && <p className="ocs-error" data-testid={`ocs-browser-error-${browser.id}`}>{browser.lastError}</p>}
        <div className="ocs-card-actions">
          <button type="button" className="button secondary" data-testid={`ocs-browser-start-${browser.id}`} title={state.phase === 'unavailable' ? state.message : browser.owned ? '此实例仍由后台持有，请先停止' : '启动受控浏览器'} disabled={disabled || browser.owned || state.phase !== 'ready' || !['stopped', 'failed'].includes(browser.phase)} onClick={() => void execute({ command: 'browser-start', id: browser.id })}><Play size={14} />启动</button>
          <button type="button" className="button secondary" data-testid={`ocs-browser-stop-${browser.id}`} disabled={disabled || !browser.owned} onClick={() => void execute({ command: 'browser-stop', id: browser.id })}><CircleStop size={14} />{browser.phase === 'failed' ? '重试停止' : '停止'}</button>
          <button type="button" className="ocs-icon-button" aria-label={`聚焦 ${browser.name}`} title="聚焦受控浏览器" data-testid={`ocs-browser-focus-${browser.id}`} disabled={disabled || !browser.owned || browser.phase !== 'running'} onClick={() => void execute({ command: 'browser-focus', id: browser.id })}><Focus size={16} /></button>
          <button type="button" className="ocs-icon-button" aria-label={`编辑 ${browser.name}`} title="编辑资料" data-testid={`ocs-browser-edit-${browser.id}`} disabled={disabled || browser.owned} onClick={() => setEditor({ browser })}><Pencil size={16} /></button>
          <button type="button" className="ocs-icon-button ocs-danger-text" aria-label={`删除 ${browser.name}`} title="删除浏览器及其独立资料" data-testid={`ocs-browser-delete-${browser.id}`} disabled={disabled || browser.owned} onClick={() => confirm({ title: `删除浏览器「${browser.name}」？`, description: '将永久删除此浏览器的管理记录、独立 profile（包含该受控浏览器的登录资料及本地数据）和全部私有自动化配置参数（含密码）。旧 OCS 数据不受影响。请先停止浏览器；删除后无法从本页恢复。', command: { command: 'browser-delete', id: browser.id } })}><Trash2 size={16} /></button>
        </div>
      </article>)}
    </div>
    {browsers.length === 0 && <div className="ocs-empty" data-testid="ocs-browser-empty"><MonitorPlay size={30} /><h3>{state.browsers.length ? '没有匹配的浏览器' : '创建第一个隔离浏览器'}</h3><p>{state.browsers.length ? '请修改搜索词或文件夹筛选。' : '先导入所需的 MV3 扩展和用户脚本，再按需启动浏览器；创建记录不会执行课程。'}</p></div>}
    {selected && <>
      <section className="ocs-box" data-testid="ocs-browser-detail"><div className="ocs-section-heading"><div><h3>{selected.name}</h3><p className="ocs-help">{selected.startUrl}</p></div><button type="button" className="button secondary" data-testid="ocs-browser-preview" disabled={disabled || selected.phase !== 'running'} onClick={() => void execute({ command: 'browser-preview', id: selected.id })}><Camera size={16} />获取截图</button></div><p className="ocs-help">创建于 {formatTime(selected.createdAt)}。截图仅在主动获取时更新，不是实时视频，也不代表课程状态。</p>{preview ? <figure className="ocs-preview" data-testid="ocs-browser-preview-result"><img src={preview.image} alt={`${selected.name} 的单次浏览器截图`} /><figcaption data-testid="ocs-browser-preview-time">截图时间：{formatTime(preview.at)} · 单次静态预览</figcaption></figure> : <p className="ocs-empty ocs-compact-empty" data-testid="ocs-browser-preview-empty">尚未获取此浏览器截图</p>}</section>
      <AutomationForm key={selected.id} browser={selected} catalog={state.automationCatalog} run={state.automationRun?.browserId === selected.id ? state.automationRun : null} disabled={disabled} execute={execute} confirm={confirm} />
    </>}
  </div>;
}
