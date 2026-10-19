import { createHash } from 'node:crypto';
import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { readdir, rename } from 'node:fs/promises';
import upstream from '../vendor/ocs/upstream.json';

const directory = process.env['SWU_OCS_DIST'];
if (!directory) throw new Error('Set SWU_OCS_DIST to the extracted official OCS 2.12.0 directory.');
const root = resolve(directory);
const browserRoot = join(root, 'resources/bin/chrome');
if (!existsSync(join(browserRoot, 'chrome/chrome.exe'))) {
  const sevenZip = process.env['SWU_7ZIP'];
  if (!sevenZip || !existsSync(sevenZip)) throw new Error('Set SWU_7ZIP to the project build tool 7z executable.');
  const expanded = join(browserRoot, 'expanded');
  const child = Bun.spawn([sevenZip, 'x', join(browserRoot, 'chrome.zip'), `-o${expanded}`, '-y'], { stdout: 'ignore', stderr: 'inherit' });
  if (await child.exited !== 0) throw new Error('The bundled OCS browser archive could not be extracted.');
  const executables = (await readdir(expanded, { recursive: true })).filter(relative => relative.endsWith('chrome.exe'));
  if (executables.length !== 1) throw new Error('The bundled OCS browser archive did not contain a unique Chrome executable.');
  await rename(resolve(expanded, executables[0]!, '..'), join(browserRoot, 'chrome'));
}
for (const [relative, digest] of Object.entries(upstream.originalFiles)) {
  if (createHash('sha256').update(await readFile(join(root, relative))).digest('hex') !== digest) throw new Error(`OCS upstream file does not match the pinned release: ${relative}`);
}
const packageFile = join(root, 'resources/app/package.json');
const metadata = z.object({ version: z.literal('2.12.0'), license: z.literal('MIT') }).parse(JSON.parse(await readFile(packageFile, 'utf8')));
async function patch(relative: string, before: string, after: string): Promise<void> {
  const path = join(root, relative);
  const source = await readFile(path, 'utf8');
  if (source.split(before).length !== 2) throw new Error(`OCS patch did not match exactly once: ${relative}`);
  await writeFile(path, source.replace(before, after), 'utf8');
}
await copyFile('vendor/ocs/host.cjs', join(root, 'resources/app/lib/swu-host.cjs'));
await patch('resources/app/lib/index.js', 'const electron_1 = require("electron");', 'require("./swu-host.cjs");\nconst electron_1 = require("electron");');
await patch('resources/app/lib/src/tasks/startup.server.js', "app.get('/state',", "app.post('/swu-host', require('../../swu-host.cjs').handle);\n        app.get('/state',");
await patch('resources/app/lib/src/tasks/startup.server.js', 'app.listen(store_1.store.store.server.port, () => {', 'app.listen(store_1.store.store.server.port, "127.0.0.1", () => {');
await patch('resources/app/lib/src/tasks/updater.js', 'function updater() {', 'function updater() {\n    return Promise.resolve();');
await patch('resources/app/lib/src/tasks/updater.js', 'function updateApp(newVersion) {', 'function updateApp(newVersion) {\n    return Promise.reject(new Error("内置 OCS 请通过西大日常更新。浏览器、扩展和脚本仍可在原窗口更新。"));');
const files: Record<string, string> = {};
for (const relative of [...Object.keys(upstream.originalFiles), 'resources/app/lib/swu-host.cjs']) files[relative] = createHash('sha256').update(await readFile(join(root, relative))).digest('hex');
await writeFile('vendor/ocs/runtime.json', JSON.stringify({ version: metadata.version, files }, null, 2), 'utf8');
await mkdir('licenses/ocs', { recursive: true });
await copyFile(packageFile, 'licenses/ocs/package.json');
console.log('Prepared the pinned OCS runtime with isolated data, localhost binding and host lifecycle commands.');
