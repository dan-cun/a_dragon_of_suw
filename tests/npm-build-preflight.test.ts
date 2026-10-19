import { test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertNpmNoticesComplete, NpmLicenseError } from '../scripts/npm-notices';
import { assertBuildOutputPathsSafe } from '../scripts/prepare-ocs-source';

const root = resolve(import.meta.dir, '..');

async function iconFingerprint(name: string): Promise<{ sha256: string; mtimeMs: number }> {
  const path = resolve(root, 'assets', name);
  return { sha256: createHash('sha256').update(await readFile(path)).digest('hex'), mtimeMs: (await stat(path)).mtimeMs };
}

test('Complete runtime preflight rejects the real unresolved license', async () => {
  await expect(assertNpmNoticesComplete(root)).rejects.toBeInstanceOf(NpmLicenseError);
  await expect(assertNpmNoticesComplete(root)).rejects.toThrow('proxy-agent-negotiate@1.1.0');
});

test('Real build subprocess fails on licensing before icons, compilation or any output write', async () => {
  const directory = await mkdtemp(resolve(root, 'work/npm-build-preflight-test-'));
  try {
    const icons = await Promise.all(['icon.ico', 'icon.png'].map(iconFingerprint));
    const env: NodeJS.ProcessEnv = { ...process.env, SWU_BUILD_OUTPUT: resolve(directory, 'output') };
    for (const name of ['SWU_ENGINE_DIST', 'SWU_OCS_BROWSER_DIST', 'SWU_OCS_DIST']) delete env[name];
    const child = Bun.spawn([process.execPath, '--no-env-file', '--no-config', 'scripts/build.ts'], {
      cwd: root, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe'
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(1);
    expect(stderr).toContain('NpmLicenseError');
    expect(stderr).toContain('proxy-agent-negotiate@1.1.0');
    expect(stdout).not.toContain('Built:');
    expect(await readdir(directory)).toEqual([]);
    expect(await Promise.all(['icon.ico', 'icon.png'].map(iconFingerprint))).toEqual(icons);
  } finally {
    await assertBuildOutputPathsSafe(directory);
    await rm(directory, { recursive: true, force: false });
  }
}, 30_000);
