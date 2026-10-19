import { useState } from 'react';
import { ocsConfigCatalog, ocsConfigFieldKey, parseOcsConfigJson, readOcsConfigField, writeOcsConfigField } from '../shared/ocs-config';
import type { OcsConfigDocument, OcsConfigField, OcsConfigValue } from '../shared/ocs-config';

type ConfigFormProps = { json: string; disabled: boolean; onChange: (json: string) => void; onValidityChange: (valid: boolean) => void };
type NumberField = Extract<OcsConfigField, { kind: 'number' }>;
type NumberInputProps = { field: NumberField; value: number; disabled: boolean; invalid: boolean; onChange: (text: string) => void };

function ConfigNumberInput({ field, value, disabled, invalid, onChange }: NumberInputProps) {
  const [text, setText] = useState<string | null>(null);
  const key = ocsConfigFieldKey(field);
  return <input id={`ocs-config-${key}`} data-testid={`ocs-config-${key}`} type="number" min={field.min} max={field.max} step={field.step} value={text ?? String(value)} disabled={disabled} aria-invalid={invalid} aria-describedby={`ocs-config-help-${key}`} onChange={event => { setText(event.target.value); onChange(event.target.value); }} onBlur={() => { if (!invalid) setText(null); }} />;
}

function ConfigFields({ document, json, disabled, onChange, onValidityChange }: ConfigFormProps & { document: OcsConfigDocument }) {
  const [issues, setIssues] = useState<Record<string, string>>({});
  function update(field: OcsConfigField, value: OcsConfigValue): void {
    const key = ocsConfigFieldKey(field);
    try {
      const next = writeOcsConfigField(json, key, value);
      const remaining = { ...issues, [key]: '' };
      setIssues(remaining);
      onValidityChange(!Object.values(remaining).some(Boolean));
      onChange(next);
    } catch (cause: unknown) {
      setIssues({ ...issues, [key]: cause instanceof Error ? cause.message : '配置字段校验失败，未修改 JSON。' });
      onValidityChange(false);
    }
  }
  function updateNumber(field: NumberField, text: string): void {
    update(field, text.trim() === '' ? Number.NaN : Number(text));
  }
  return <div className="ocs-config-groups">{ocsConfigCatalog.groups.map(group => <details className="ocs-config-group" key={group.namespace} open={group.namespace === 'common.settings'} data-testid={`ocs-config-group-${group.namespace}`}><summary data-testid={`ocs-config-group-toggle-${group.namespace}`}><strong>{group.label}</strong><span>{group.fields.length} 项 · 仅配置</span></summary><div className="ocs-config-fields">{group.fields.map(field => {
    const key = ocsConfigFieldKey(field);
    const stored = readOcsConfigField(document, field);
    const value = stored.status === 'default' || stored.status === 'saved' ? stored.value : field.defaultValue;
    const issue = issues[key];
    return <div className="ocs-config-field" key={key} data-testid={`ocs-config-field-${key}`}>
      <label className="ocs-config-label" htmlFor={`ocs-config-${key}`}>{field.label}<span className="ocs-muted">{stored.status === 'default' ? '上游默认 · 尚未写入' : stored.status === 'saved' ? '已配置' : stored.status === 'private' ? '私有值 · 保留' : '原值保留 · 待校验'}</span></label>
      {stored.status === 'private' ? <p className="ocs-help" data-testid={`ocs-config-private-${key}`}>该键包含已保存的私有占位值，本表单不会展示或覆盖。</p> : field.kind === 'boolean' ? <label className="ocs-toggle"><input id={`ocs-config-${key}`} data-testid={`ocs-config-${key}`} type="checkbox" checked={value === true} disabled={disabled} onChange={event => update(field, event.target.checked)} aria-describedby={`ocs-config-help-${key}`} />{value === true ? '开启' : '关闭'}</label> : field.kind === 'number' ? <ConfigNumberInput field={field} value={typeof value === 'number' ? value : field.defaultValue} disabled={disabled} invalid={!!issue} onChange={text => updateNumber(field, text)} /> : <select id={`ocs-config-${key}`} data-testid={`ocs-config-${key}`} value={String(value)} disabled={disabled} aria-describedby={`ocs-config-help-${key}`} onChange={event => update(field, event.target.value)}>{field.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>}
      <p className="ocs-help" id={`ocs-config-help-${key}`}>{field.description}</p>
      {stored.status === 'invalid' && <p className="ocs-help" data-testid={`ocs-config-stored-invalid-${key}`}>{stored.message} 未修改此项则完整保留原值；原值不在表单中回显。</p>}
      {issue && <p className="ocs-error" role="alert" data-testid={`ocs-config-error-${key}`}>{issue}</p>}
      <code className="ocs-config-key">{key}</code>
      <details className="ocs-config-source"><summary data-testid={`ocs-config-source-${key}`}>固定源码定位</summary>{field.sources.map(reference => <code key={`${reference.path}:${reference.startLine}`}>{reference.path}:{reference.startLine}–{reference.endLine}</code>)}</details>
    </div>;
  })}</div></details>)}</div>;
}

export function OcsConfigForm({ json, disabled, onChange, onValidityChange }: ConfigFormProps) {
  let document: OcsConfigDocument;
  try { document = parseOcsConfigJson(json); }
  catch (cause: unknown) { return <p className="ocs-error" role="alert" data-testid="ocs-config-json-error">{cause instanceof Error ? cause.message : '无法解析配置 JSON。'} 请先在下方 JSON 编辑器修正，原生表单未覆盖内容。</p>; }
  return <section className="ocs-config-form ocs-stack" data-testid="ocs-config-form">
    <div><h3>OCS 原生配置表单</h3><p className="ocs-help">依据 OCSJS {ocsConfigCatalog.version} 固定源码提取的 {ocsConfigCatalog.groups.reduce((count, group) => count + group.fields.length, 0)} 个非敏感字段。仅编辑并持久化配置，未提供可信同步通道或课程执行；保存不会向网课页面提交任何内容。默认值仅展示，用户未编辑的键不会自动写入。</p><code className="ocs-config-key" data-testid="ocs-config-version">{ocsConfigCatalog.version} · {ocsConfigCatalog.commit}</code></div>
    <ConfigFields document={document} json={json} disabled={disabled} onChange={onChange} onValidityChange={onValidityChange} />
    <p className="ocs-help">密码、题库 token、题库连接器、自动提交策略及任意 onrender/onload/远程 JavaScript 未迁移到本表单。未知键和私有占位值继续保留在原 JSON 中；本表单不读取这些值到控件。</p>
  </section>;
}
