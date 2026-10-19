import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { z } from 'zod';
import { createOcsService } from '../desktop/bun/ocs';
import { createOcsRepository } from '../desktop/bun/ocs-storage';
import { privateStrings, sanitizeOcsMessage } from '../desktop/bun/ocs-privacy';
import { Settings } from '../desktop/renderer/OcsSettings';

/** Exercise the actual DPAPI service and settings renderer without exposing wrapper contents. */
test('private answer wrappers never enter public DTO or settings markup and survive placeholder saves', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swu-ocs-private-wrapper-'));
  const service = createOcsService(root);
  const header = randomUUID();
  const query = randomUUID();
  const body = randomUUID();
  const wrappers = [{ url: 'https://example.org/search?ticket=' + query, headers: { 'X-Custom': header }, data: { value: body } }];
  const secrets = [header, query, body];
  const wrapperSchema = z.array(z.object({ url: z.string(), headers: z.record(z.string(), z.string()), data: z.object({ value: z.string() }) }));
  try {
    const initial = await service.execute({ command: 'state' });
    const saved = await service.execute({ command: 'settings-save', settings: { ...initial.settings, syncEnabled: false, globalConfigJson: JSON.stringify({ theme: 'neutral', 'common.settings.answererWrappers': wrappers }) } });
    expect(saved.userScripts).toEqual([]);
    const exposed = JSON.stringify(saved);
    for (const value of secrets) expect(exposed.includes(value)).toBe(false);
    expect(z.object({ 'common.settings.answererWrappers': z.string(), theme: z.string() }).parse(JSON.parse(saved.settings.globalConfigJson))).toEqual({ 'common.settings.answererWrappers': '[已保存的私有值]', theme: 'neutral' });
    const markup = renderToStaticMarkup(createElement(Settings, { settings: saved.settings, disabled: false, execute: async command => { await service.execute(command); return true; } }));
    for (const value of secrets) expect(markup.includes(value)).toBe(false);
    await service.execute({ command: 'settings-save', settings: { ...saved.settings, enableDialogs: !saved.settings.enableDialogs } });
    const repository = createOcsRepository(root);
    const document = await repository.read();
    const privateConfig = z.object({ 'common.settings.answererWrappers': wrapperSchema, theme: z.string() }).parse(JSON.parse(document.settings.globalConfigJson));
    expect(privateConfig['common.settings.answererWrappers']).toEqual(wrappers);
    expect(privateConfig.theme).toBe('neutral');
    const ciphertext = await readFile(join(repository.root, 'configuration.dpapi.json'), 'utf8');
    for (const value of secrets) expect(ciphertext.includes(value)).toBe(false);
    const message = sanitizeOcsMessage(secrets.join(' '), privateStrings(document));
    for (const value of secrets) expect(message.includes(value)).toBe(false);
    const again = await service.execute({ command: 'state' });
    for (const value of secrets) expect(JSON.stringify(again).includes(value)).toBe(false);
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
