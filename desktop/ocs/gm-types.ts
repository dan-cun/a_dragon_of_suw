import { z } from 'zod';

export const gmGrants = ['GM_info', 'GM_getValue', 'GM_setValue', 'GM_deleteValue', 'GM_listValues', 'GM_addValueChangeListener', 'GM_removeValueChangeListener', 'GM_getTab', 'GM_saveTab', 'GM_getTabs', 'GM_addStyle'] as const;
export const gmNetworkGrants = ['GM_xmlhttpRequest', 'GM.xmlHttpRequest'] as const;
export const gmResourceGrants = ['GM_getResourceText', 'GM_getResourceURL'] as const;
export const supportedGmGrants = [...gmGrants, ...gmNetworkGrants, ...gmResourceGrants] as const;
export type GmGrant = typeof supportedGmGrants[number];
export type GmValue = null | boolean | number | string | GmValue[] | { [key: string]: GmValue };
export type GmValues = Record<string, GmValue>;
export interface UserScriptStorageOptions { root: string; profileId: string }
/** dispose closes GM admission; flush only waits. Settlement is not a claim of successful writes. */
export interface UserScriptController { flush(): Promise<void>; dispose(): Promise<void>; isSettled(): boolean }
export const gmKeySchema = z.string().min(1).max(200).refine(value => !['__proto__', 'constructor', 'prototype'].includes(value), 'Reserved GM storage key.');

/** Validate JSON values without coercing non-finite numbers or prototype-sensitive keys. */
export function gmValue(value: unknown, depth: number): GmValue {
  if (depth > 12) throw new RangeError('GM value nesting exceeds 12 levels.');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return Array.from(value, (item: unknown) => gmValue(item, depth + 1));
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, item]: [string, unknown]) => [gmKeySchema.parse(key), gmValue(item, depth + 1)]));
  }
  throw new TypeError('GM values must be finite JSON values.');
}
/** Compare finite JSON structurally; object property order is not a value change. */
export function equalGmValue(left: GmValue | undefined, right: GmValue | undefined): boolean {
  if (left === right) return true;
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) return false;
  if (Array.isArray(left)) return Array.isArray(right) && left.length === right.length && left.every((value, index) => equalGmValue(value, right[index]));
  if (Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && equalGmValue(left[key], right[key]));
}
export function gmValues(value: unknown): GmValues {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('GM storage snapshot must be an object.');
  const entries = Object.entries(value);
  if (entries.length > 128) throw new RangeError('GM storage exceeds 128 keys.');
  const result = Object.fromEntries(entries.map(([key, item]: [string, unknown]) => [gmKeySchema.parse(key), gmValue(item, 0)]));
  if (Buffer.byteLength(JSON.stringify(result)) > 524_288) throw new RangeError('GM storage exceeds 512 KiB.');
  return result;
}
