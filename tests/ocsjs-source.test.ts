import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { cp, link, mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { verifyOcsjsSource, type OcsjsSourceManifest } from '../scripts/verify-ocsjs-source';

const projectRoot = resolve(import.meta.dir, '..');
const manifestPath = 'vendor/ocs/ocsjs-source-manifest.json';
const sourcePath = 'vendor/ocs/ocsjs-5.2.1';
const licensePath = 'licenses/ocs/OCSJS-5.2.1-LICENSE';
const provenancePath = 'licenses/ocs/OCSJS-5.2.1-PROVENANCE.json';

type FixtureCheck = (directory: string, manifest: OcsjsSourceManifest) => Promise<void>;

async function withFixture(check: FixtureCheck): Promise<void> {
  const temporary = process.env['TEMP'];
  if (!temporary || resolve(temporary).toLowerCase() !== 'd:\\bugging\\temp') {
    throw new Error('OCSJS tests require the verified TEMP directory D:\\Bugging\\Temp.');
  }
  const baseline = await verifyOcsjsSource(projectRoot);
  const directory = await mkdtemp(join(temporary, 'swu-ocsjs-source-test-'));
  try {
    for (const path of [sourcePath, manifestPath, licensePath, provenancePath]) {
      const target = join(directory, path);
      await mkdir(dirname(target), { recursive: true });
      await cp(join(projectRoot, path), target, { recursive: true, force: false, errorOnExist: true });
    }
    await check(directory, structuredClone(baseline.manifest));
  } finally {
    if (dirname(directory) !== resolve(temporary) || !basename(directory).startsWith('swu-ocsjs-source-test-')) {
      throw new Error(`Refusing OCSJS cleanup outside the owned temporary directory: ${directory}`);
    }
    await rm(directory, { recursive: true, force: true });
  }
}

async function writeManifest(directory: string, manifest: OcsjsSourceManifest): Promise<void> {
  await writeFile(join(directory, manifestPath), JSON.stringify(manifest, null, 2));
}

test('OCSJS official source baseline verifies its independent identity and license bytes', async () => {
  const result = await verifyOcsjsSource(projectRoot);
  expect(result.manifest.commit).toBe('8b25a3f44523a0d4b7373878488056f4aa478cf6');
  expect(result.manifest.tag).toBe('5.2.1');
  expect(result.manifest.fileCount).toBe(125);
  expect(Object.keys(result.manifest.files)).toHaveLength(125);
  expect(result.manifest.sourceBytes).toBe(1751894);
  expect(result.manifest.runtimeEnabled).toBe(false);
  expect(await readFile(result.licenseFile)).toEqual(await readFile(join(result.sourceDirectory, 'LICENSE')));
});

test('OCSJS verifier accepts a real byte-exact copy under an explicit different root', async () => {
  await withFixture(async (directory, manifest) => {
    const result = await verifyOcsjsSource(directory);
    expect(result.sourceDirectory).toBe(join(directory, sourcePath));
    expect(result.manifest).toEqual(manifest);
    expect(result.licenseFile).toBe(join(directory, licensePath));
    expect(result.provenanceFile).toBe(join(directory, provenancePath));
  });
});

test('OCSJS verifier rejects modified source without rewriting source or manifest', async () => {
  await withFixture(async (directory) => {
    const path = join(directory, sourcePath, 'README.md');
    const originalManifest = await readFile(join(directory, manifestPath));
    const changed = Buffer.concat([await readFile(path), Buffer.from('\nsource-integrity-test\n')]);
    await writeFile(path, changed);
    await expect(verifyOcsjsSource(directory)).rejects.toThrow('SHA-256 mismatch');
    expect(await readFile(path)).toEqual(changed);
    expect(await readFile(join(directory, manifestPath))).toEqual(originalManifest);
  });
});

test('OCSJS verifier rejects a changed source even if its manifest digest is regenerated', async () => {
  await withFixture(async (directory, manifest) => {
    const path = join(directory, sourcePath, 'README.md');
    const changed = Buffer.concat([await readFile(path), Buffer.from('\nchanged\n')]);
    await writeFile(path, changed);
    manifest.files['README.md'] = createHash('sha256').update(changed).digest('hex');
    await writeManifest(directory, manifest);
    await expect(verifyOcsjsSource(directory)).rejects.toThrow('SHA-256 mismatch');
    expect(await readFile(path)).toEqual(changed);
  });
});

for (const change of ['missing-file', 'extra-file', 'empty-directory'] as const) {
  test(`OCSJS verifier rejects ${change} in a real source copy`, async () => {
    await withFixture(async (directory) => {
      if (change === 'missing-file') await unlink(join(directory, sourcePath, 'README.md'));
      if (change === 'extra-file') await cp(join(directory, sourcePath, 'README.md'), join(directory, sourcePath, 'extra.txt'));
      if (change === 'empty-directory') await mkdir(join(directory, sourcePath, 'unexpected-directory'));
      await expect(verifyOcsjsSource(directory)).rejects.toThrow(change === 'missing-file' ? 'Missing OCSJS' : 'Unexpected OCSJS');
    });
  });
}

for (const unsafe of ['../escape', '/absolute', 'C:/absolute', 'dir\\file', 'a//b', './readme', 'dir/../readme',
  'README.md:stream', 'name.', 'name ', 'CON.txt', 'LPT1', 'dir/NUL', 'COM¹.txt', 'wild*card']) {
  test(`OCSJS strict manifest rejects unsafe path ${JSON.stringify(unsafe)}`, async () => {
    await withFixture(async (directory, manifest) => {
      const digest = manifest.files['README.md'];
      if (digest === undefined) throw new Error('Pinned README.md digest is missing.');
      delete manifest.files['README.md'];
      manifest.files[unsafe] = digest;
      await writeManifest(directory, manifest);
      await expect(verifyOcsjsSource(directory)).rejects.toThrow('JSON/schema');
    });
  });
}

for (const change of ['unknown-field', 'nested-unknown-field', 'digest', 'identity', 'case-collision', 'directory-case-collision', 'file-directory-conflict'] as const) {
  test(`OCSJS strict manifest rejects ${change}`, async () => {
    await withFixture(async (directory, manifest) => {
      if (change === 'digest') manifest.files['README.md'] = 'invalid-digest';
      if (change === 'identity') await writeFile(join(directory, manifestPath), JSON.stringify({ ...manifest, tag: '5.2.2' }));
      else if (change === 'unknown-field') await writeFile(join(directory, manifestPath), JSON.stringify({ ...manifest, unexpected: true }));
      else if (change === 'nested-unknown-field') await writeFile(join(directory, manifestPath), JSON.stringify({ ...manifest, archive: { ...manifest.archive, unexpected: true } }));
      else {
        if (change === 'case-collision' || change === 'directory-case-collision' || change === 'file-directory-conflict') {
          const digest = manifest.files['CHANGELOG.md'];
          if (digest === undefined) throw new Error('Pinned CHANGELOG.md digest is missing.');
          delete manifest.files['CHANGELOG.md'];
          const path = change === 'case-collision' ? 'readme.md' : change === 'directory-case-collision' ? 'Packages/collision.txt' : 'README.md/child';
          manifest.files[path] = digest;
        }
        await writeManifest(directory, manifest);
      }
      await expect(verifyOcsjsSource(directory)).rejects.toThrow('JSON/schema');
    });
  });
}

test('OCSJS manifest trust anchor rejects duplicate JSON keys and metadata-only changes', async () => {
  await withFixture(async (directory) => {
    const path = join(directory, manifestPath);
    const original = await readFile(path, 'utf8');
    await writeFile(path, original.replace('"schemaVersion": 1,', '"schemaVersion": 1, "schemaVersion": 1,'));
    await expect(verifyOcsjsSource(directory)).rejects.toThrow('SHA-256 mismatch');
  });
});

for (const path of [licensePath, provenancePath]) {
  for (const change of ['modified', 'missing'] as const) {
    test(`OCSJS verifier rejects ${change} dedicated ${path}`, async () => {
      await withFixture(async (directory) => {
        const file = join(directory, path);
        if (change === 'missing') await unlink(file);
        else await writeFile(file, Buffer.concat([await readFile(file), Buffer.from('\n')]));
        await expect(verifyOcsjsSource(directory)).rejects.toThrow();
      });
    });
  }
}

for (const linkedPath of [sourcePath, 'vendor', 'licenses', `${sourcePath}/.github`]) {
  test(`OCSJS verifier rejects a junction at ${linkedPath}`, async () => {
    await withFixture(async (directory) => {
      const path = join(directory, linkedPath);
      const target = join(directory, 'junction-target');
      await rename(path, target);
      await symlink(target, path, 'junction');
      try {
        await expect(verifyOcsjsSource(directory)).rejects.toThrow('link/junction');
      } finally {
        await unlink(path);
      }
    });
  });
}

test('OCSJS verifier rejects a junction project root and its linked ancestor', async () => {
  await withFixture(async (directory) => {
    const alias = join(directory, 'project-alias');
    await symlink(directory, alias, 'junction');
    try {
      await expect(verifyOcsjsSource(alias)).rejects.toThrow('link/junction');
      await expect(verifyOcsjsSource(join(alias, 'vendor'))).rejects.toThrow('link/junction');
    } finally {
      await unlink(alias);
    }
  });
});

for (const path of [`${sourcePath}/README.md`, manifestPath, licensePath, provenancePath]) {
  test(`OCSJS verifier rejects hardlinks at ${path}`, async () => {
    await withFixture(async (directory) => {
      await link(join(directory, path), join(directory, 'hardlink-copy'));
      await expect(verifyOcsjsSource(directory)).rejects.toThrow('hardlinked');
    });
  });
}

test('OCSJS verifier rejects an implicit or relative project root', async () => {
  await expect(verifyOcsjsSource('')).rejects.toThrow('explicit absolute');
  await expect(verifyOcsjsSource('.')).rejects.toThrow('explicit absolute');
});
