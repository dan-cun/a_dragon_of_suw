import type { OcsDocument } from './ocs-document';
import { z } from 'zod';

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
const jsonSchema: z.ZodType<Json> = z.lazy(() => z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonSchema), z.record(z.string(), jsonSchema)]));
const marker = '[已保存的私有值]';
const privateKey = /password|passwd|secret|token|api.?key|authorization|cookie|(?:^|\.)answererWrappers$/i;

export function parseConfig(value: string): { [key: string]: Json } {
  const result = jsonSchema.parse(JSON.parse(value));
  if (!result || Array.isArray(result) || typeof result !== 'object') throw new Error('OCS 全局配置必须是 JSON 对象。');
  return result;
}

function redactJson(value: Json): Json {
  if (Array.isArray(value)) return value.map(redactJson);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, privateKey.test(key) ? marker : redactJson(entry)]));
  return value;
}

export function publicConfig(value: string): string { return JSON.stringify(redactJson(parseConfig(value)), null, 2); }

export function mergeConfig(value: string, previous: string): string {
  function merge(next: Json, prior: Json | undefined): Json {
    if (next === marker) {
      if (prior === undefined) throw new Error('私有配置占位值没有对应已保存数据，请填写新值。');
      return prior;
    }
    if (Array.isArray(next)) return next.map((entry, index) => merge(entry, Array.isArray(prior) ? prior[index] : undefined));
    if (next && typeof next === 'object') return Object.fromEntries(Object.entries(next).map(([key, entry]) => [key, merge(entry, prior && typeof prior === 'object' && !Array.isArray(prior) ? prior[key] : undefined)]));
    return next;
  }
  return JSON.stringify(merge(parseConfig(value), parseConfig(previous)));
}

/** Include every private wrapper leaf and URL credential/query component in diagnostic redaction. */
function privateValueStrings(value: Json): string[] {
  if (typeof value === 'string') {
    if (!URL.canParse(value)) return [value];
    const url = new URL(value);
    return [value, url.username, url.password, ...url.searchParams.values()];
  }
  if (Array.isArray(value)) return value.flatMap(privateValueStrings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(privateValueStrings);
  return [];
}

function privateConfigStrings(value: Json): string[] {
  if (Array.isArray(value)) return value.flatMap(privateConfigStrings);
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, entry]) => privateKey.test(key) ? privateValueStrings(entry) : privateConfigStrings(entry));
  return [];
}

export function privateStrings(document: OcsDocument): string[] {
  const found = [...document.automations.flatMap(automation => automation.values.map(value => value.value)), ...privateConfigStrings(parseConfig(document.settings.globalConfigJson))];
  return [...new Set(found)].filter(value => value.length >= 3).sort((left, right) => right.length - left.length);
}

export function sanitizeOcsMessage(message: string, secrets: string[]): string {
  let result = message;
  for (const secret of secrets) result = result.split(secret).join('[redacted]');
  return result.replace(/https?:\/\/[^\s"'<>]+/g, value => { try { const url = new URL(value); return url.origin + url.pathname; } catch { return '[redacted-url]'; } })
    .replace(/(password|passwd|token|secret|authorization|cookie|api[-_]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .slice(0, 1500);
}
