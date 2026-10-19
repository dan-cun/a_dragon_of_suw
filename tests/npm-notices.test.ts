import { test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { exportNpmNotices, loadNpmSourceEvidence, NpmLicenseError, planNpmNotices } from '../scripts/npm-notices';
import { assertBuildOutputPathsSafe } from '../scripts/prepare-ocs-source';

const root = resolve(import.meta.dir, '..');
const source = resolve(root, 'licenses/npm-source');
const evidenceIdentity = z.object({ name: z.string(), version: z.string(), license: z.string() });
function digest(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }

async function temporary(): Promise<string> { return mkdtemp(resolve(root, 'work/npm-notices-test-')); }
async function removeTemporary(directory: string): Promise<void> {
  await assertBuildOutputPathsSafe(directory);
  await rm(directory, { recursive: true, force: false });
}

test('Real installed runtime graph retains all physical instances and nested versions', async () => {
  const plan = await planNpmNotices(root);
  expect(plan.packages.length).toBe(90);
  expect(new Set(plan.packages.map(pkg => `${pkg.directory}\0${pkg.version}`)).size).toBe(plan.packages.length);
  const versions = (name: string): string[] => plan.packages.filter(pkg => pkg.name === name).map(pkg => pkg.version).sort();
  expect(versions('@aws-sdk/token-providers')).toEqual(['3.1127.0', '3.1150.0']);
  expect(versions('https-proxy-agent')).toEqual(['7.0.6', '9.1.0']);
  expect(versions('agent-base')).toEqual(['7.1.4', '9.0.0']);
  for (const name of ['https-proxy-agent', 'agent-base', '@aws-sdk/token-providers']) {
    expect(new Set(plan.packages.filter(pkg => pkg.name === name).map(pkg => pkg.instance)).size).toBe(2);
  }
  expect(plan.packageSha256).toBe(digest(await readFile(resolve(root, 'package.json'))));
  expect(plan.lockSha256).toBe(digest(await readFile(resolve(root, 'bun.lock'))));
  expect(plan.exclusions.filter(entry => entry.reason.startsWith('Provided by Bun')).map(entry => entry.name).sort()).toEqual(['node-fetch', 'undici', 'ws', 'ws']);
  expect(plan.exclusions.filter(entry => entry.reason.startsWith('Optional')).map(entry => entry.name).sort()).toEqual(['@modelcontextprotocol/sdk', '@smithy/hash-node', 'kerberos']);
});

test('Seven upstream notices match actual installed package metadata and exact-version source evidence', async () => {
  const plan = await planNpmNotices(root);
  const packages = plan.packages.filter(pkg => pkg.upstream !== null);
  expect(packages.length).toBe(7);
  for (const pkg of packages) {
    const upstream = pkg.upstream;
    if (!upstream) throw new Error(`Expected reviewed upstream evidence: ${pkg.name}`);
    expect(upstream.packageJsonSha256).toBe(digest(await readFile(resolve(pkg.directory, 'package.json'))));
    const sourcePackage = upstream.evidence.find(entry => entry.file.endsWith('-source-package-raw'));
    if (!sourcePackage) throw new Error(`Missing exact-version source package evidence: ${pkg.name}`);
    const identity = evidenceIdentity.parse(JSON.parse((await readFile(resolve(source, sourcePackage.file))).toString('utf8')));
    expect(identity).toEqual({ name: pkg.name, version: pkg.version, license: upstream.license });
    const notice = pkg.notices[0];
    if (!notice) throw new Error(`Missing actual upstream notice: ${pkg.name}`);
    expect(digest(await readFile(notice.source))).toBe(upstream.licenseSha256);
    expect(upstream.licenseUrl).toContain(upstream.commit);
  }
  const webhook = packages.find(pkg => pkg.name === 'standardwebhooks');
  expect(webhook?.upstream?.upstreamLicensePath).toBe('libraries/LICENSE');
  expect(webhook?.upstream?.license).toBe('MIT');
});

test('Corrupting a copied real upstream license is rejected before collection', async () => {
  const directory = await temporary();
  try {
    await cp(source, resolve(directory, 'source'), { recursive: true });
    const loaded = await loadNpmSourceEvidence(resolve(directory, 'source'));
    const entry = loaded.entries.find(item => item.name === '@earendil-works/pi-ai');
    if (!entry) throw new Error('The installed official Pi AI license evidence is absent.');
    const path = resolve(directory, 'source', entry.licenseFile);
    await writeFile(path, Buffer.concat([await readFile(path), Buffer.from('\n')]));
    await expect(loadNpmSourceEvidence(resolve(directory, 'source'))).rejects.toThrow('License evidence changed or is corrupt');
  } finally { await removeTemporary(directory); }
});

test('Actual export fails closed for the unlicensed Negotiate package without writing a misleading partial bundle', async () => {
  const directory = await temporary();
  try {
    const plan = await planNpmNotices(root);
    expect(plan.missing.length).toBe(1);
    expect(plan.missing[0]).toContain('proxy-agent-negotiate@1.1.0');
    await expect(exportNpmNotices(directory)).rejects.toBeInstanceOf(NpmLicenseError);
    await expect(exportNpmNotices(directory)).rejects.toThrow('proxy-agent-negotiate@1.1.0');
    expect(await readdir(directory)).toEqual([]);
  } finally { await removeTemporary(directory); }
});
