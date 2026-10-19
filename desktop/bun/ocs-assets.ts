import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { assertNoLinks, ownedPath } from './ocs-storage';
import { parseMatchPattern } from '../ocs/script-matching';
import { supportedGmGrants, gmNetworkGrants, type GmGrant } from '../ocs/gm-types';
import { connectHost } from '../ocs/gm-network';
import { resolveScriptResources, type ScriptResource } from './ocs-script-resources';
import type { SavedExtension, SavedScript } from './ocs-document';
export { downloadScript } from './ocs-download';

export interface ScriptProgram { id: string; name: string; version: string; digest: string; grants: GmGrant[]; connects: string[]; resources: ScriptResource[]; content: string; matches: string[]; includes: string[]; excludes: string[]; excludeMatches: string[]; runAt: 'document-start' | 'document-end' | 'document-idle'; supported: boolean }
const manifestSchema = z.object({ manifest_version: z.literal(3), name: z.string().min(1).max(200), version: z.string().min(1).max(100) });

export function scriptDigest(content: string): string { return createHash('sha256').update(content).digest('hex'); }

/** Support only declared isolated-world capabilities; reject remote and unknown privileges. */
export function parseUserScript(id: string, content: string): ScriptProgram & { version: string } {
  if (Buffer.byteLength(content) > 524_288) throw new Error('用户脚本超过 512 KiB。');
  const header = content.match(/\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/)?.[1];
  if (!header) throw new Error('缺少有效 UserScript 元数据头。');
  const entries = [...header.matchAll(/^\s*\/\/\s*@([\w:-]+)\s*(.*?)\s*$/gm)].map(match => ({ key: match[1] ?? '', value: (match[2] ?? '').trim() }));
  const values = (key: string): string[] => entries.filter(entry => entry.key === key).map(entry => entry.value);
  const name = values('name')[0];
  if (!name || name.length > 200) throw new Error('用户脚本必须声明有效的 @name。');
  const matches = values('match'); const includes = values('include');
  const excludes = values('exclude'); const excludeMatches = values('exclude-match');
  if (matches.length + includes.length === 0) throw new Error('用户脚本必须声明 @match 或 @include，不能默认对所有页面执行。');
  if (matches.concat(includes, excludes, excludeMatches).some(value => value.length > 2_000 || !value)) throw new Error('用户脚本页面匹配规则为空或过长。');
  matches.concat(excludeMatches).forEach(parseMatchPattern);
  for (const pattern of includes.concat(excludes)) {
    if (pattern.startsWith('/')) {
      if (!pattern.endsWith('/') || pattern.length < 2) throw new TypeError('用户脚本 include/exclude 正则表达式无效。');
      try { new RegExp(pattern.slice(1, -1)); }
      catch (cause) { throw new TypeError('用户脚本 include/exclude 正则表达式无效。', { cause }); }
    }
  }
  const runAt = values('run-at')[0] ?? 'document-end';
  if (!['document-start', 'document-end', 'document-idle'].includes(runAt)) throw new Error('仅支持 document-start/document-end/document-idle 运行时机。');
  const declared = values('grant');
  const grants = [...new Set(declared.filter(value => value !== 'none'))];
  const recognized = z.array(z.enum(supportedGmGrants)).safeParse(grants);
  const connects = [...new Set(values('connect'))];
  const validConnects = connects.length <= 32 && connects.every(value => { try { return connectHost(value) === value; } catch { return false; } });
  const network = grants.some(value => gmNetworkGrants.some(grant => grant === value));
  const resourceResolution = resolveScriptResources(values('resource'));
  const supported = recognized.success && !(declared.includes('none') && grants.length > 0)
    && values('require').length === 0 && resourceResolution.error === null
    && validConnects && (network ? connects.length > 0 : connects.length === 0);
  return { id, name, version: values('version')[0] ?? '', digest: scriptDigest(content), grants: recognized.success ? recognized.data : [], connects, resources: resourceResolution.resources, content, matches, includes, excludes, excludeMatches, runAt: runAt as ScriptProgram['runAt'], supported };
}

export async function importScript(root: string, content: string, source: string): Promise<SavedScript> {
  const id = randomUUID();
  const parsed = parseUserScript(id, content);
  const file = ownedPath(root, 'scripts', id + '.user.js');
  await assertNoLinks(file);
  await writeFile(file, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return { id, name: parsed.name, version: parsed.version, source, enabled: parsed.supported, digest: scriptDigest(content) };
}

export async function loadScript(root: string, item: SavedScript): Promise<ScriptProgram> {
  const file = ownedPath(root, 'scripts', item.id + '.user.js');
  await assertNoLinks(file);
  const stat = await lstat(file);
  if (!stat.isFile() || stat.size > 524_288) throw new Error('用户脚本文件类型或大小无效。');
  const content = await readFile(file, 'utf8');
  if (scriptDigest(content) !== item.digest) throw new Error('用户脚本内容校验失败，请重新导入。');
  return parseUserScript(item.id, content);
}

/** Import a regular MV3 tree, never traverse junctions or symbolic links. */
export async function importExtension(root: string, directory: string): Promise<SavedExtension> {
  if (!isAbsolute(directory)) throw new Error('扩展导入必须提供绝对目录路径。');
  const source = resolve(directory);
  const distance = relative(resolve(root), source);
  if (!distance || (!isAbsolute(distance) && distance !== '..' && !distance.startsWith(`..${sep}`))) throw new Error('不能从 OCS 受控数据目录再次导入扩展。');
  await assertNoLinks(source);
  if (!(await lstat(source)).isDirectory()) throw new Error('扩展来源不是目录。');
  const manifestPath = join(source, 'manifest.json');
  await assertNoLinks(manifestPath);
  if ((await lstat(manifestPath)).size > 524_288) throw new Error('扩展 manifest.json 过大。');
  const manifest = manifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
  const id = randomUUID();
  const destination = ownedPath(root, 'extensions', id);
  let count = 0;
  let bytes = 0;
  async function copyDirectory(from: string, to: string): Promise<void> {
    await assertNoLinks(from); await assertNoLinks(to);
    await mkdir(to, { recursive: false });
    for (const entry of await readdir(from, { withFileTypes: true })) {
      count += 1;
      if (count > 10_000) throw new Error('扩展文件数超过 10000。');
      const input = join(from, entry.name);
      const output = join(to, entry.name);
      const stat = await lstat(input);
      if (stat.isSymbolicLink()) throw new Error('扩展不允许符号链接或目录联接。');
      if (stat.isDirectory()) await copyDirectory(input, output);
      else if (stat.isFile()) {
        bytes += stat.size;
        if (bytes > 67_108_864) throw new Error('扩展大小超过 64 MiB。');
        await writeFile(output, await readFile(input), { flag: 'wx', mode: 0o600 });
      } else throw new Error('扩展包含非普通文件。');
    }
  }
  try { await copyDirectory(source, destination); }
  catch (cause) { await assertNoLinks(destination); await rm(destination, { recursive: true, force: true }); throw cause; }
  return { id, name: manifest.name, version: manifest.version, enabled: true };
}

