import { randomBytes } from 'node:crypto';
import { expect, test } from 'bun:test';
import { locateWindows, protectToken, unprotectToken } from '../desktop/bun/native';
import { mkdtemp, mkdir, readFile, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readLoginMemory, writeLoginMemory, clearLoginMemory } from '../desktop/bun/login-memory';

test('Remembered login uses real Windows DPAPI, survives reload and can be explicitly removed', async () => {
  const root = process.env['TEMP'];
  if (root === undefined) throw new Error('TEMP is unavailable.');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'swu-login-memory-'));
  const password = randomBytes(24).toString('base64url');
  const username = randomBytes(12).toString('hex');
  try {
    expect(await readLoginMemory(directory)).toBe(null);
    await writeLoginMemory(directory, { username, password, cookies: [] });
    const raw = await readFile(join(directory, 'login-memory.json'), 'utf8');
    expect(raw.includes(password)).toBe(false);
    expect(raw.includes(username)).toBe(false);
    const loaded = await readLoginMemory(directory);
    expect(loaded?.username === username && loaded.password === password).toBe(true);
    clearLoginMemory(directory);
    expect(await readLoginMemory(directory)).toBe(null);
  } finally {
    clearLoginMemory(directory);
    await rmdir(directory);
  }
}, 20_000);

test('Windows DPAPI encrypts and decrypts a generated session secret without storing the plaintext', async () => {
  const secret = randomBytes(32).toString('hex');
  const encrypted = await protectToken(secret);
  expect(encrypted).not.toContain(secret);
  expect(await unprotectToken(encrypted)).toBe(secret);
}, 20_000);

test.skipIf(process.env['SWU_TEST_LOCATION'] !== '1')('Windows returns a current position within the accepted accuracy without a Google key', async () => {
  const location = await locateWindows();
  expect(location.accuracy).toBeLessThanOrEqual(200);
  expect(Date.now() - location.timestamp).toBeLessThan(120_000);
  expect(location.address).toBe('');
}, 35_000);
