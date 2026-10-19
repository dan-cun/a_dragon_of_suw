import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { z } from 'zod';
import { ocsConfigCatalog, ocsConfigFieldKey, ocsConfigPrivateMarker, parseOcsConfigJson, readOcsConfigField, validateOcsConfigValue, writeOcsConfigField } from '../desktop/shared/ocs-config';
import type { OcsConfigField, OcsConfigSource, OcsConfigValue } from '../desktop/shared/ocs-config';
import { OcsConfigForm } from '../desktop/renderer/OcsConfigForm';

const root = resolve(import.meta.dir, '..');
const fields = ocsConfigCatalog.groups.flatMap(group => group.fields);
function fieldFor(key: string): OcsConfigField {
  const field = fields.find(item => ocsConfigFieldKey(item) === key);
  if (!field) throw new Error('The test requested a field outside the official catalog.');
  return field;
}
function scalar(expression: ts.Expression): OcsConfigValue | null {
  if (ts.isAsExpression(expression) || ts.isParenthesizedExpression(expression)) return scalar(expression.expression);
  if (ts.isStringLiteral(expression) || ts.isNumericLiteral(expression)) return ts.isNumericLiteral(expression) ? Number(expression.text) : expression.text;
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.AsteriskToken) {
    const left = scalar(expression.left);
    const right = scalar(expression.right);
    if (typeof left === 'number' && typeof right === 'number') return left * right;
  }
  return null;
}
function referenceProperties(reference: OcsConfigSource): ts.PropertyAssignment[] {
  const text = readFileSync(resolve(root, ocsConfigCatalog.sourceDirectory, reference.path), 'utf8');
  const source = ts.createSourceFile(reference.path, text, ts.ScriptTarget.Latest, true);
  const found: ts.PropertyAssignment[] = [];
  function visit(node: ts.Node): void {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    if (line >= reference.startLine && line <= reference.endLine && ts.isPropertyAssignment(node)) found.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}
function propertyName(property: ts.PropertyAssignment): string {
  return ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : '';
}
function optionValues(expression: ts.Expression): string[] | null {
  let array: ts.ArrayLiteralExpression;
  if (ts.isArrayLiteralExpression(expression)) array = expression;
  else if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression) && expression.expression.name.text === 'map' && ts.isArrayLiteralExpression(expression.expression.expression)) array = expression.expression.expression;
  else return null;
  const values: string[] = [];
  for (const element of array.elements) {
    const value = ts.isArrayLiteralExpression(element) ? element.elements[0] : element;
    if (!value) return null;
    const result = scalar(value);
    if (typeof result !== 'string' && typeof result !== 'number') return null;
    values.push(String(result));
  }
  return values;
}

test('Configuration catalog matches pinned source bytes, defaults, options and numeric constraints without executing upstream code', () => {
  const manifestSchema = z.object({ tag: z.literal('5.2.1'), commit: z.string(), sourceRoot: z.string(), files: z.record(z.string(), z.string()) });
  const manifestInput: unknown = JSON.parse(readFileSync(resolve(root, 'vendor/ocs/ocsjs-source-manifest.json'), 'utf8'));
  const manifest = manifestSchema.parse(manifestInput);
  expect(ocsConfigCatalog.version).toBe(manifest.tag);
  expect(ocsConfigCatalog.commit).toBe(manifest.commit);
  expect(ocsConfigCatalog.sourceDirectory).toBe(manifest.sourceRoot);
  expect(fields.length).toBe(23);
  expect(new Set(fields.map(ocsConfigFieldKey)).size).toBe(fields.length);
  expect(JSON.parse(JSON.stringify(ocsConfigCatalog))).toEqual(ocsConfigCatalog);
  for (const group of ocsConfigCatalog.groups) for (const field of group.fields) {
    expect(field.namespace).toBe(group.namespace);
    const properties = field.sources.flatMap(reference => {
      const bytes = readFileSync(resolve(root, manifest.sourceRoot, reference.path));
      const expectedHash = manifest.files[reference.path];
      if (!expectedHash) throw new Error('The catalog references a file missing from the pinned source manifest.');
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(expectedHash);
      expect(reference.startLine).toBeGreaterThan(0);
      expect(reference.endLine).toBeLessThanOrEqual(bytes.toString('utf8').split('\n').length);
      return referenceProperties(reference);
    });
    const defaults = properties.filter(property => propertyName(property) === 'defaultValue').map(property => scalar(property.initializer));
    expect(defaults).toContain(field.defaultValue);
    expect(properties.filter(property => propertyName(property) === 'label').map(property => scalar(property.initializer))).toContain(field.label);
    expect(validateOcsConfigValue(field, field.defaultValue)).toBe(field.defaultValue);
    if (field.kind === 'number') for (const name of ['min', 'max', 'step'] as const) {
      const bounds = properties.filter(property => propertyName(property) === name).map(property => Number(scalar(property.initializer)));
      expect(bounds).toContain(field[name]);
    }
    if (field.kind === 'select') {
      const candidates = properties.filter(property => propertyName(property) === 'options').map(property => optionValues(property.initializer));
      expect(candidates).toContainEqual(field.options.map(option => option.value));
    }
  }
});

test('Editing each real catalog field serializes exactly one namespace.key and preserves unknown nested private data', () => {
  const marker = ocsConfigPrivateMarker;
  const original = parseOcsConfigJson(JSON.stringify({ 'common.settings.answererWrappers': [{ headers: { token: marker }, list: [marker, { password: marker }] }], 'unported.setting': { nested: [true, null, 4, 'unchanged'] }, 'cx.new.study.mode': 'manually' }));
  const before = JSON.stringify(original);
  for (const field of fields) {
    const key = ocsConfigFieldKey(field);
    const edited = parseOcsConfigJson(writeOcsConfigField(before, key, field.defaultValue));
    expect(edited).toEqual({ ...original, [key]: field.defaultValue });
    expect(JSON.stringify(original)).toBe(before);
  }
  expect(parseOcsConfigJson('{}')).toEqual({});
  expect(readOcsConfigField({}, fieldFor('common.settings.thread'))).toEqual({ status: 'default', value: 1 });
  expect(parseOcsConfigJson(writeOcsConfigField('{}', 'zhs.study.playbackRate', '1.5'))).toEqual({ 'zhs.study.playbackRate': '1.5' });
});

test('Private subtrees cannot be overwritten, invalid values fail explicitly, and errors never include stored values', () => {
  const key = 'cx.new.study.volume';
  const field = fieldFor(key);
  for (const privateValue of [ocsConfigPrivateMarker, { nested: [false, { token: ocsConfigPrivateMarker }] }]) {
    const text = JSON.stringify({ [key]: privateValue });
    expect(readOcsConfigField(parseOcsConfigJson(text), field)).toEqual({ status: 'private' });
    expect(() => writeOcsConfigField(text, key, 0.5)).toThrow(TypeError);
  }
  const sentinel = randomUUID();
  const invalid = readOcsConfigField({ [key]: sentinel }, field);
  expect(invalid.status).toBe('invalid');
  expect(JSON.stringify(invalid)).not.toContain(sentinel);
  for (const value of [-0.05, 1.05, 0.03, Number.NaN, Number.POSITIVE_INFINITY, '0.5', null]) expect(() => writeOcsConfigField('{}', key, value)).toThrow();
  expect(() => writeOcsConfigField('{}', 'common.settings.thread', 2.5)).toThrow(RangeError);
  expect(() => writeOcsConfigField('{}', 'cx.new.study.mode', 'invented-mode')).toThrow(TypeError);
  expect(() => writeOcsConfigField('{}', 'common.settings.token', sentinel)).toThrow(RangeError);
  for (const text of ['[]', 'null', '3', '{']) expect(() => parseOcsConfigJson(text)).toThrow();
  expect(() => parseOcsConfigJson(' '.repeat(524289))).toThrow(RangeError);
});

test('Native form renders real controls, withholds private and incompatible stored values, and never writes defaults while rendering', () => {
  const sentinel = randomUUID();
  const json = JSON.stringify({ 'common.settings.answererWrappers': [{ token: sentinel }], 'common.settings.period': { nested: [ocsConfigPrivateMarker] }, 'common.settings.thread': 2, 'cx.new.study.mode': sentinel });
  const markup = renderToStaticMarkup(createElement(OcsConfigForm, { json, disabled: false, onChange: (_json: string): void => { throw new Error('Rendering must not write configuration.'); }, onValidityChange: (_valid: boolean): void => { throw new Error('Rendering must not mutate form validity.'); } }));
  expect(markup).toContain('data-testid="ocs-config-common.settings.thread"');
  expect(markup).toContain('type="number"');
  expect(markup).toContain('value="2"');
  expect(markup).toContain('data-testid="ocs-config-private-common.settings.period"');
  expect(markup).not.toContain('id="ocs-config-common.settings.period"');
  expect(markup).not.toContain(sentinel);
  expect(markup).not.toContain('type="password"');
  expect(markup).not.toContain('<script');
  expect(markup).toContain('data-testid="ocs-config-cx.new.study.mode"');
});
