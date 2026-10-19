import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';

const sourceRoot = resolve(import.meta.dir, '../vendor/ocs/source');
const manifestPath = resolve(import.meta.dir, '../vendor/ocs/source-manifest.json');
const licenseRoot = resolve(import.meta.dir, '../licenses/ocs');
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const filesSchema = z.record(z.string().regex(/^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[^\\:]+$/), digestSchema);
const provenance = {
  repository: 'https://github.com/ocsjs/ocs-desktop',
  release: 'v2.12.0',
  commit: '7e29272a3bdab0c84cb30ebc5935f1c3758ac52b',
  sourceUrl: 'https://codeload.github.com/ocsjs/ocs-desktop/zip/7e29272a3bdab0c84cb30ebc5935f1c3758ac52b',
  sourceZipSha256: '1111f492c0772157df1ca28b5804b2f2747b8af2a7c5d069fc0e488cfdef7a50',
  fileCount: 162,
  declaredLicense: 'MIT',
} as const;
const sourceManifestSchema = z.object({
  repository: z.literal(provenance.repository), release: z.literal(provenance.release),
  commit: z.literal(provenance.commit), sourceUrl: z.literal(provenance.sourceUrl),
  sourceZipSha256: z.literal(provenance.sourceZipSha256), fileCount: z.literal(provenance.fileCount),
  declaredLicense: z.literal(provenance.declaredLicense), files: filesSchema,
});
type SourceManifest = z.infer<typeof sourceManifestSchema>;
const browserManifestSchema = z.object({
  product: z.literal('Google Chrome'), version: z.literal('137.0.7151.55'),
  files: filesSchema, licenseFiles: filesSchema,
});

async function hashFile(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function fileHashes(directory: string): Promise<Record<string, string>> {
  const root = await lstat(directory);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error(`Expected a real directory, not a link: ${directory}`);
  const files: Record<string, string> = {};
  async function visit(relative: string): Promise<void> {
    const entries = await readdir(resolve(directory, relative), { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files[path] = await hashFile(resolve(directory, path));
      else throw new Error(`Unexpected link or non-file entry: ${resolve(directory, path)}`);
    }
  }
  await visit('');
  return files;
}

function assertHashes(expected: Record<string, string>, actual: Record<string, string>, label: string): void {
  for (const path of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    if (expected[path] !== actual[path]) throw new Error(`${label} hash mismatch or unexpected/missing file: ${path}. Restore the pinned resources; do not regenerate the manifest to accept modifications.`);
  }
}

async function sourceFiles(): Promise<Record<string, string>> {
  const metadata = z.object({ name: z.literal('ocs-desktop'), version: z.literal('2.12.0'), license: z.literal('MIT') });
  metadata.parse(JSON.parse(await readFile(resolve(sourceRoot, 'package.json'), 'utf8')));
  const files = await fileHashes(sourceRoot);
  if (Object.keys(files).length !== provenance.fileCount) throw new Error(`OCS source must contain exactly ${provenance.fileCount} files; found ${Object.keys(files).length}. Use vendor/ocs/source, not temporary or compiled release files.`);
  return files;
}

export async function verifyOcsSource(): Promise<SourceManifest> {
  if (!existsSync(manifestPath)) throw new Error('OCS source manifest is missing. Run bun scripts/prepare-ocs-source.ts against the verified vendor/ocs/source first.');
  const manifest = sourceManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
  if (Object.keys(manifest.files).length !== provenance.fileCount) throw new Error('OCS source manifest must list all 162 pinned source files.');
  assertHashes(manifest.files, await sourceFiles(), 'OCS source');
  return manifest;
}

export function ocsBrowserDirectory(): string {
  const browser = process.env['SWU_OCS_BROWSER_DIST'];
  if (browser !== undefined) {
    if (browser.trim() === '') throw new Error('SWU_OCS_BROWSER_DIST must be the full Chrome directory containing chrome.exe, not an empty path.');
    return resolve(browser);
  }
  const legacy = process.env['SWU_OCS_DIST'];
  if (legacy !== undefined && legacy.trim() !== '') {
    console.warn('SWU_OCS_DIST is used only to read resources/bin/chrome/chrome for development. Set SWU_OCS_BROWSER_DIST explicitly; the OCS application and Electron are never copied.');
    return resolve(legacy, 'resources/bin/chrome/chrome');
  }
  throw new Error('Set SWU_OCS_BROWSER_DIST to the verified full Chrome directory containing chrome.exe. OCS Desktop.exe and Electron are not build inputs.');
}

export async function verifyOcsBrowser(directory: string): Promise<void> {
  const manifest = browserManifestSchema.parse(JSON.parse(await readFile(resolve(licenseRoot, 'browser.json'), 'utf8')));
  for (const path of ['chrome.exe', 'chrome.dll', 'resources.pak', 'icudtl.dat', 'ABOUT']) {
    if (manifest.files[path] === undefined) throw new Error(`OCS browser manifest is missing required Chrome file: ${path}`);
  }
  for (const path of ['Chrome-ABOUT', 'Chrome-credits.html']) {
    if (manifest.licenseFiles[path] === undefined) throw new Error(`OCS browser manifest is missing required license: ${path}`);
  }
  assertHashes(manifest.files, await fileHashes(directory), 'OCS browser');
  for (const [path, hash] of Object.entries(manifest.licenseFiles)) {
    if (await hashFile(resolve(licenseRoot, path)) !== hash) throw new Error(`OCS browser license hash mismatch: ${path}`);
  }
}

export async function assertBuildOutputPathsSafe(output: string): Promise<void> {
  const command = String.raw`
$ErrorActionPreference = 'Stop'
trap { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
function Get-ExistingOutputEntry([string] $Path) {
  try { return Get-Item -LiteralPath $Path -Force -ErrorAction Stop }
  catch [System.Management.Automation.ItemNotFoundException] { return $null }
}
function Assert-OutputEntry([System.IO.FileSystemInfo] $Item) {
  if (($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw ('Unsafe build output reparse point: ' + $Item.FullName + '. Set SWU_BUILD_OUTPUT to a new isolated directory.')
  }
}
function Assert-OutputDirectory([System.IO.FileSystemInfo] $Item) {
  Assert-OutputEntry $Item
  if ($Item -isnot [System.IO.DirectoryInfo]) {
    throw ('Build output path must be a regular directory: ' + $Item.FullName + '. Set SWU_BUILD_OUTPUT to a new isolated directory.')
  }
}
$output = [System.IO.Path]::GetFullPath($env:SWU_BUILD_OUTPUT_CHECK)
$root = [System.IO.Path]::GetPathRoot($output)
if ($output -eq $root) { throw 'A filesystem root cannot be used as SWU_BUILD_OUTPUT.' }
$ancestors = [System.Collections.Generic.List[string]]::new()
$ancestors.Add($root)
$current = $root
foreach ($part in $output.Substring($root.Length).Split([char[]]@('\', '/'), [System.StringSplitOptions]::RemoveEmptyEntries)) {
  $current = [System.IO.Path]::Combine($current, $part)
  $ancestors.Add($current)
}
foreach ($path in $ancestors) {
  $item = Get-ExistingOutputEntry $path
  if ($null -eq $item) { exit 0 }
  Assert-OutputDirectory $item
}
foreach ($relative in @('modules', 'licenses', 'engine', 'modules/ocs', 'modules/ocs/browser', 'licenses/ocs', 'licenses/lepao3', 'licenses/npm')) {
  $item = Get-ExistingOutputEntry ([System.IO.Path]::Combine($output, $relative))
  if ($null -ne $item) { Assert-OutputDirectory $item }
}
$pending = [System.Collections.Generic.Stack[string]]::new()
$pending.Push($output)
while ($pending.Count -gt 0) {
  $directory = $pending.Pop()
  Assert-OutputDirectory (Get-Item -LiteralPath $directory -Force -ErrorAction Stop)
  foreach ($entry in Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop) {
    Assert-OutputEntry $entry
    if ($entry -is [System.IO.DirectoryInfo]) { $pending.Push($entry.FullName) }
  }
}
`;
  const child = Bun.spawn(['pwsh.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    env: { ...process.env, SWU_BUILD_OUTPUT_CHECK: resolve(output) },
    stdin: 'ignore', stdout: 'ignore', stderr: 'pipe', timeout: 30_000,
  });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (exitCode !== 0) throw new Error(`Build output path validation failed (exit ${exitCode}): ${stderr.trim()}`);
}

export async function assertOcsOutputIsolated(output: string): Promise<void> {
  await assertBuildOutputPathsSafe(output);
  const directory = resolve(output, 'modules/ocs');
  if (!existsSync(directory)) return;
  const root = await lstat(directory);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error(`OCS output must be a real directory: ${directory}. Set SWU_BUILD_OUTPUT to a new isolated directory.`);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if ((entry.name === 'browser' && entry.isDirectory()) || (entry.name === 'source-manifest.json' && entry.isFile())) continue;
    throw new Error(`Legacy or unexpected OCS output found: ${resolve(directory, entry.name)}. Set SWU_BUILD_OUTPUT to a new isolated directory; old OCS Desktop.exe/Electron files will not be copied or deleted.`);
  }
  if (existsSync(resolve(directory, 'browser'))) await verifyOcsBrowser(resolve(directory, 'browser'));
}

export async function verifyOcsBundle(output: string): Promise<void> {
  await assertOcsOutputIsolated(output);
  const expected = await verifyOcsSource();
  const bundled = sourceManifestSchema.parse(JSON.parse(await readFile(resolve(output, 'modules/ocs/source-manifest.json'), 'utf8')));
  assertHashes(expected.files, bundled.files, 'Bundled OCS source manifest');
  await verifyOcsBrowser(resolve(output, 'modules/ocs/browser'));
  const licenses = await fileHashes(licenseRoot);
  assertHashes(licenses, await fileHashes(resolve(output, 'licenses/ocs')), 'Bundled OCS licenses');
}

async function prepareOcsSource(): Promise<void> {
  if (!existsSync(manifestPath)) {
    const manifest = sourceManifestSchema.parse({ ...provenance, files: await sourceFiles() });
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  }
  const manifest = await verifyOcsSource();
  console.log(`Verified OCS ${manifest.release} source: ${manifest.fileCount} files, commit ${manifest.commit}. No upstream build, source rewrite, or Electron runtime is used.`);
}

if (import.meta.main) await prepareOcsSource();
