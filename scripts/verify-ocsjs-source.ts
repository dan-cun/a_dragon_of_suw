import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { z } from 'zod';

const manifestPath = 'vendor/ocs/ocsjs-source-manifest.json';
const manifestDigest = '35bfe0d71cd09a3e14cd97fa273a9fcb6d815ec74d67797d3d007d04f93f2674';
const provenanceDigest = '2d4f649b321b552cac84cf0fbeeda5bda55bddc0d8d4d48172867edc7b9b4e93';
const licenseDigest = '93c026518ccf01f98e86610402f83b67960fc865a58c36580ff7f8af7064fb10';
const identity = {
  schemaVersion: z.literal(1),
  component: z.literal('OCS userscript'),
  repository: z.literal('https://github.com/ocsjs/ocsjs'),
  tag: z.literal('5.2.1'),
  commit: z.literal('8b25a3f44523a0d4b7373878488056f4aa478cf6'),
  sourceRoot: z.literal('vendor/ocs/ocsjs-5.2.1'),
};
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const assetSchema = z.strictObject({ url: z.url(), sha256: digestSchema, bytes: z.number().int().positive() });
const cdnSchema = assetSchema.extend({ comparison: z.string().min(1) });

function safeRelativePath(path: string): boolean {
  return path.length > 0 && !isAbsolute(path) && !/[\\:<>"|?*\x00-\x1f\x7f]/.test(path) &&
    path.split('/').every(segment => segment.length > 0 && segment !== '.' && segment !== '..' &&
      !/[. ]$/.test(segment) && !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(segment));
}

const filesSchema = z.record(z.string().refine(safeRelativePath, 'Unsafe source path'), digestSchema)
  .superRefine((files, context) => {
    const entries = Object.keys(files);
    if (entries.length !== 125) context.addIssue({ code: 'custom', message: 'Expected exactly 125 source files' });
    const kinds = new Map<string, 'file' | 'directory'>();
    const spellings = new Map<string, string>();
    for (const path of entries) {
      const segments = path.split('/');
      for (let index = 1; index <= segments.length; index++) {
        const name = segments.slice(0, index).join('/');
        const key = name.toLowerCase();
        const kind = index === segments.length ? 'file' : 'directory';
        if ((spellings.has(key) && spellings.get(key) !== name) || (kinds.has(key) && kinds.get(key) !== kind)) {
          context.addIssue({ code: 'custom', message: `Case collision or file/directory conflict: ${path}` });
        }
        spellings.set(key, name);
        kinds.set(key, kind);
      }
    }
  });

const manifestSchema = z.strictObject({
  ...identity,
  archive: assetSchema,
  release: z.strictObject({
    url: z.url(),
    assets: z.strictObject({ 'ocs.user.js': assetSchema, 'index.js': assetSchema, 'ocs.meta.js': assetSchema }),
  }),
  cdn: z.strictObject({ userscript: cdnSchema, configuration: cdnSchema, framework: cdnSchema, style: cdnSchema }),
  license: z.strictObject({
    spdx: z.literal('MIT'), copyright: z.literal('Copyright (c) 2022 enncy'), upstreamPath: z.literal('LICENSE'),
    distributionPath: z.literal('licenses/ocs/OCSJS-5.2.1-LICENSE'), sha256: z.literal(licenseDigest),
  }),
  provenancePath: z.literal('licenses/ocs/OCSJS-5.2.1-PROVENANCE.json'),
  researchEvidence: z.strictObject({
    manifestPath: z.string().min(1), manifestSha256: digestSchema, tagApi: z.url(),
    tagEvidenceSha256: digestSchema, verifiedDate: z.literal('2026-10-18'),
  }),
  fileCount: z.literal(125), sourceBytes: z.literal(1751894), runtimeEnabled: z.literal(false), files: filesSchema,
});
const provenanceSchema = z.strictObject({
  ...identity,
  sourceManifestPath: z.literal(manifestPath),
  licensePath: z.literal('licenses/ocs/OCSJS-5.2.1-LICENSE'),
  copyright: z.literal('Copyright (c) 2022 enncy'),
  scope: z.literal('The preserved MIT text belongs to OCS userscript source only; it does not license OCS Desktop, easy-us, ScriptCat or Tampermonkey.'),
  purpose: z.literal('Byte-exact source baseline for selective porting, not an enabled course runtime.'),
  runtimeDependenciesImported: z.literal(false), cdnBundlesImported: z.literal(false),
  note: z.literal('Original dependency declarations and upstream comments remain unchanged. Runtime dependencies require their own license review; missing easy-us license text does not prohibit copying this MIT-licensed OCS source.'),
});
const packageSchema = z.object({ name: z.literal('ocsjs'), version: z.literal('5.2.1'), license: z.literal('MIT') });

export type OcsjsSourceManifest = z.infer<typeof manifestSchema>;
export interface OcsjsSourceVerification {
  manifest: OcsjsSourceManifest;
  sourceDirectory: string;
  licenseFile: string;
  provenanceFile: string;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseJson<T>(bytes: Buffer, schema: z.ZodType<T>, path: string): T {
  try {
    return schema.parse(JSON.parse(bytes.toString('utf8')));
  } catch (cause) {
    throw new TypeError(`Invalid OCSJS JSON/schema: ${path}`, { cause });
  }
}

function assertDigest(bytes: Buffer, expected: string, path: string): void {
  const actual = sha256(bytes);
  if (actual !== expected) {
    throw new Error(`OCSJS SHA-256 mismatch: ${path}; expected ${expected}, received ${actual}. Restore pinned bytes; do not regenerate metadata to accept modifications.`);
  }
}

async function checkedStat(path: string, kind: 'file' | 'directory'): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || (kind === 'directory' ? !stat.isDirectory() : !stat.isFile())) {
    throw new TypeError(`OCSJS path must be a real ${kind}, not a link/junction or special entry: ${path}`);
  }
  if (kind === 'file' && stat.nlink !== 1) throw new TypeError(`OCSJS hardlinked file is not permitted: ${path}`);
}

async function checkAncestors(path: string): Promise<void> {
  const root = parse(path).root;
  await checkedStat(root, 'directory');
  let current = root;
  for (const segment of relative(root, path).split(sep).filter(segment => segment.length > 0)) {
    current = join(current, segment);
    await checkedStat(current, 'directory');
  }
}

async function checkedPath(root: string, path: string, kind: 'file' | 'directory'): Promise<string> {
  if (!safeRelativePath(path)) throw new TypeError(`Unsafe OCSJS project-relative path: ${path}`);
  const destination = resolve(root, path);
  const inside = relative(root, destination);
  if (isAbsolute(inside) || inside === '..' || inside.startsWith(`..${sep}`)) {
    throw new RangeError(`OCSJS path escapes project root: ${path}`);
  }
  const parts = path.split('/');
  let current = root;
  for (const [index, segment] of parts.entries()) {
    current = join(current, segment);
    await checkedStat(current, index === parts.length - 1 ? kind : 'directory');
  }
  return destination;
}

async function verifyTree(directory: string, manifest: OcsjsSourceManifest): Promise<void> {
  const expectedFiles = new Set(Object.keys(manifest.files));
  const expectedDirectories = new Set<string>();
  for (const path of expectedFiles) {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index++) expectedDirectories.add(parts.slice(0, index).join('/'));
  }
  const pending: string[] = [''];
  const seen = new Set<string>();
  let bytes = 0;
  while (pending.length > 0) {
    const local = pending.pop();
    if (local === undefined) throw new Error('OCSJS traversal stack is inconsistent.');
    const entries = await readdir(resolve(directory, local), { withFileTypes: true });
    for (const entry of entries) {
      const path = local === '' ? entry.name : `${local}/${entry.name}`;
      if (!safeRelativePath(path)) throw new TypeError(`Unsafe OCSJS filesystem path: ${path}`);
      const absolute = resolve(directory, path);
      if (entry.isDirectory()) {
        await checkedStat(absolute, 'directory');
        if (!expectedDirectories.has(path)) throw new Error(`Unexpected OCSJS directory: ${path}`);
        pending.push(path);
      } else {
        await checkedStat(absolute, 'file');
        const expected = manifest.files[path];
        if (expected === undefined || !expectedFiles.has(path)) throw new Error(`Unexpected OCSJS source file: ${path}`);
        const content = await readFile(absolute);
        assertDigest(content, expected, absolute);
        bytes += content.byteLength;
        seen.add(path);
      }
    }
  }
  const missing = [...expectedFiles].filter(path => !seen.has(path));
  if (missing.length > 0) throw new Error(`Missing OCSJS source files: ${missing.join(', ')}`);
  if (seen.size !== manifest.fileCount || bytes !== manifest.sourceBytes) {
    throw new Error(`OCSJS source totals mismatch: ${seen.size} files, ${bytes} bytes; expected 125 files, 1751894 bytes.`);
  }
}

/** Verify the pinned source without executing upstream code or modifying any bytes. */
export async function verifyOcsjsSource(projectRoot: string): Promise<OcsjsSourceVerification> {
  if (projectRoot.trim() === '' || !isAbsolute(projectRoot)) throw new TypeError('OCSJS projectRoot must be an explicit absolute directory.');
  const root = resolve(projectRoot);
  await checkAncestors(root);
  const manifestFile = await checkedPath(root, manifestPath, 'file');
  const manifestBytes = await readFile(manifestFile);
  const manifest = parseJson(manifestBytes, manifestSchema, manifestFile);
  // The byte anchor also rejects duplicate JSON keys and regenerated file listings.
  assertDigest(manifestBytes, manifestDigest, manifestFile);
  const sourceDirectory = await checkedPath(root, manifest.sourceRoot, 'directory');
  const licenseFile = await checkedPath(root, manifest.license.distributionPath, 'file');
  const provenanceFile = await checkedPath(root, manifest.provenancePath, 'file');
  const provenanceBytes = await readFile(provenanceFile);
  parseJson(provenanceBytes, provenanceSchema, provenanceFile);
  assertDigest(provenanceBytes, provenanceDigest, provenanceFile);
  await verifyTree(sourceDirectory, manifest);
  const packageFile = await checkedPath(sourceDirectory, 'package.json', 'file');
  parseJson(await readFile(packageFile), packageSchema, packageFile);
  const upstreamLicenseFile = await checkedPath(sourceDirectory, manifest.license.upstreamPath, 'file');
  const upstreamLicense = await readFile(upstreamLicenseFile);
  const distributedLicense = await readFile(licenseFile);
  assertDigest(upstreamLicense, licenseDigest, upstreamLicenseFile);
  assertDigest(distributedLicense, licenseDigest, licenseFile);
  if (!upstreamLicense.equals(distributedLicense)) throw new Error(`OCSJS license bytes differ: ${licenseFile}`);
  return { manifest, sourceDirectory, licenseFile, provenanceFile };
}

if (import.meta.main) {
  const result = await verifyOcsjsSource(resolve(import.meta.dir, '..'));
  console.info(JSON.stringify({ event: 'ocsjs-source-verified', tag: result.manifest.tag, commit: result.manifest.commit,
    files: result.manifest.fileCount, bytes: result.manifest.sourceBytes, runtimeEnabled: result.manifest.runtimeEnabled }));
}
