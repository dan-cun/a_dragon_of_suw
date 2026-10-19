import { readFile, readdir, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import packageMetadata from '../package.json';

export async function exportNpmNotices(output: string): Promise<void> {
  const seen = new Set<string>();
  const versions: string[] = [];
  const schema = z.object({ name: z.string(), version: z.string(), dependencies: z.record(z.string(), z.string()).optional() });
  async function visit(name: string): Promise<void> {
    if (seen.has(name)) return;
    seen.add(name);
    const directory = resolve('node_modules', name);
    const metadata = schema.parse(JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8')));
    const destination = resolve(output, 'licenses/npm', name);
    await mkdir(destination, { recursive: true });
    const notices = (await readdir(directory)).filter(file => /^(licen[cs]e|copying|notice)(\.|$)/i.test(file));
    if (notices.length === 0) throw new Error(`No license file found for runtime package ${name}.`);
    for (const file of notices) await copyFile(resolve(directory, file), resolve(destination, file));
    versions.push(`${metadata.name} ${metadata.version}`);
    for (const dependency of Object.keys(metadata.dependencies ?? {})) await visit(dependency);
  }
  for (const name of Object.keys(packageMetadata.dependencies)) await visit(name);
  await writeFile(resolve(output, 'licenses/npm/versions.txt'), versions.sort().join('\n') + '\n', 'utf8');
}
