import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import { createRequire, isBuiltin } from 'node:module';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';

const projectRoot = resolve(import.meta.dir, '..');
const sourceEvidenceSha256 = '13f1e8bd83165f68cb58c6da8d2128505a6a35d0339c6ec0fed072a046ae939d';
const packageNameSchema = z.string().regex(/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/);
const versionSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9.+_-]*$/);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const filenameSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/).refine(name => name !== '.' && name !== '..');
const dependencySchema = z.record(packageNameSchema, z.string());
const packageSchema = z.object({ name: packageNameSchema, version: versionSchema, license: z.string().optional(),
  dependencies: dependencySchema.optional(), optionalDependencies: dependencySchema.optional(), peerDependencies: dependencySchema.optional(),
  peerDependenciesMeta: z.record(z.string(), z.object({ optional: z.boolean().optional() })).optional(),
});
const evidenceFileSchema = z.object({ file: filenameSchema, sha256: digestSchema, url: z.url() });
const sourceEntrySchema = z.object({ name: packageNameSchema, version: versionSchema, packageJsonSha256: digestSchema,
  license: z.string().min(1), repository: z.url(), commit: z.string().regex(/^[a-f0-9]{40}$/), upstreamLicensePath: z.string().min(1),
  licenseUrl: z.url(), licenseFile: filenameSchema, licenseSha256: digestSchema,
  evidence: z.array(evidenceFileSchema).min(1), attribution: z.string().min(1),
});
const sourceSchema = z.object({ schemaVersion: z.literal(1), packages: z.array(sourceEntrySchema) });
export type NpmSourceEntry = z.infer<typeof sourceEntrySchema>;
type PackageMetadata = z.infer<typeof packageSchema>;
export interface NpmNoticeFile { source: string; name: string; sha256: string }
export interface NpmPackageNotice {
  name: string; version: string; directory: string; instance: string; packageJsonSha256: string;
  notices: NpmNoticeFile[]; upstream: NpmSourceEntry | null;
}
export interface NpmDependencyExclusion { name: string; parent: string; kind: string; reason: string }
export interface NpmNoticePlan {
  source: string; packageSha256: string; lockSha256: string; evidenceSha256: string;
  packages: NpmPackageNotice[]; exclusions: NpmDependencyExclusion[]; missing: string[];
}
export class NpmLicenseError extends Error { override name = 'NpmLicenseError'; }

function sha256(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
function isMissing(cause: unknown): boolean {
  return cause instanceof Error && 'code' in cause && (cause.code === 'ENOENT' || cause.code === 'ENOTDIR');
}
function inside(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`));
}
async function verifiedBytes(path: string, expected: string): Promise<Buffer> {
  const bytes = await readFile(path);
  if (sha256(bytes) !== expected) throw new NpmLicenseError(`License evidence changed or is corrupt: ${path}; expected SHA256 ${expected}.`);
  return bytes;
}

/** Load reviewed, version-specific upstream evidence; SPDX declarations alone are never license text. */
export async function loadNpmSourceEvidence(directory: string): Promise<{ entries: NpmSourceEntry[]; sha256: string }> {
  const bytes = await verifiedBytes(resolve(directory, 'provenance.json'), sourceEvidenceSha256);
  const metadata = sourceSchema.parse(JSON.parse(bytes.toString('utf8')));
  const seen = new Set<string>();
  for (const entry of metadata.packages) {
    const key = `${entry.name}@${entry.version}`;
    if (seen.has(key)) throw new NpmLicenseError(`Duplicate explicit upstream license evidence: ${key}.`);
    seen.add(key);
    if (!entry.licenseUrl.includes(entry.commit) || !entry.licenseUrl.startsWith('https://github.com/')) {
      throw new NpmLicenseError(`Upstream license URL must identify the reviewed immutable GitHub commit: ${key}.`);
    }
    await verifiedBytes(resolve(directory, entry.licenseFile), entry.licenseSha256);
    for (const evidence of entry.evidence) await verifiedBytes(resolve(directory, evidence.file), evidence.sha256);
  }
  return { entries: metadata.packages, sha256: sha256(bytes) };
}

async function installedPackage(name: string, parent: string, nodeModules: string): Promise<{ directory: string; metadata: PackageMetadata; hash: string } | null> {
  const lookup = createRequire(resolve(parent, 'package.json')).resolve.paths(name);
  for (const directory of lookup ?? []) {
    const candidate = resolve(directory, name, 'package.json');
    let bytes: Buffer;
    try { bytes = await readFile(candidate); }
    catch (cause) { if (isMissing(cause)) continue; throw cause; }
    const physical = await realpath(resolve(candidate, '..'));
    if (!inside(nodeModules, physical)) throw new NpmLicenseError(`Runtime dependency resolves outside this project's installed environment: ${name} from ${parent}: ${physical}.`);
    const metadata = packageSchema.parse(JSON.parse(bytes.toString('utf8')));
    if (metadata.name !== name) throw new NpmLicenseError(`Resolved package identity mismatch: requested ${name}, found ${metadata.name} in ${physical}.`);
    return { directory: physical, metadata, hash: sha256(bytes) };
  }
  return null;
}

/** Inspect the actual dependency graph from each parent directory, retaining physical instances and versions. */
export async function planNpmNotices(root: string): Promise<NpmNoticePlan> {
  const packageBytes = await readFile(resolve(root, 'package.json'));
  const lockBytes = await readFile(resolve(root, 'bun.lock'));
  const metadata = packageSchema.parse(JSON.parse(packageBytes.toString('utf8')));
  const nodeModules = await realpath(resolve(root, 'node_modules'));
  const evidenceDirectory = resolve(root, 'licenses/npm-source');
  const evidence = await loadNpmSourceEvidence(evidenceDirectory);
  const packages = new Map<string, NpmPackageNotice>();
  const exclusions: NpmDependencyExclusion[] = [];
  const missing: string[] = [];
  async function visit(name: string, parent: string, kind: string, optional: boolean): Promise<void> {
    const installed = await installedPackage(name, parent, nodeModules);
    if (!installed) {
      let resolved: string | null = null;
      try { resolved = createRequire(resolve(parent, 'package.json')).resolve(name); }
      catch (cause) {
        if (!(cause instanceof Error && 'code' in cause && cause.code === 'MODULE_NOT_FOUND')) throw cause;
      }
      // Bun exposes node-fetch as a compatibility module even though node:isBuiltin reports false.
      if (resolved === name && typeof Bun !== 'undefined' && (isBuiltin(name) || name === 'node-fetch')) {
        exclusions.push({ name, parent, kind, reason: `Provided by Bun ${Bun.version}: ${resolved}; no installed npm package instance.` });
        return;
      }
      if (optional) {
        exclusions.push({ name, parent, kind, reason: 'Optional dependency or optional peer is not installed.' });
        return;
      }
      throw new NpmLicenseError(`Required runtime dependency is missing: ${name}, kind ${kind}, parent ${parent}.`);
    }
    const { directory, metadata: pkg, hash } = installed;
    const identity = `${directory}\0${pkg.version}`;
    if (packages.has(identity)) return;
    const instance = sha256(Buffer.from(`${relative(nodeModules, directory).replaceAll('\\', '/')}\0${pkg.version}`)).slice(0, 16);
    const notices: NpmNoticeFile[] = [];
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      if (!/^(licen[cs]e|copying|notice)(\.|$)/i.test(entry.name)) continue;
      const path = resolve(directory, entry.name);
      if (!entry.isFile() || !(await stat(path)).isFile()) throw new NpmLicenseError(`Expected a regular package license/notice file: ${path}.`);
      notices.push({ source: path, name: entry.name, sha256: sha256(await readFile(path)) });
    }
    let upstream: NpmSourceEntry | null = null;
    if (notices.length === 0) {
      upstream = evidence.entries.find(entry => entry.name === name && entry.version === pkg.version) ?? null;
      if (!upstream) missing.push(`${name}@${pkg.version} (${directory}): no packaged license text and no reviewed exact-version upstream attribution evidence.`);
      else {
        if (upstream.packageJsonSha256 !== hash || upstream.license !== pkg.license) throw new NpmLicenseError(`Upstream evidence does not match the installed package metadata: ${name}@${pkg.version} (${directory}).`);
        notices.push({ source: resolve(evidenceDirectory, upstream.licenseFile), name: 'LICENSE', sha256: upstream.licenseSha256 });
      }
    }
    packages.set(identity, { name, version: pkg.version, directory, instance, packageJsonSha256: hash, notices, upstream });
    const required = pkg.dependencies ?? {};
    const optionalDependencies = pkg.optionalDependencies ?? {};
    const peers = pkg.peerDependencies ?? {};
    for (const dependency of [...new Set([...Object.keys(required), ...Object.keys(optionalDependencies), ...Object.keys(peers)])].sort()) {
      const isOptionalDependency = Object.hasOwn(optionalDependencies, dependency);
      const isRequired = Object.hasOwn(required, dependency) && !isOptionalDependency;
      const optionalPeer = pkg.peerDependenciesMeta?.[dependency]?.optional === true;
      await visit(dependency, directory, isOptionalDependency ? 'optional' : isRequired ? 'dependency' : 'peer', isOptionalDependency || (!isRequired && optionalPeer));
    }
  }
  for (const name of Object.keys(metadata.dependencies ?? {}).sort()) await visit(name, root, 'dependency', false);
  for (const name of Object.keys(metadata.optionalDependencies ?? {}).sort()) if (!Object.hasOwn(metadata.dependencies ?? {}, name)) await visit(name, root, 'optional', true);
  return { source: root, packageSha256: sha256(packageBytes), lockSha256: sha256(lockBytes), evidenceSha256: evidence.sha256,
    packages: [...packages.values()].sort((left, right) => `${left.name}@${left.version}/${left.instance}`.localeCompare(`${right.name}@${right.version}/${right.instance}`)), exclusions, missing };
}

/** Validate the entire runtime license plan without writing build output. */
export async function assertNpmNoticesComplete(root: string): Promise<NpmNoticePlan> {
  const plan = await planNpmNotices(root);
  if (plan.missing.length > 0) throw new NpmLicenseError(`Runtime license collection is blocked for ${plan.missing.length} package(s):\n${plan.missing.join('\n')}`);
  return plan;
}

/** Export only a complete verified plan. Incomplete licensing fails before any output is written. */
export async function exportNpmNotices(output: string): Promise<void> {
  const plan = await assertNpmNoticesComplete(projectRoot);
  const destination = resolve(output, 'licenses/npm');
  await mkdir(dirname(destination), { recursive: true });
  await mkdir(destination);
  const evidenceDirectory = resolve(projectRoot, 'licenses/npm-source');
  const entries: Array<{ name: string; version: string; directory: string; instance: string; packageJsonSha256: string; files: Record<string, string>; upstreamCommit: string | null }> = [];
  for (const pkg of plan.packages) {
    const target = resolve(destination, pkg.name, pkg.version, pkg.instance);
    await mkdir(target, { recursive: true });
    const files: Record<string, string> = {};
    for (const notice of pkg.notices) {
      await writeFile(resolve(target, notice.name), await verifiedBytes(notice.source, notice.sha256), { flag: 'wx' });
      files[notice.name] = notice.sha256;
    }
    if (pkg.upstream) {
      const provenance = Buffer.from(JSON.stringify(pkg.upstream, null, 2) + '\n');
      await writeFile(resolve(target, 'provenance.json'), provenance, { flag: 'wx' });
      files['provenance.json'] = sha256(provenance);
      await mkdir(resolve(target, 'evidence'));
      for (const evidence of pkg.upstream.evidence) {
        await writeFile(resolve(target, 'evidence', evidence.file), await verifiedBytes(resolve(evidenceDirectory, evidence.file), evidence.sha256), { flag: 'wx' });
        files[`evidence/${evidence.file}`] = evidence.sha256;
      }
    }
    await verifiedBytes(resolve(pkg.directory, 'package.json'), pkg.packageJsonSha256);
    entries.push({ name: pkg.name, version: pkg.version, directory: pkg.directory, instance: pkg.instance, packageJsonSha256: pkg.packageJsonSha256, files, upstreamCommit: pkg.upstream?.commit ?? null });
  }
  await verifiedBytes(resolve(projectRoot, 'package.json'), plan.packageSha256);
  await verifiedBytes(resolve(projectRoot, 'bun.lock'), plan.lockSha256);
  await verifiedBytes(resolve(evidenceDirectory, 'provenance.json'), plan.evidenceSha256);
  const versions = [...new Set(plan.packages.map(pkg => `${pkg.name} ${pkg.version}`))].sort();
  await writeFile(resolve(destination, 'versions.txt'), versions.join('\n') + '\n', { flag: 'wx' });
  await writeFile(resolve(destination, 'manifest.json'), JSON.stringify({ schemaVersion: 1, complete: true, output: resolve(output), source: plan.source,
    packageSha256: plan.packageSha256, lockSha256: plan.lockSha256, evidenceSha256: plan.evidenceSha256, packages: entries, exclusions: plan.exclusions }, null, 2) + '\n', { flag: 'wx' });
}

