import { isAbsolute, relative, resolve, sep } from 'node:path';
import { createOcsService } from '../bun/ocs';

/** Run only the compiled-backend integration fixture in an explicit temporary directory. */
export async function runOcsCompiledSmoke(): Promise<void> {
  const directory = process.env['SWU_OCS_SMOKE_DIRECTORY'];
  const temporary = process.env['TEMP'];
  if (!directory || !temporary || !isAbsolute(directory)) throw new Error('The compiled OCS smoke directory is not configured.');
  const distance = relative(resolve(temporary), resolve(directory));
  if (!distance || distance === '..' || distance.startsWith(`..${sep}`) || isAbsolute(distance)) throw new Error('The compiled OCS smoke directory must be inside TEMP.');
  const service = createOcsService(directory);
  try {
    await service.execute({ command: 'script-import', name: 'Compiled blank-page smoke', content: '// ==UserScript==\n// @name Compiled blank-page smoke\n// @include about:blank\n// @exclude-match http://*.localhost/*\n// @grant none\n// ==/UserScript==\ndocument.body.textContent = "Compiled OCS blank-page smoke";' });
    const created = await service.execute({ command: 'browser-create', browser: { name: 'Compiled isolated browser', folder: '', notes: '', tags: [], startUrl: 'about:blank' } });
    const browser = created.browsers[0];
    if (!browser) throw new Error('The compiled OCS browser was not created.');
    await service.execute({ command: 'browser-start', id: browser.id });
    const captured = await service.execute({ command: 'browser-preview', id: browser.id });
    await service.close();
    console.log(JSON.stringify({ ok: true, scriptExecuted: captured.logs.some(value => value.event === 'script.executed'), preview: captured.preview?.image.startsWith('data:image/png;base64,') === true }));
  } finally { await service.close(); }
}

await runOcsCompiledSmoke();
