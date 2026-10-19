import { test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { assertOcsBuildOutputIsolated, ocsjsModuleFiles, verifyOcsBuildResources } from '../scripts/build-metadata';
import { assertBuildOutputPathsSafe, ocsBrowserDirectory, verifyOcsBrowser } from '../scripts/prepare-ocs-source';
import { verifyOcsjsSource } from '../scripts/verify-ocsjs-source';

const projectRoot = resolve(import.meta.dir, '..');

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function temporaryDirectory(): Promise<string> {
  const temporary = process.env['TEMP'];
  if (!temporary) throw new Error('Set TEMP to the verified project temporary directory before build resource tests.');
  return mkdtemp(join(temporary, 'swu-build-ocsjs-'));
}

async function removeTemporaryDirectory(directory: string): Promise<void> {
  await assertBuildOutputPathsSafe(directory);
  await rm(directory, { recursive: true, force: false });
}

test('Build resources preserve real OCSJS source metadata and reject altered or unexpected module files', async () => {
  const directory = await temporaryDirectory();
  try {
    const ocsjs = await verifyOcsjsSource(projectRoot);
    const browser = ocsBrowserDirectory();
    await verifyOcsBrowser(browser);
    const module = resolve(directory, 'modules/ocs');
    await mkdir(module, { recursive: true });
    await cp(browser, resolve(module, 'browser'), { recursive: true });
    await cp(resolve(projectRoot, 'vendor/ocs/source-manifest.json'), resolve(module, 'source-manifest.json'));
    await cp(resolve(projectRoot, 'vendor/ocs', ocsjsModuleFiles.manifest), resolve(module, ocsjsModuleFiles.manifest));
    await cp(ocsjs.licenseFile, resolve(module, ocsjsModuleFiles.license));
    await cp(ocsjs.provenanceFile, resolve(module, ocsjsModuleFiles.provenance));
    await mkdir(resolve(directory, 'licenses'), { recursive: true });
    await cp(resolve(projectRoot, 'licenses/ocs'), resolve(directory, 'licenses/ocs'), { recursive: true });
    await verifyOcsBuildResources(directory);
    expect(ocsjs.manifest.fileCount).toBe(125);
    expect(ocsjs.manifest.runtimeEnabled).toBe(false);
    for (const name of ['source-manifest.json', ...Object.values(ocsjsModuleFiles)]) {
      const path = resolve(module, name);
      const original = await readFile(path);
      await writeFile(path, Buffer.concat([original, Buffer.from('\n')]), 'utf8');
      await expect(verifyOcsBuildResources(directory)).rejects.toThrow('Bundled OCS resource does not match');
      await writeFile(path, original);
    }
    const licensed = resolve(directory, 'licenses/ocs', ocsjsModuleFiles.license);
    const license = await readFile(licensed);
    await writeFile(licensed, Buffer.concat([license, Buffer.from('\n')]), 'utf8');
    await expect(verifyOcsBuildResources(directory)).rejects.toThrow('Bundled OCS license hash mismatch');
    await writeFile(licensed, license);
    const unexpected = resolve(module, 'unexpected-source-manifest.json');
    await cp(resolve(module, ocsjsModuleFiles.manifest), unexpected);
    await expect(assertOcsBuildOutputIsolated(directory)).rejects.toThrow('Legacy or unexpected OCS output');
    await unlink(unexpected);
    await verifyOcsBuildResources(directory);
  } finally {
    await removeTemporaryDirectory(directory);
  }
}, 60000);

test('Expanded module layout still rejects real ancestor and target junctions before reading external resources', async () => {
  const directory = await temporaryDirectory();
  const external = resolve(directory, 'external');
  const link = resolve(directory, 'output-link');
  await mkdir(external);
  const marker = resolve(external, 'marker');
  await cp(resolve(projectRoot, 'licenses/ocs', ocsjsModuleFiles.license), marker);
  const original = digest(await readFile(marker));
  try {
    await symlink(external, link, 'junction');
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    await expect(assertOcsBuildOutputIsolated(resolve(link, 'not-created/output'))).rejects.toThrow('reparse point');
    await unlink(link);
    for (const name of ['modules', 'licenses', 'engine']) {
      const output = resolve(directory, name);
      await mkdir(output);
      const target = resolve(output, name);
      await symlink(external, target, 'junction');
      await expect(assertOcsBuildOutputIsolated(output)).rejects.toThrow('reparse point');
      await unlink(target);
    }
    expect(digest(await readFile(marker))).toBe(original);
  } finally {
    await removeTemporaryDirectory(directory);
  }
}, 30000);
