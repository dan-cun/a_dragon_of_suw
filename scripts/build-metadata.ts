import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';

import { releaseVersionSchema } from './version';
import { releaseEdition, releaseEditionSchema } from '../desktop/shared/edition';
import { assertBuildOutputPathsSafe, verifyOcsBrowser, verifyOcsSource } from './prepare-ocs-source';
import { verifyOcsjsSource } from './verify-ocsjs-source';

const projectRoot = resolve(import.meta.dir, '..');
export const ocsjsModuleFiles = {
  manifest: 'ocsjs-source-manifest.json',
  license: 'OCSJS-5.2.1-LICENSE',
  provenance: 'OCSJS-5.2.1-PROVENANCE.json',
} as const;
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const schema = z.object({ version: releaseVersionSchema, edition: releaseEditionSchema, ocs: z.literal('source-integrated'), ocsjsSource: z.literal('5.2.1'), sha256: digestSchema, files: z.record(z.string(), digestSchema) });

async function fileHash(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function directoryHashes(directory: string): Promise<Record<string, string>> {
  const root = await lstat(directory);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error(`Expected a real bundle directory, not a link: ${directory}`);
  const files: string[] = [];
  async function visit(relative: string): Promise<void> {
    for (const entry of await readdir(resolve(directory, relative), { withFileTypes: true })) {
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error(`Unexpected bundle entry: ${resolve(directory, path)}`);
    }
  }
  await visit('');
  const hashes: Record<string, string> = {};
  for (const path of files.sort()) hashes[path] = await fileHash(resolve(directory, path));
  return hashes;
}

export async function assertOcsBuildOutputIsolated(output: string): Promise<void> {
  await assertBuildOutputPathsSafe(output);
  const directory = resolve(output, 'modules/ocs');
  if (!existsSync(directory)) return;
  const files = new Set<string>(['source-manifest.json', ...Object.values(ocsjsModuleFiles)]);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if ((entry.name === 'browser' && entry.isDirectory()) || (files.has(entry.name) && entry.isFile())) continue;
    throw new Error(`Legacy or unexpected OCS output found: ${resolve(directory, entry.name)}. Set SWU_BUILD_OUTPUT to a new isolated directory; old OCS Desktop.exe/Electron files will not be copied or deleted.`);
  }
  if (existsSync(resolve(directory, 'browser'))) await verifyOcsBrowser(resolve(directory, 'browser'));
}

async function verifyFileCopy(source: string, bundled: string): Promise<void> {
  if (await fileHash(source) !== await fileHash(bundled)) throw new Error(`Bundled OCS resource does not match the verified source: ${bundled}`);
}

export async function verifyOcsBuildResources(output: string): Promise<void> {
  await assertOcsBuildOutputIsolated(output);
  await verifyOcsSource();
  const ocsjs = await verifyOcsjsSource(projectRoot);
  const module = resolve(output, 'modules/ocs');
  await verifyFileCopy(resolve(projectRoot, 'vendor/ocs/source-manifest.json'), resolve(module, 'source-manifest.json'));
  await verifyOcsBrowser(resolve(module, 'browser'));
  await verifyFileCopy(resolve(projectRoot, 'vendor/ocs', ocsjsModuleFiles.manifest), resolve(module, ocsjsModuleFiles.manifest));
  await verifyFileCopy(ocsjs.licenseFile, resolve(module, ocsjsModuleFiles.license));
  await verifyFileCopy(ocsjs.provenanceFile, resolve(module, ocsjsModuleFiles.provenance));
  const expected = await directoryHashes(resolve(projectRoot, 'licenses/ocs'));
  const actual = await directoryHashes(resolve(output, 'licenses/ocs'));
  for (const path of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    if (expected[path] !== actual[path]) throw new Error(`Bundled OCS license hash mismatch or unexpected/missing file: ${path}`);
  }
}

async function bundleHashes(directory: string): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const path of ['LICENSE.txt', 'NOTICE', 'DISCLAIMER.md']) hashes[path] = await fileHash(resolve(directory, path));
  for (const root of ['engine', 'licenses', 'modules']) {
    for (const [path, hash] of Object.entries(await directoryHashes(resolve(directory, root)))) hashes[`${root}/${path}`] = hash;
  }
  return Object.fromEntries(Object.entries(hashes).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
}

async function executableHash(directory: string): Promise<string> {
  return fileHash(resolve(directory, '打卡助手.exe'));
}

export async function writeBuildMetadata(directory: string, version: string): Promise<void> {
  await verifyOcsBuildResources(directory);
  const metadata = schema.parse({ version, edition: releaseEdition, ocs: 'source-integrated', ocsjsSource: '5.2.1', sha256: await executableHash(directory), files: await bundleHashes(directory) });
  await writeFile(resolve(directory, 'build-info.json'), JSON.stringify(metadata, null, 2), 'utf8');
}

export async function verifyBuildMetadata(directory: string, version: string): Promise<void> {
  await verifyOcsBuildResources(directory);
  const path = resolve(directory, 'build-info.json');
  const metadata = schema.parse(JSON.parse(await readFile(path, 'utf8')));
  if (metadata.version !== version) throw new Error(`Build version mismatch: executable ${metadata.version}, package ${version}. Run bun run build first.`);
  if (metadata.edition !== releaseEdition) throw new Error('Build edition mismatch. Build and package each edition in its own output directory.');
  if (metadata.sha256 !== await executableHash(directory)) throw new Error('Executable hash does not match build-info.json. Run bun run build before packaging.');
  if (JSON.stringify(metadata.files) !== JSON.stringify(await bundleHashes(directory))) throw new Error('Engine, OCS browser/source manifests, or license files do not match the current build. Run bun run build before packaging.');
}

