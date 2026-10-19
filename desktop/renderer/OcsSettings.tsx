import { useState } from 'react';
import { Save } from 'lucide-react';
import type { OcsSettings } from '../shared/ocs';
import { parseOcsConfigJson } from '../shared/ocs-config';
import { OcsConfigForm } from './OcsConfigForm';
import type { ExecuteOcs } from './OcsTypes';

export function Settings({ settings, disabled, execute }: { settings: OcsSettings; disabled: boolean; execute: ExecuteOcs }) {
  const [editing, setEditing] = useState<OcsSettings | null>(null);
  const draft = editing ?? settings;
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [formValid, setFormValid] = useState(true);
  const [configRevision, setConfigRevision] = useState(0);
  const dirty = draft.syncEnabled !== settings.syncEnabled || draft.enableDialogs !== settings.enableDialogs || draft.forceUpdateScripts !== settings.forceUpdateScripts || draft.globalConfigJson !== settings.globalConfigJson;

  async function save(): Promise<void> {
    setError('');
    if (!formValid) { setError('配置表单仍有无效字段，请修正后保存，或放弃未保存修改。'); return; }
    try { parseOcsConfigJson(draft.globalConfigJson); }
    catch (cause: unknown) { setError(cause instanceof Error ? cause.message : '全局配置解析失败。'); return; }
    if (await execute({ command: 'settings-save', settings: draft })) {
      setEditing(null);
      setSaved(true);
      setConfigRevision(revision => revision + 1);
    }
  }
  function update(next: OcsSettings): void { setEditing(next); setSaved(false); }
  function discard(): void {
    setEditing(null);
    setError('');
    setSaved(false);
    setFormValid(true);
    setConfigRevision(revision => revision + 1);
  }
  function updateJson(json: string): void {
    update({ ...draft, globalConfigJson: json });
    setFormValid(true);
    setConfigRevision(revision => revision + 1);
  }
  return <section className="ocs-box ocs-stack" data-testid="ocs-settings">
    <div><h2>OCS 设置</h2><p className="ocs-help">更改前请先停止全部受控浏览器。保存仅持久化配置；只有同步总开关开启、脚本启用且该精确源码摘要已单独授权时，才会在下次浏览器启动前写入隔离 GM 存储，不是当场同步到页面，也不代表课程执行。</p></div>
    {disabled && <p className="ocs-help" data-testid="ocs-settings-locked">暂不能修改设置。请先等待后台操作结束、恢复状态读取，并停止全部仍由后台持有的浏览器。</p>}
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <fieldset disabled={disabled} className="ocs-setting-options">
        <label className="ocs-setting-option"><input type="checkbox" data-testid="ocs-settings-sync" checked={draft.syncEnabled} onChange={event => update({ ...draft, syncEnabled: event.target.checked })} /><span><strong>同步全局 OCS 配置（精确脚本授权子集）</strong><small>总开关不会自动授权任何脚本。仅同步 23 个 flat scalar 字段和 common.settings.answererWrappers（可能含题库凭据），只提供给另行授权的精确脚本版本的隔离 GM，普通页面无权读取。关闭后将跨 profile 恢复原 GM 值或移除注入值；脚本已披露的秘密无法召回。</small></span></label>
        <label className="ocs-setting-option"><input type="checkbox" data-testid="ocs-settings-dialogs" checked={draft.enableDialogs} onChange={event => update({ ...draft, enableDialogs: event.target.checked })} /><span><strong>使用浏览器原生弹窗</strong><small>对应官方 enableDialog，不把弹窗设置当作执行成功标记。</small></span></label>
        <label className="ocs-setting-option"><input type="checkbox" data-testid="ocs-settings-force-update" checked={draft.forceUpdateScripts} onChange={event => update({ ...draft, forceUpdateScripts: event.target.checked })} /><span><strong>强制更新用户脚本（仅保存偏好）</strong><small>对应官方 forceUpdateScript；当前仅持久化此选项，尚未实现脚本管理器内的自动安装或强制更新，启用不会替换已安装的脚本。</small></span></label>
        <OcsConfigForm key={configRevision} json={draft.globalConfigJson} disabled={disabled} onChange={json => update({ ...draft, globalConfigJson: json })} onValidityChange={valid => { setFormValid(valid); setSaved(false); }} />
        <details className="ocs-config-advanced" data-testid="ocs-config-advanced" open><summary data-testid="ocs-config-advanced-toggle">高级：原始全局配置 JSON</summary><p className="ocs-help">与上方表单共用同一份草稿。未知键和已保存私有值的占位标记不会被表单自动删除；请勿删除或重排私有配置占位数据。密码、题库 token 不在本轮表单处理范围。</p><label className="ocs-json-label">全局配置 JSON<textarea data-testid="ocs-settings-json" spellCheck={false} rows={14} maxLength={524288} value={draft.globalConfigJson} onChange={event => updateJson(event.target.value)} /></label></details>
      </fieldset>
      <p className="ocs-help">保留官方配置键和值，不在此另造题库或课程参数。不要在全局配置中填写校园账号或其他模块的令牌。自动化私有密码请使用浏览器详情中的专用表单。</p>
      {error && <p className="ocs-error" role="alert" data-testid="ocs-settings-error">{error}</p>}
      <div className="ocs-actions"><button type="submit" className="button primary" data-testid="ocs-settings-save" disabled={disabled || !dirty || !formValid}><Save size={16} />保存设置</button><button type="button" className="button secondary" data-testid="ocs-settings-discard" disabled={disabled || (!dirty && formValid)} onClick={discard}>放弃未保存修改</button><span className="ocs-muted" data-testid="ocs-settings-dirty">{!formValid ? '有无效字段，尚未保存' : dirty ? '有未保存修改' : '与后台设置一致'}</span></div>
      {saved && !dirty && <p className="ocs-success" role="status" data-testid="ocs-settings-saved">设置已由后台持久化。符合总开关、脚本启用和精确版本授权条件的配置将在下次浏览器启动前同步；保存没有操作当前页面，也未执行课程。</p>}
    </form>
  </section>;
}
