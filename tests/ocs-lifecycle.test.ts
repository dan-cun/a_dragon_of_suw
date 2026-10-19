import { expect, test } from 'bun:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';

const summarySchema = z.object({
  ok: z.boolean(), samples: z.number().int(), gcCount: z.number().int(), cleanupComplete: z.boolean(),
  native: z.array(z.object({ pid: z.number().int(), exited: z.boolean(), exitCode: z.number().nullable(), signal: z.string().nullable() })),
  timeline: z.string()
});
const observationTest = process.env['SWU_OCS_LIFECYCLE_INVESTIGATION'] === '1' ? test : test.skip;

observationTest('OCS real source and compiled runtimes preserve native Chrome stdio and ownership under full GC', async () => {
  const temporary = process.env['TEMP'];
  const duration = z.coerce.number().int().min(5000).max(180000).parse(process.env['SWU_OCS_LIFECYCLE_DURATION_MS']);
  if (!temporary) throw new Error('TEMP must be configured for isolated lifecycle evidence.');
  const root = await mkdtemp(join(temporary, 'swu-ocs-lifecycle-'));
  const fixture = resolve('tests/ocs-lifecycle-observation.ts');
  const executable = join(root, 'ocs-lifecycle-observation.exe');
  const compiled = await Bun.build({ entrypoints: [fixture], target: 'bun', minify: true, external: ['chromium-bidi/*'], compile: { outfile: executable, autoloadDotenv: false, autoloadBunfig: false } });
  if (!compiled.success) throw new AggregateError(compiled.logs, 'The isolated lifecycle observation EXE failed to compile.');
  const cases = [
    { name: 'source-baseline', command: [process.execPath, fixture], forceGc: false },
    { name: 'source-gc', command: [process.execPath, fixture], forceGc: true },
    { name: 'compiled-baseline', command: [executable], forceGc: false },
    { name: 'compiled-gc', command: [executable], forceGc: true }
  ];
  const results: { name: string; exitCode: number; summary: z.infer<typeof summarySchema> }[] = [];
  console.log(JSON.stringify({ event: 'ocs.lifecycle.evidence', root, duration, plannedCases: cases.map(item => item.name) }));
  for (const item of cases) {
    const directory = join(root, item.name);
    const child = Bun.spawn(item.command, {
      env: { ...Bun.env, DEBUG: '', SWU_OCS_LIFECYCLE_DIRECTORY: directory, SWU_OCS_LIFECYCLE_OPTIONS: JSON.stringify({ durationMs: duration, forceGc: item.forceGc }), SWU_OCS_LIFECYCLE_PARENT_STDIO: 'ignore' },
      stdin: 'ignore', stdout: 'ignore', stderr: 'ignore'
    });
    const exitCode = await child.exited;
    const summary = summarySchema.parse(JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8')));
    results.push({ name: item.name, exitCode, summary });
    await writeFile(join(root, 'results.json'), JSON.stringify({ plannedCases: cases.map(value => value.name), executedCases: results }, null, 2), 'utf8');
    console.log(JSON.stringify({ name: item.name, exitCode, summary }));
    expect(summary.cleanupComplete).toBe(true);
    expect(exitCode).toBe(0);
    expect(summary.ok).toBe(true);
    expect(summary.native).toHaveLength(3);
    expect(summary.native.every(value => value.exited)).toBe(true);
    if (item.forceGc) expect(summary.gcCount).toBeGreaterThan(0);
  }
}, 1_000_000);
