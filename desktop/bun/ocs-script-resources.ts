import { createHash } from 'node:crypto';
import pinnedStyle from '../../vendor/ocs/ocsjs-5.2.1/packages/scripts/assets/css/style.css' with { type: 'text' };

export interface ScriptResource { name: string; source: string; mime: string; digest: string; text: string; dataUrl: string }
export interface ScriptResourceResolution { resources: ScriptResource[]; error: string | null }
export const ocsStyleResourceUrl = 'https://raw.githubusercontent.com/ocsjs/ocsjs/8b25a3f44523a0d4b7373878488056f4aa478cf6/packages/scripts/assets/css/style.css';
const styleDigest = '09c6293d7ba97e19446d36668e2c208abed7a970e9e099ebe6a6c155840d10ed';
const resourceLimit = 65_536;

function digest(text: string): string { return createHash('sha256').update(text).digest('hex'); }
if (digest(pinnedStyle) !== styleDigest) throw new Error('The bundled OCSJS 5.2.1 stylesheet does not match its fixed source SHA-256.');

/** Resolve immutable bundled CSS or self-contained UTF-8 text; never access files or the network. */
export function resolveScriptResources(declarations: string[]): ScriptResourceResolution {
  if (declarations.length > 16) return { resources: [], error: 'A script may declare at most 16 resources.' };
  const resources: ScriptResource[] = [];
  const names = new Set<string>();
  let total = 0;
  for (const declaration of declarations) {
    const parts = /^([A-Za-z_][\w.-]{0,63})\s+(\S+)$/.exec(declaration);
    const name = parts?.[1]; const source = parts?.[2];
    if (!name || !source || names.has(name) || ['__proto__', 'prototype', 'constructor'].includes(name)) return { resources: [], error: 'Resource declarations require unique non-reserved names of at most 64 characters and one fixed source.' };
    let text: string;
    let mime: string;
    if (source === ocsStyleResourceUrl) { text = pinnedStyle; mime = 'text/css'; }
    else {
      const inline = /^data:(text\/plain|text\/css|application\/json);charset=utf-8;base64,([A-Za-z0-9+/]*={0,2})$/.exec(source);
      if (!inline || !inline[1] || inline[2] === undefined || inline[2].length > 4 * Math.ceil(resourceLimit / 3)) return { resources: [], error: 'Resources support only the bundled pinned OCS stylesheet or bounded base64 UTF-8 text/plain, text/css and application/json data URLs.' };
      const bytes = Buffer.from(inline[2], 'base64');
      if (bytes.toString('base64') !== inline[2]) return { resources: [], error: 'Resource data URL base64 must use canonical encoding.' };
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
      catch (cause) { throw new TypeError('Resource data URL contains invalid UTF-8.', { cause }); }
      mime = inline[1];
    }
    const size = Buffer.byteLength(text);
    total += size;
    if (size > resourceLimit || total > 262_144) return { resources: [], error: 'Resources exceed the 64 KiB per-resource or 256 KiB per-script limit.' };
    names.add(name);
    resources.push({ name, source, mime, digest: digest(text), text, dataUrl: `data:${mime};charset=utf-8;base64,${Buffer.from(text).toString('base64')}` });
  }
  return { resources, error: null };
}
