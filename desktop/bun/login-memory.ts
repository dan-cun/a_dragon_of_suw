import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { browserCookieSchema, credentialsSchema } from './auth-http';
import { protectToken, unprotectToken } from './native';

const memorySchema = credentialsSchema.omit({ captcha: true }).extend({ cookies: z.array(browserCookieSchema).max(100) }).strict();
const storedSchema = z.object({ version: z.literal(1), encrypted: z.string().min(1).max(60000) }).strict();
export type LoginMemory = z.infer<typeof memorySchema>;
export const authenticationSubmissionSchema = credentialsSchema.extend({ password: z.string().max(512), remember: z.boolean(), useSaved: z.boolean() })
  .strict().refine(value => value.useSaved || value.password.length > 0, 'Missing password.');
export type AuthenticationSubmission = z.infer<typeof authenticationSubmissionSchema>;

export async function readLoginMemory(directory: string): Promise<LoginMemory | null> {
  const path = join(directory, 'login-memory.json');
  if (!existsSync(path)) return null;
  const stored = storedSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  return memorySchema.parse(JSON.parse(await unprotectToken(stored.encrypted)));
}

export async function writeLoginMemory(directory: string, value: LoginMemory): Promise<void> {
  const serialized = JSON.stringify(memorySchema.parse(value));
  if (Buffer.byteLength(serialized, 'utf8') > 32768) throw new Error('学校登录会话超过 32 KB，无法安全保存记住登录信息。');
  const encrypted = await protectToken(serialized);
  const path = join(directory, 'login-memory.json');
  writeFileSync(`${path}.pending`, JSON.stringify(storedSchema.parse({ version: 1, encrypted })), { encoding: 'utf8', mode: 0o600 });
  renameSync(`${path}.pending`, path);
}

export function clearLoginMemory(directory: string): void {
  const path = join(directory, 'login-memory.json');
  if (existsSync(path)) unlinkSync(path);
}
