import { test, expect } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { planNpmNotices } from '../scripts/npm-notices';
import { assertBuildOutputPathsSafe } from '../scripts/prepare-ocs-source';

const root = resolve(import.meta.dir, '..');

test('Actual minified launcher retains Negotiate inside Playwright despite losing its npm package name', async () => {
  const directory = await mkdtemp(resolve(root, 'work/npm-artifact-test-'));
  try {
    const executable = resolve(directory, 'launcher.exe');
    const build = await Bun.build({ entrypoints: [resolve(root, 'desktop/bun/launch.ts')], target: 'bun', minify: true,
      external: ['chromium-bidi/*'], metafile: true, compile: { outfile: executable, autoloadDotenv: false, autoloadBunfig: false } });
    if (!build.success) throw new AggregateError(build.logs, 'Actual launcher artifact verification failed.');
    if (!build.metafile) throw new Error('Actual compile did not provide output contribution metadata.');
    const contributed = Object.values(build.metafile.outputs).flatMap(output => Object.entries(output.inputs).filter(([, input]) => input.bytesInOutput > 0).map(([path]) => path.replaceAll('\\', '/')));
    expect(contributed.some(path => path.endsWith('/playwright-core/lib/utilsBundle.js'))).toBe(true);
    expect(contributed.some(path => path.includes('/node_modules/proxy-agent-negotiate/'))).toBe(false);
    const binary = await readFile(executable);
    expect(binary.includes(Buffer.from('proxy-agent-negotiate'))).toBe(false);
    // Unique implementation constants survive minification; absence of the module name is not exclusion proof.
    for (const token of ['Expected Negotiate scheme but got', 'Kerberos client.step() returned no token', 'HTTP@proxy', 'GSS_MECH_OID_SPNEGO']) {
      expect(binary.includes(Buffer.from(token))).toBe(true);
    }
    const upstreamBundle = await readFile(resolve(root, 'node_modules/playwright-core/lib/utilsBundle.js'), 'utf8');
    expect(upstreamBundle).toContain('// node_modules/proxy-agent-negotiate/dist/index.js');
    const sidecar = await readFile(resolve(root, 'node_modules/playwright-core/lib/utilsBundle.js.LICENSE'), 'utf8');
    const start = sidecar.indexOf('%% proxy-agent-negotiate@1.1.0 NOTICES AND INFORMATION BEGIN HERE');
    const end = sidecar.indexOf('END OF proxy-agent-negotiate@1.1.0 NOTICES AND INFORMATION', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(sidecar.slice(start, end)).toContain('(no license text found; declared licenses: MIT)');
    const plan = await planNpmNotices(root);
    expect(plan.missing.some(message => message.includes('proxy-agent-negotiate@1.1.0'))).toBe(true);
  } finally {
    await assertBuildOutputPathsSafe(directory);
    await rm(directory, { recursive: true, force: false });
  }
}, 60000);
