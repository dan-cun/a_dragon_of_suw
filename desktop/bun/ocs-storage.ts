import { spawn } from 'node:child_process';
import { access, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { emptyOcsDocument, ocsDocumentSchema, type OcsDocument } from './ocs-document';

const envelopeSchema = z.object({ schemaVersion: z.literal(1), protection: z.literal('windows-current-user-dpapi'), encrypted: z.string().min(1).max(8_388_608) }).strict();
const cryptoReplySchema = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), value: z.string() }), z.object({ ok: z.literal(false), error: z.string() })]);

/** Keep secrets on stdin and use CurrentUser DPAPI without legacy Electron data. */
async function crypt(operation: 'protect' | 'unprotect', value: string): Promise<string> {
  if (process.platform !== 'win32') throw new Error('OCS 私有配置仅支持 Windows CurrentUser DPAPI。');
  const executable = Bun.which('pwsh.exe');
  if (!executable) throw new Error('OCS 配置加密需要 PowerShell 7（pwsh.exe），请安装受支持运行环境。');
  const action = operation === 'protect'
    ? "$result=[Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($inputValue),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);$value=[Convert]::ToBase64String($result)"
    : "$result=[Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($inputValue),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);$value=[Text.Encoding]::UTF8.GetString($result)";
  const script = `$ErrorActionPreference='Stop';[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);try {Add-Type -AssemblyName System.Security.Cryptography.ProtectedData;$inputValue=[Console]::In.ReadToEnd();${action};@{ok=$true;value=$value}|ConvertTo-Json -Compress} catch {@{ok=$false;error=$_.Exception.GetType().Name}|ConvertTo-Json -Compress;exit 1}`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return await new Promise<string>((accept, reject) => {
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let finished = false;
    const fail = (error: Error) => { if (finished) return; finished = true; clearTimeout(timer); child.kill(); reject(error); };
    const timer = setTimeout(() => fail(new Error('OCS DPAPI 操作超过 15 秒。')), 15_000);
    child.once('error', cause => fail(new Error('无法启动 OCS DPAPI 服务。', { cause })));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { output += chunk; if (Buffer.byteLength(output) > 12_000_000) fail(new Error('OCS DPAPI 服务返回数据过长。')); });
    child.stderr.resume();
    child.stdin.on('error', cause => fail(new Error('OCS DPAPI 私有输入通道失败。', { cause })));
    child.once('close', code => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      try {
        const reply = cryptoReplySchema.parse(JSON.parse(output));
        if (!reply.ok) throw new Error(`OCS DPAPI ${operation === 'protect' ? '加密' : '解密'}失败（${reply.error}），不会读取或迁移旧 Electron 数据。`);
        if (code !== 0) throw new Error(`OCS DPAPI 服务退出码 ${String(code)}。`);
        accept(reply.value);
      } catch (cause) { reject(new Error('OCS 私有配置保护失败，请确认 Windows 用户和 PowerShell 7 环境。', { cause })); }
    });
    child.stdin.end(value, 'utf8');
  });
}

export function ownedPath(root: string, ...segments: string[]): string {
  const target = resolve(root, ...segments);
  const child = relative(resolve(root), target);
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error('OCS 文件操作超出受控子目录。');
  return target;
}

/** Reject junctions on every existing component before using the dedicated store. */
export async function assertNoLinks(path: string): Promise<void> {
  const parent = resolve(path, '..');
  if (parent !== resolve(path)) await assertNoLinks(parent);
  try { if ((await lstat(path)).isSymbolicLink()) throw new Error('OCS 数据路径不允许符号链接或目录联接。'); }
  catch (cause) { if (!(cause instanceof Error && 'code' in cause && cause.code === 'ENOENT')) throw cause; }
}

export function createOcsRepository(directory: string) {
  if (!isAbsolute(directory)) throw new Error('OCS 数据根目录必须是绝对路径。');
  const root = join(resolve(directory), 'ocs', 'source-integration');
  const config = join(root, 'configuration.dpapi.json');
  async function prepare(): Promise<void> {
    await assertNoLinks(root);
    await mkdir(root, { recursive: true });
    for (const folder of ['profiles', 'scripts', 'extensions']) { await assertNoLinks(join(root, folder)); await mkdir(join(root, folder), { recursive: true }); }
  }
  return {
    root,
    prepare,
    async read(): Promise<OcsDocument> {
      await prepare();
      try { await access(config, constants.F_OK); }
      catch (cause) { if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') return emptyOcsDocument(); throw cause; }
      await assertNoLinks(config);
      const metadata = await lstat(config);
      if (!metadata.isFile() || metadata.size > 8_500_000) throw new Error('OCS 加密配置文件类型或大小无效。');
      const envelope = envelopeSchema.parse(JSON.parse(await readFile(config, 'utf8')));
      return ocsDocumentSchema.parse(JSON.parse(await crypt('unprotect', envelope.encrypted)));
    },
    async save(document: OcsDocument): Promise<void> {
      await prepare();
      const text = JSON.stringify(ocsDocumentSchema.parse(document));
      if (Buffer.byteLength(text) > 2_000_000) throw new Error('OCS 配置超过 2 MB，请减少脚本或配置。');
      const pending = config + '.pending';
      await assertNoLinks(config); await assertNoLinks(pending);
      const encrypted = await crypt('protect', text);
      await writeFile(pending, JSON.stringify({ schemaVersion: 1, protection: 'windows-current-user-dpapi', encrypted }), { encoding: 'utf8', mode: 0o600 });
      await rename(pending, config);
    }
  };
}
