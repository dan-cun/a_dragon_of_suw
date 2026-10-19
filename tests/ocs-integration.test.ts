import { expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { createOcsService } from '../desktop/bun/ocs';
import { createOcsRepository } from '../desktop/bun/ocs-storage';
import { isPublicDownloadAddress } from '../desktop/bun/ocs-download';
import { ocsStateSchema } from '../desktop/shared/ocs';
import { z } from 'zod';

async function temporaryDirectory(): Promise<{ root: string; parent: string }> {
  const parent = process.env['TEMP'];
  if (!parent) throw new Error('The isolated temporary directory is not configured.');
  return { parent, root: await mkdtemp(join(parent, 'swu-ocs-source-')) };
}

async function removeTemporary(root: string, parent: string): Promise<void> {
  const distance = relative(resolve(parent), resolve(root));
  if (!distance || distance === '..' || distance.startsWith(`..${sep}`)) throw new Error('Refusing to clean outside the isolated temporary directory.');
  await rm(root, { recursive: true, force: true });
}

const metadata = { name: 'Isolated browser', folder: 'Integration', notes: 'No course accounts', tags: ['isolation'], startUrl: 'about:blank' };

/** Exercise real managed-page requests and imported matching rules against a local authored page. */
async function verifyBrowserSecurity(root: string): Promise<void> {
  const reportSchema = z.object({ host: z.string(), included: z.boolean(), excluded: z.boolean(), responses: z.array(z.object({ status: z.number(), body: z.string() })) });
  const reports: z.infer<typeof reportSchema>[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (new URL(request.url).pathname === '/report') { reports.push(reportSchema.parse(await request.json())); return new Response('OK'); }
    return new Response(`<!doctype html><html><body>Authored local security integration page<script>
window.addEventListener('load', async () => {
  const responses = [];
  for (const [path, method] of [['/browser','GET'], ['/ocs-global-setting','GET'], ['/get-actions-key','GET'], ['/ocs-script-actions','GET'], ['/ocs-script-actions','POST']]) {
    const response = await fetch('http://127.0.0.1:15319' + path, {method});
    responses.push({status: response.status, body: await response.text()});
  }
  await fetch('/report', {method:'POST', body: JSON.stringify({host: location.hostname, included: document.documentElement.dataset.included === 'yes', excluded: document.documentElement.dataset.excluded === 'yes', responses})});
});</script></body></html>`, { headers: { 'Content-Type': 'text/html' } });
  } });
  const service = createOcsService(join(root, 'security'));
  const secret = randomBytes(24).toString('hex');
  try {
    await service.execute({ command: 'script-import', name: 'Match root domain', content: '// ==UserScript==\n// @name Match root domain\n// @match http://*.example.localhost/*\n// @grant none\n// ==/UserScript==\ndocument.documentElement.dataset.included = "yes";' });
    await service.execute({ command: 'script-import', name: 'Exclude root domain', content: '// ==UserScript==\n// @name Exclude root domain\n// @match http://*/*\n// @exclude-match http://*.example.localhost/*\n// @grant none\n// ==/UserScript==\ndocument.documentElement.dataset.excluded = "yes";' });
    for (const syncEnabled of [false, true]) {
      const state = await service.execute({ command: 'state' });
      await service.execute({ command: 'settings-save', settings: { ...state.settings, syncEnabled, globalConfigJson: JSON.stringify({ apiKey: secret, unrecognizedPrivate: secret }) } });
      for (const host of ['example.localhost', 'sub.example.localhost', 'badexample.localhost', '127.0.0.1']) {
        const before = reports.length;
        const created = await service.execute({ command: 'browser-create', browser: { ...metadata, startUrl: `http://${host}:${server.port}/` } });
        const browser = created.browsers.at(-1);
        if (!browser) throw new Error('The security browser was not created.');
        const started = await service.execute({ command: 'browser-start', id: browser.id });
        expect(started.browsers.find(value => value.id === browser.id)?.owned).toBe(true);
        for (let wait = 0; wait < 200 && reports.length === before; wait += 1) await Bun.sleep(25);
        const report = reports[before];
        if (!report) throw new Error(`The real ${host} security page did not report within 5 seconds.`);
        expect(report.host).toBe(host);
        const matchesDomain = host === 'example.localhost' || host === 'sub.example.localhost';
        expect(report.included).toBe(matchesDomain);
        expect(report.excluded).toBe(!matchesDomain);
        expect(report.responses).toHaveLength(5);
        for (const response of report.responses) { expect(response.status).toBe(403); expect(response.body.includes(secret)).toBe(false); }
        await expect(service.execute({ command: 'browser-start', id: browser.id })).rejects.toThrow('仍被持有');
        const stopped = await service.execute({ command: 'browser-stop', id: browser.id });
        expect(stopped.browsers.find(value => value.id === browser.id)?.owned).toBe(false);
        expect(stopped.logs.some(value => value.event === 'browser.closed')).toBe(true);
        await service.execute({ command: 'browser-delete', id: browser.id });
      }
    }
  } finally { await service.close(); await server.stop(true); }
}

test('OCS source integration persists real DPAPI secrets and leaves old Electron files untouched', async () => {
  const { root, parent } = await temporaryDirectory();
  const secret = randomBytes(24).toString('hex');
  const globalSecret = randomBytes(24).toString('hex');
  const oldDirectory = join(root, 'ocs');
  await mkdir(oldDirectory);
  const oldFile = join(oldDirectory, 'config.json');
  const sentinel = Buffer.from('Old isolated Electron data must remain byte-identical.');
  await writeFile(oldFile, sentinel);
  const service = createOcsService(root);
  const reloaded = createOcsService(root);
  try {
    const initialRead = service.execute({ command: 'state' });
    expect(service.isBusy()).toBe(false);
    await service.assertCanClose();
    const initial = ocsStateSchema.parse(await initialRead);
    expect(initial.integration).toBe('source');
    expect(initial.automationCatalog.length).toBe(7);
    expect(initial.capabilities.find(value => value.id === 'automatic-login')?.available).toBe(true);
    expect(initial.capabilities.find(value => value.id === 'script-actions')?.available).toBe(false);
    expect(initial.capabilities.find(value => value.id === 'config-sync')?.available).toBe(true);
    expect(initial.capabilities.find(value => value.id === 'gm-runtime')?.available).toBe(false);
    expect(initial.capabilities.find(value => value.id === 'course-results')?.available).toBe(false);
    expect(initial.automationRun).toBeNull();
    expect((await service.execute({ command: 'state' })).automationRun).toBeNull();
    const beforeMutation = service.execute({ command: 'state' });
    const creating = service.execute({ command: 'browser-create', browser: metadata });
    const afterMutation = service.execute({ command: 'state' });
    expect(service.isBusy()).toBe(true);
    await expect(service.assertCanClose()).rejects.toThrow('操作仍在处理中');
    await beforeMutation;
    expect(service.isBusy()).toBe(true);
    const created = await creating;
    const queuedState = await afterMutation;
    expect(queuedState.browsers).toEqual(created.browsers);
    expect(service.isBusy()).toBe(false);
    const browser = created.browsers[0];
    if (!browser) throw new Error('Browser metadata was not created.');
    const persisted = await service.execute({ command: 'automation-save', id: browser.id, name: '超星-手机密码登录', values: [{ key: 'phone', value: 'not-a-course-account' }, { key: 'password', value: secret }] });
    expect(JSON.stringify(persisted).includes(secret)).toBe(false);
    const settings = { ...persisted.settings, syncEnabled: true, globalConfigJson: JSON.stringify({ theme: 'neutral', apiKey: globalSecret }) };
    const saved = await service.execute({ command: 'settings-save', settings });
    expect(JSON.stringify(saved).includes(globalSecret)).toBe(false);
    expect(saved.settings.globalConfigJson).toContain('[已保存的私有值]');
    await service.execute({ command: 'settings-save', settings: saved.settings });
    await service.execute({ command: 'automation-save', id: browser.id, name: '超星-手机密码登录', values: [{ key: 'password', value: '' }] });
    const repository = createOcsRepository(root);
    const document = await repository.read();
    expect(document.automations[0]?.values.find(value => value.key === 'password')?.value).toBe(secret);
    expect(document.settings.globalConfigJson).toContain(globalSecret);
    const disk = await readFile(join(repository.root, 'configuration.dpapi.json'), 'utf8');
    expect(disk.includes(secret) || disk.includes(globalSecret) || disk.includes('not-a-course-account')).toBe(false);
    const restored = await reloaded.execute({ command: 'state' });
    expect(restored.browsers[0]?.automationName).toBe('超星-手机密码登录');
    expect(JSON.stringify(restored).includes(secret)).toBe(false);
    await reloaded.execute({ command: 'automation-clear', id: browser.id });
    expect((await repository.read()).automations).toHaveLength(0);
    await reloaded.execute({ command: 'browser-delete', id: browser.id });
    expect((await repository.read()).browsers).toHaveLength(0);
    expect((await readFile(oldFile)).equals(sentinel)).toBe(true);
    await service.assertCanClose();
    const closingRead = reloaded.execute({ command: 'state' });
    expect(reloaded.isBusy()).toBe(false);
    await reloaded.assertCanClose();
    const closing = reloaded.close();
    await expect(reloaded.execute({ command: 'state' })).rejects.toThrow('正在正常关闭');
    await expect(reloaded.execute({ command: 'browser-create', browser: metadata })).rejects.toThrow('正在正常关闭');
    expect((await closingRead).integration).toBe('source');
    await closing;
    await expect(reloaded.execute({ command: 'state' })).rejects.toThrow('已关闭');
  } finally { await service.close(); await reloaded.close(); await removeTemporary(root, parent); }
}, 120_000);

test('OCS imports actual script and MV3 trees, rejects unsupported capabilities and removes only owned copies', async () => {
  const { root, parent } = await temporaryDirectory();
  const extensionDirectory = join(root, 'authored-extension');
  await mkdir(extensionDirectory);
  await writeFile(join(extensionDirectory, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Isolated integration extension', version: '1.0.0', background: { service_worker: 'background.js' } }));
  await writeFile(join(extensionDirectory, 'background.js'), "chrome.runtime.onInstalled.addListener(() => console.log('isolated extension installed'));\n");
  const service = createOcsService(root);
  try {
    for (const address of ['0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.0.0.1', '192.0.2.1', '192.168.0.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::7f00:1', 'fc00::1', 'fe80::1', '2001::1', '2001:db8::1', '2002:7f00:1::1', '3ffe::1', '3fff::1']) expect(isPublicDownloadAddress(address)).toBe(false);
    expect(isPublicDownloadAddress('8.8.8.8')).toBe(true);
    expect(isPublicDownloadAddress('2606:4700:4700::1111')).toBe(true);
    const source = '// ==UserScript==\n// @name Isolated integration script\n// @version 1.0.0\n// @include about:blank\n// @grant none\n// ==/UserScript==\ndocument.documentElement.dataset.ocsIntegration = "executed";';
    for (const rule of ['@match not-a-pattern', '@match https://bad*host/*', '@match https://example.com:443/*', '@exclude-match https://bad*host/*', '@exclude-match', '@include /[/']) {
      await expect(service.execute({ command: 'script-import', name: 'Invalid rules', content: source.replace('@include about:blank', '@include about:blank\n// ' + rule) })).rejects.toThrow();
    }
    for (const url of ['https://127.0.0.1/private', 'https://[::1]/private', 'https://localhost/private', 'https://host.internal/private', 'https://user:secret@example.com/script', 'https://example.com:8443/script', 'https://example.com/script#fragment']) {
      await expect(service.execute({ command: 'script-download', url })).rejects.toThrow();
    }
    const imported = await service.execute({ command: 'script-import', name: 'Imported script', content: source });
    const script = imported.userScripts[0];
    if (!script) throw new Error('The script was not imported.');
    expect(script.enabled).toBe(true);
    expect(await readFile(join(imported.dataDirectory, 'scripts', script.id + '.user.js'), 'utf8')).toBe(source);
    await service.execute({ command: 'script-enable', id: script.id, enabled: false });
    const unsupported = await service.execute({ command: 'script-import', name: 'Privileged script', content: source.replace('@grant none', '@grant GM_xmlhttpRequest') });
    const privileged = unsupported.userScripts.find(value => value.name === 'Privileged script');
    if (!privileged) throw new Error('The privileged script record was not imported.');
    expect(privileged.enabled).toBe(false);
    await expect(service.execute({ command: 'script-enable', id: privileged.id, enabled: true })).rejects.toThrow('不能启用');
    const withExtension = await service.execute({ command: 'extension-import', directory: extensionDirectory });
    const extension = withExtension.extensions[0];
    if (!extension) throw new Error('The MV3 extension was not imported.');
    expect(await readFile(join(withExtension.dataDirectory, 'extensions', extension.id, 'background.js'), 'utf8')).toContain('onInstalled');
    await service.execute({ command: 'extension-enable', id: extension.id, enabled: false });
    await service.execute({ command: 'extension-delete', id: extension.id });
    expect(existsSync(join(withExtension.dataDirectory, 'extensions', extension.id))).toBe(false);
    expect(existsSync(join(extensionDirectory, 'background.js'))).toBe(true);
    await service.execute({ command: 'script-delete', id: script.id });
    await expect(service.execute({ command: 'script-download', url: 'http://127.0.0.1/private' })).rejects.toThrow('HTTPS');
    for (let index = 0; index < 310; index += 1) await expect(service.execute({ command: 'browser-focus', id: crypto.randomUUID() })).rejects.toThrow('浏览器不存在');
    const final = await service.execute({ command: 'state' });
    expect(final.logs).toHaveLength(300);
    expect(final.logs.at(-1)?.event).toBe('browser-focus.failed');
  } finally { await service.close(); await removeTemporary(root, parent); }
}, 120_000);

const browserTest = process.env['SWU_OCS_BROWSER'] ? test : test.skip;
browserTest('OCS launches real independent Chrome on about:blank, runs scoped source, previews and closes without Electron', async () => {
  const { root, parent } = await temporaryDirectory();
  const service = createOcsService(root);
  try {
    await verifyBrowserSecurity(root);
    await expect(service.execute({ command: 'browser-create', browser: { ...metadata, startUrl: 'file:///private' } })).rejects.toThrow();
    expect((await service.execute({ command: 'state' })).browsers).toHaveLength(0);
    await service.execute({ command: 'script-import', name: 'Real blank-page integration', content: '// ==UserScript==\n// @name Real blank-page integration\n// @include about:blank\n// @run-at document-start\n// @grant none\n// ==/UserScript==\ndocument.addEventListener("DOMContentLoaded", () => { document.body.textContent = "OCS isolated browser integration"; });' });
    const extensionDirectory = join(root, 'real-browser-extension');
    await mkdir(extensionDirectory);
    await writeFile(join(extensionDirectory, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Real isolated MV3 integration', version: '1.0.0', background: { service_worker: 'background.js' } }));
    await writeFile(join(extensionDirectory, 'background.js'), "chrome.runtime.onInstalled.addListener(() => { console.log('isolated MV3 ready'); });");
    await service.execute({ command: 'extension-import', directory: extensionDirectory });
    const created = await service.execute({ command: 'browser-create', browser: metadata });
    const browser = created.browsers[0];
    if (!browser) throw new Error('Browser metadata is missing.');
    const started = await service.execute({ command: 'browser-start', id: browser.id });
    expect(started.browsers[0]?.phase).toBe('running');
    await service.assertCanClose();
    await service.execute({ command: 'browser-focus', id: browser.id });
    const preview = await service.execute({ command: 'browser-preview', id: browser.id });
    expect(preview.preview?.image.startsWith('data:image/png;base64,')).toBe(true);
    expect(preview.logs.some(value => value.event === 'script.executed')).toBe(true);
    expect(preview.logs.some(value => value.event === 'extension.worker.started')).toBe(true);
    expect(existsSync(join(created.dataDirectory, 'profiles', browser.id))).toBe(true);
    const secondCreated = await service.execute({ command: 'browser-create', browser: { ...metadata, name: 'Second isolated profile' } });
    const second = secondCreated.browsers.find(value => value.id !== browser.id);
    if (!second) throw new Error('The independent second browser was not created.');
    const multiple = await service.execute({ command: 'browser-start', id: second.id });
    expect(multiple.browsers.filter(value => value.phase === 'running')).toHaveLength(2);
    expect(existsSync(join(created.dataDirectory, 'profiles', second.id))).toBe(true);
    await expect(service.execute({ command: 'browser-delete', id: browser.id })).rejects.toThrow('先停止');
    const stopped = await service.execute({ command: 'browsers-stop' });
    expect(stopped.browsers.every(value => value.phase === 'stopped')).toBe(true);
    expect(stopped.preview).toBeNull();
    await service.assertCanClose();
    const restarted = await service.execute({ command: 'browser-start', id: browser.id });
    expect(restarted.browsers[0]?.phase).toBe('running');
    await service.close();
    await expect(service.execute({ command: 'state' })).rejects.toThrow('已关闭');
  } finally { await service.close(); await removeTemporary(root, parent); }
}, 120_000);

browserTest('OCS compiled EXE retains Playwright and local source behavior on about:blank', async () => {
  const { root, parent } = await temporaryDirectory();
  try {
    const executable = join(root, 'ocs-compiled-smoke.exe');
    const compiled = await Bun.build({ entrypoints: [resolve('desktop/ocs/compiled-smoke.ts')], target: 'bun', minify: true, external: ['chromium-bidi/*'], compile: { outfile: executable, autoloadDotenv: false, autoloadBunfig: false } });
    if (!compiled.success) throw new AggregateError(compiled.logs, 'Compiled OCS backend fixture failed to build.');
    const process = Bun.spawn([executable], { env: { ...Bun.env, SWU_OCS_SMOKE_DIRECTORY: join(root, 'compiled-data') }, stdout: 'pipe', stderr: 'pipe', signal: AbortSignal.timeout(60_000) });
    const [output, errors, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
    if (code !== 0) throw new Error(`Compiled OCS backend failed (${code}): ${errors.slice(0, 3000)}`);
    const reply = z.object({ ok: z.literal(true), scriptExecuted: z.literal(true), preview: z.literal(true) }).parse(JSON.parse(output.trim()));
    expect(reply.ok).toBe(true);
    expect(existsSync(join(root, 'compiled-data', 'ocs', 'source-integration', 'configuration.dpapi.json'))).toBe(true);
  } finally { await removeTemporary(root, parent); }
}, 120_000);
