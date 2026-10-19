import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';

import { releaseVersionSchema } from './version';
import { releaseEdition, releaseEditionSchema } from '../desktop/shared/edition';

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const schema = z.object({ version: releaseVersionSchema, edition: releaseEditionSchema, sha256: digestSchema, files: z.record(z.string(), digestSchema) });

async function bundleHashes(directory: string): Promise<Record<string, string>> {
  const files: string[] = ['LICENSE.txt', 'NOTICE', 'DISCLAIMER.md'];
  async function visit(relative: string): Promise<void> {
    for (const entry of await readdir(resolve(directory, relative), { withFileTypes: true })) {
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error(`Unexpected bundle entry: ${path}`);
    }
  }
  await visit('engine'); await visit('licenses');
  const hashes: Record<string, string> = {};
  for (const path of files.sort()) hashes[path] = createHash('sha256').update(await readFile(resolve(directory, path))).digest('hex');
  return hashes;
}

async function executableHash(directory: string): Promise<string> {
  return createHash('sha256').update(await readFile(resolve(directory, '打卡助手.exe'))).digest('hex');
}

export async function writeBuildMetadata(directory: string, version: string): Promise<void> {
  const metadata = schema.parse({ version, edition: releaseEdition, sha256: await executableHash(directory), files: await bundleHashes(directory) });
  await writeFile(resolve(directory, 'build-info.json'), JSON.stringify(metadata, null, 2), 'utf8');
}

export async function verifyBuildMetadata(directory: string, version: string): Promise<void> {
  const path = resolve(directory, 'build-info.json');
  const metadata = schema.parse(JSON.parse(await readFile(path, 'utf8')));
  if (metadata.version !== version) throw new Error(`Build version mismatch: executable ${metadata.version}, package ${version}. Run bun run build first.`);
  if (metadata.edition !== releaseEdition) throw new Error('Build edition mismatch. Build and package each edition in its own output directory.');
  if (metadata.sha256 !== await executableHash(directory)) throw new Error('Executable hash does not match build-info.json. Run bun run build before packaging.');
  if (JSON.stringify(metadata.files) !== JSON.stringify(await bundleHashes(directory))) throw new Error('Engine or license files do not match the current build. Run bun run build before packaging.');
}
