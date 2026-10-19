import { spawn } from 'node:child_process';
import type { Stats } from 'node:fs';
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { assertNoLinks, ownedPath } from './ocs-storage';
import { gmValues, type GmValues } from '../ocs/gm-types';

const identitySchema = z.string().uuid();
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const envelopeSchema = z.object({ schemaVersion: z.literal(1), protection: z.literal('windows-current-user-dpapi'), encrypted: z.string().min(1).max(2_000_000) });
const replySchema = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), value: z.string() }), z.object({ ok: z.literal(false), error: z.string() })]);

/** Keep plaintext in anonymous pipes only; do not export the application configuration store. */
async function protect(operation: 'protect' | 'unprotect', value: string): Promise<string> {
  const executable = Bun.which('pwsh.exe');
  if (process.platform !== 'win32' || !executable) throw new Error('GM storage requires Windows CurrentUser DPAPI and PowerShell 7.');
  const action = operation === 'protect'
    ? '$bytes=[Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($inputValue),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);$value=[Convert]::ToBase64String($bytes)'
    : '$bytes=[Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($inputValue),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);$value=[Text.Encoding]::UTF8.GetString($bytes)';
  const source = `$ErrorActionPreference='Stop';[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);try{Add-Type -AssemblyName System.Security.Cryptography.ProtectedData;$inputValue=[Console]::In.ReadToEnd();${action};@{ok=$true;value=$value}|ConvertTo-Json -Compress}catch{@{ok=$false;error=$_.Exception.GetType().Name}|ConvertTo-Json -Compress;exit 1}`;
  return await new Promise<string>((accept, reject) => {
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let finished = false;
    const timer = setTimeout(() => fail(new Error('GM DPAPI operation exceeded 15 seconds; no browser was terminated.')), 15_000);
    function fail(cause: Error): void { if (finished) return; finished = true; clearTimeout(timer); reject(cause); }
    child.once('error', cause => fail(new Error('GM DPAPI process could not start.', { cause })));
    child.stdin.on('error', cause => fail(new Error('GM DPAPI input pipe failed.', { cause })));
    child.stdout.on('error', cause => fail(new Error('GM DPAPI output pipe failed.', { cause })));
    child.stderr.on('error', cause => fail(new Error('GM DPAPI diagnostic pipe failed.', { cause })));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (finished) return;
      output += chunk;
      if (Buffer.byteLength(output) > 2_500_000) fail(new RangeError('GM DPAPI reply exceeded the output bound.'));
    });
    child.stderr.resume();
    child.once('close', code => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      try {
        const reply = replySchema.parse(JSON.parse(output));
        if (!reply.ok) throw new Error(`GM DPAPI ${operation} failed (${reply.error}).`);
        if (code !== 0) throw new Error(`GM DPAPI process exited with code ${String(code)}.`);
        accept(reply.value);
      } catch (cause) { reject(new Error('GM private storage protection failed.', { cause })); }
    });
    child.stdin.end(value, 'utf8');
  });
}

export interface GmStorage {
  read(): Promise<GmValues>;
  save(values: GmValues): Promise<void>;
  saveLeased(values: GmValues, assertLease: () => Promise<void>): Promise<void>;
}

/** Isolate encrypted JSON by profile, imported script identity and exact reviewed source digest. */
export function createGmStorage(root: string, profileId: string, scriptId: string, digest: string): GmStorage {
  if (!isAbsolute(root)) throw new TypeError('GM storage root must be an absolute owned repository path.');
  const directory = ownedPath(root, 'gm-values', identitySchema.parse(profileId), identitySchema.parse(scriptId));
  const file = ownedPath(root, 'gm-values', profileId, scriptId, digestSchema.parse(digest) + '.dpapi.json');
  async function prepare(): Promise<void> { await assertNoLinks(directory); await mkdir(directory, { recursive: true }); await assertNoLinks(file); }
  const pending = file + '.pending';
  async function encryptedPayload(values: GmValues): Promise<string> {
    const snapshot = gmValues(values);
    await prepare(); await assertNoLinks(pending);
    const encrypted = await protect('protect', JSON.stringify(snapshot));
    return JSON.stringify({ schemaVersion: 1, protection: 'windows-current-user-dpapi', encrypted });
  }
  return {
    async read(): Promise<GmValues> {
      await prepare();
      let metadata: Stats;
      try { metadata = await lstat(file); }
      catch (cause) { if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') return {}; throw cause; }
      if (!metadata.isFile() || metadata.size > 2_100_000) throw new TypeError('GM encrypted store type or size is invalid.');
      const envelope = envelopeSchema.parse(JSON.parse(await readFile(file, 'utf8')));
      return gmValues(JSON.parse(await protect('unprotect', envelope.encrypted)));
    },
    async save(values: GmValues): Promise<void> {
      await writeFile(pending, await encryptedPayload(values), { encoding: 'utf8', mode: 0o600 });
      await rename(pending, file);
    },
    async saveLeased(values: GmValues, assertLease: () => Promise<void>): Promise<void> {
      await assertLease();
      const payload = await encryptedPayload(values);
      await assertLease();
      await writeFile(pending, payload, { encoding: 'utf8', mode: 0o600 });
      // A staged encrypted file is not a committed value; never rename it after lease revocation.
      await assertLease();
      await rename(pending, file);
    }
  };
}
