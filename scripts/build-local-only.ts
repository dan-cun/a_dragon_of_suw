import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import packageMetadata from '../package.json';
import { ocsjsModuleFiles } from './build-metadata';
import { NpmLicenseError, planNpmNotices, type NpmNoticePlan } from './npm-notices';
import { assertBuildOutputPathsSafe, verifyOcsBrowser, verifyOcsSource } from './prepare-ocs-source';
import { verifyOcsjsSource } from './verify-ocsjs-source';
import { releaseVersionSchema, windowsVersion } from './version';
import { releaseEditionSchema } from '../desktop/shared/edition';

export const localOnlyInstallTarget = 'C:/Users/ZhuangQ/AppData/Local/Programs/SWU-Daka';
export const localOnlyLabels = ['LOCAL_ONLY', 'TEST_ONLY', 'RELEASE_BLOCKED'] as const;
const projectRoot = resolve(import.meta.dir, '..');
const absolutePathSchema = z.string().min(1).refine(isAbsolute, 'An explicit absolute path is required.');
const revisionSchema = z.string().regex(/^[a-f0-9]{40}$/);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const reviewedGapPrefix = 'proxy-agent-negotiate@1.1.0 (';
const missingLicensesSchema = z.array(z.string()).max(1).refine(entries => entries.every(entry => entry.startsWith(reviewedGapPrefix)), 'Only the reviewed proxy-agent-negotiate@1.1.0 license gap is permitted.');
const buildInfoSchema = z.object({
  schemaVersion: z.literal(1), labels: z.tuple([z.literal('LOCAL_ONLY'), z.literal('TEST_ONLY'), z.literal('RELEASE_BLOCKED')]),
  version: releaseVersionSchema, edition: releaseEditionSchema,
  source: absolutePathSchema, sourceRevision: revisionSchema,
  revisionVerification: z.literal('Caller-supplied final revision; no Git command is executed by this build chain.'),
  installTarget: z.literal(localOnlyInstallTarget),
  inputs: z.object({ engine: absolutePathSchema, browser: absolutePathSchema, bunVersion: z.string().min(1), ocsCommit: revisionSchema, ocsjsCommit: revisionSchema }),
  packageSha256: digestSchema, lockSha256: digestSchema, executableSha256: digestSchema,
  unresolvedLicenses: missingLicensesSchema, npmPhysicalInstances: z.number().int().positive(),
  formalBuildSucceeded: z.literal(false), formalReleaseAllowed: z.literal(false), localOnlyBuildSucceeded: z.literal(true),
  engineRebuiltFromSource: z.literal(false), externalGplScriptBundled: z.literal(false), builtAt: z.iso.datetime()
});
type LocalOnlyBuildInfo = z.infer<typeof buildInfoSchema>;
export type LocalOnlyBuildInputs = { source: string; output: string; engine: string; browser: string; revision: string };

export function requiredAbsolutePath(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '' || !isAbsolute(value) || /[\r\n"]/.test(value)) throw new TypeError(`${name} must explicitly specify an absolute path without quotes or newlines.`);
  return resolve(value);
}

function contains(directory: string, path: string): boolean {
  const suffix = relative(directory, path);
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`));
}

export function assertLocalOnlyOutputSeparate(output: string, protectedPaths: readonly string[]): void {
  if (protectedPaths.some(path => contains(path, output) || contains(output, path))) throw new RangeError(`LOCAL_ONLY output overlaps source, inputs, payload or installed application: ${output}. Protected paths: ${protectedPaths.join('; ')}`);
}

async function requireDirectory(path: string): Promise<void> {
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new TypeError(`Expected an existing real input directory: ${path}.`);
}

export async function localOnlyBuildInputs(): Promise<LocalOnlyBuildInputs> {
  const source = requiredAbsolutePath('SWU_BUILD_SOURCE');
  const output = requiredAbsolutePath('SWU_BUILD_OUTPUT');
  const engine = requiredAbsolutePath('SWU_ENGINE_DIST');
  const browser = requiredAbsolutePath('SWU_OCS_BROWSER_DIST');
  const revision = process.env['SWU_SOURCE_REVISION'];
  if (revision === undefined || !revisionSchema.safeParse(revision).success) throw new TypeError('SWU_SOURCE_REVISION must explicitly supply the final lowercase 40-hex source revision. No Git lookup is performed.');
  for (const path of [source, engine, browser]) await requireDirectory(path);
  if ((await realpath(source)).toLowerCase() !== (await realpath(projectRoot)).toLowerCase()) throw new RangeError(`SWU_BUILD_SOURCE must identify the source containing this script: ${projectRoot}; received ${source}.`);
  assertLocalOnlyOutputSeparate(output, [source, engine, browser, localOnlyInstallTarget]);
  await assertBuildOutputPathsSafe(output);
  return { source, output, engine, browser, revision };
}

async function fileHash(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function verifiedCopy(source: string, target: string, expected: string): Promise<void> {
  const bytes = await readFile(source);
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new NpmLicenseError(`LOCAL_ONLY license input changed: ${source}; expected SHA-256 ${expected}.`);
  await writeFile(target, bytes, { flag: 'wx' });
}

async function writeJson(path: string, value: object): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
}

async function localOnlyNoticePlan(source: string): Promise<NpmNoticePlan> {
  const plan = await planNpmNotices(source);
  if (!missingLicensesSchema.safeParse(plan.missing).success) throw new NpmLicenseError(`LOCAL_ONLY authorization does not cover these missing licenses:\n${plan.missing.join('\n')}`);
  return plan;
}

/** Preserve every collected notice and unresolved marker without weakening the formal exporter. */
async function exportLocalOnlyNotices(source: string, output: string, plan: NpmNoticePlan): Promise<void> {
  const destination = resolve(output, 'licenses/npm');
  await mkdir(destination);
  for (const pkg of plan.packages) {
    const target = resolve(destination, pkg.name, pkg.version, pkg.instance);
    await mkdir(target, { recursive: true });
    await verifiedCopy(resolve(pkg.directory, 'package.json'), resolve(target, 'package.json'), pkg.packageJsonSha256);
    for (const notice of pkg.notices) await verifiedCopy(notice.source, resolve(target, notice.name), notice.sha256);
    if (pkg.upstream !== null) {
      await writeJson(resolve(target, 'provenance.json'), pkg.upstream);
      await mkdir(resolve(target, 'evidence'));
      for (const evidence of pkg.upstream.evidence) await verifiedCopy(resolve(source, 'licenses/npm-source', evidence.file), resolve(target, 'evidence', evidence.file), evidence.sha256);
    }
  }
  if (await fileHash(resolve(source, 'package.json')) !== plan.packageSha256 || await fileHash(resolve(source, 'bun.lock')) !== plan.lockSha256) throw new NpmLicenseError('LOCAL_ONLY package.json or bun.lock changed after license planning. Build again from the final source.');
  await writeJson(resolve(destination, 'manifest.json'), { schemaVersion: 1, complete: plan.missing.length === 0, labels: localOnlyLabels, formalReleaseAllowed: false, ...plan });
  await writeFile(resolve(destination, 'versions.txt'), [...new Set(plan.packages.map(pkg => `${pkg.name} ${pkg.version}`))].sort().join('\n') + '\n', { flag: 'wx' });
  await writeFile(resolve(destination, 'UNRESOLVED-LICENSES.txt'), `${localOnlyLabels.join(' / ')}\nNo missing license text is fabricated. Public redistribution is not authorized.\n${plan.missing.join('\n')}\n`, { flag: 'wx' });
}

/** Verify only the executable, identity fields and license markers needed to package this local build. */
export async function verifyLocalOnlyBuild(inputs: LocalOnlyBuildInputs): Promise<LocalOnlyBuildInfo> {
  const metadata = buildInfoSchema.parse(JSON.parse(await readFile(resolve(inputs.output, 'LOCAL_ONLY_BUILD_INFO.json'), 'utf8')));
  if (metadata.source !== inputs.source || metadata.sourceRevision !== inputs.revision || metadata.version !== packageMetadata.version || metadata.edition !== packageMetadata.edition || metadata.inputs.engine !== inputs.engine || metadata.inputs.browser !== inputs.browser) throw new TypeError('LOCAL_ONLY build identity does not match the explicitly supplied final source, revision, version, edition, engine or browser.');
  if (metadata.executableSha256 !== await fileHash(resolve(inputs.output, '打卡助手.exe'))) throw new TypeError('LOCAL_ONLY executable SHA-256 differs from LOCAL_ONLY_BUILD_INFO.json.');
  if (metadata.packageSha256 !== await fileHash(resolve(inputs.source, 'package.json')) || metadata.lockSha256 !== await fileHash(resolve(inputs.source, 'bun.lock'))) throw new TypeError('LOCAL_ONLY build dependency metadata differs from the final source.');
  const marker = await readFile(resolve(inputs.output, 'LOCAL_ONLY_TEST_ONLY_RELEASE_BLOCKED.txt'), 'utf8');
  const unresolved = await readFile(resolve(inputs.output, 'licenses/npm/UNRESOLVED-LICENSES.txt'), 'utf8');
  if (!localOnlyLabels.every(label => marker.includes(label) && unresolved.includes(label)) || !metadata.unresolvedLicenses.every(gap => unresolved.includes(gap))) throw new TypeError('LOCAL_ONLY labels or unresolved-license markers are missing or inconsistent.');
  return metadata;
}

async function buildLocalOnly(): Promise<void> {
  const inputs = await localOnlyBuildInputs();
  const { source, output, engine, browser } = inputs;
  for (const path of [resolve(engine, 'lepao-engine.exe'), resolve(engine, 'mitmweb.exe'), resolve(source, 'assets/icon.ico')]) {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size === 0) throw new TypeError(`LOCAL_ONLY build input must be an existing nonempty regular file: ${path}.`);
  }
  const ocs = await verifyOcsSource();
  const ocsjs = await verifyOcsjsSource(source);
  await verifyOcsBrowser(browser);
  const plan = await localOnlyNoticePlan(source);
  // A fresh directory is mandatory; existing payloads and installations are never overwritten here.
  await mkdir(output);
  const result = await Bun.build({
    entrypoints: [resolve(source, 'desktop/bun/launch.ts')], target: 'bun', minify: true, external: ['chromium-bidi/*'],
    compile: {
      outfile: resolve(output, '打卡助手.exe'), autoloadDotenv: false, autoloadBunfig: false,
      windows: { icon: resolve(source, 'assets/icon.ico'), hideConsole: true,
        title: `西大日常 ${packageMetadata.version} · ${localOnlyLabels.join(' / ')}`,
        publisher: 'swu-daka contributors / dan-cun', version: windowsVersion(packageMetadata.version),
        description: 'LOCAL_ONLY / TEST_ONLY / RELEASE_BLOCKED - not a formal release', copyright: 'Copyright (c) 2026 dan-cun' }
    }
  });
  if (!result.success) throw new AggregateError(result.logs, 'LOCAL_ONLY Windows EXE build failed.');
  await cp(engine, resolve(output, 'engine'), { recursive: true });
  await mkdir(resolve(output, 'modules/ocs'), { recursive: true });
  await cp(browser, resolve(output, 'modules/ocs/browser'), { recursive: true });
  await cp(resolve(source, 'vendor/ocs/source-manifest.json'), resolve(output, 'modules/ocs/source-manifest.json'));
  await cp(resolve(source, 'vendor/ocs', ocsjsModuleFiles.manifest), resolve(output, 'modules/ocs', ocsjsModuleFiles.manifest));
  await cp(ocsjs.licenseFile, resolve(output, 'modules/ocs', ocsjsModuleFiles.license));
  await cp(ocsjs.provenanceFile, resolve(output, 'modules/ocs', ocsjsModuleFiles.provenance));
  await cp(resolve(source, 'licenses'), resolve(output, 'licenses'), { recursive: true });
  await mkdir(resolve(output, 'licenses/lepao3'), { recursive: true });
  for (const name of ['LICENSE', 'NOTICE', 'DISCLAIMER.md']) await cp(resolve(source, 'vendor/lepao3', name), resolve(output, 'licenses/lepao3', name));
  await cp(resolve(source, 'LICENSE'), resolve(output, 'LICENSE.txt'));
  await cp(resolve(source, 'NOTICE'), resolve(output, 'NOTICE'));
  await cp(resolve(source, 'DISCLAIMER.md'), resolve(output, 'DISCLAIMER.md'));
  await mkdir(resolve(output, 'sources/ocs'), { recursive: true });
  await cp(resolve(source, 'vendor/ocs/source'), resolve(output, 'sources/ocs/desktop-2.12.0'), { recursive: true });
  await cp(ocsjs.sourceDirectory, resolve(output, 'sources/ocs/ocsjs-5.2.1'), { recursive: true });
  await exportLocalOnlyNotices(source, output, plan);
  const metadata = buildInfoSchema.parse({
    schemaVersion: 1, labels: localOnlyLabels, version: packageMetadata.version, edition: packageMetadata.edition,
    source, sourceRevision: inputs.revision, revisionVerification: 'Caller-supplied final revision; no Git command is executed by this build chain.',
    installTarget: localOnlyInstallTarget, inputs: { engine, browser, bunVersion: Bun.version, ocsCommit: ocs.commit, ocsjsCommit: ocsjs.manifest.commit },
    packageSha256: plan.packageSha256, lockSha256: plan.lockSha256, executableSha256: await fileHash(resolve(output, '打卡助手.exe')),
    unresolvedLicenses: plan.missing, npmPhysicalInstances: plan.packages.length,
    formalBuildSucceeded: false, formalReleaseAllowed: false, localOnlyBuildSucceeded: true, engineRebuiltFromSource: false, externalGplScriptBundled: false, builtAt: new Date().toISOString()
  });
  await writeJson(resolve(output, 'LOCAL_ONLY_BUILD_INFO.json'), metadata);
  await writeFile(resolve(output, 'LOCAL_ONLY_TEST_ONLY_RELEASE_BLOCKED.txt'), `${localOnlyLabels.join(' / ')}\n本机专用测试包，非正式发行，禁止对外分发。正式许可门禁不变。\n`, { flag: 'wx' });
  await writeFile(resolve(output, '使用说明.txt'), `西大日常 · ${localOnlyLabels.join(' / ')}\n仅限本机测试使用，禁止对外分发；proxy-agent-negotiate@1.1.0 适用许可全文仍缺失时不得正式发布。\n源码版本：${inputs.revision}\n安装目标：${localOnlyInstallTarget}\n安装前请本人正常退出应用；本机安装器不自动关闭、强杀或启动应用，不删除用户数据。\n沿用既有引擎与 Chrome，未证明引擎可从源码跨机重建。\n固定外部 GPL 用户脚本不打入包，仅在应用内经明确确认独立下载。\n本机打包不是模型、课程、录音或真实账号业务验证。\n`, { flag: 'wx' });
  await verifyLocalOnlyBuild(inputs);
  console.log(JSON.stringify({ event: 'local-only-build-complete', output, sourceRevision: inputs.revision, labels: localOnlyLabels, formalReleaseAllowed: false }));
}

if (import.meta.main) await buildLocalOnly();
