import { test, expect } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createModelService } from '../desktop/bun/models';
import { piModelConfiguration } from '../desktop/core/pi-model';
import { modelProtocols, providerMetadataSchema, type ModelsCommand } from '../desktop/shared/models';

test('Provider configurations use real Windows encryption, preserve secrets privately and prepare all five Pi protocols', async () => {
  const temporary = process.env['TEMP'];
  if (!temporary) throw new Error('The project temporary directory is missing.');
  const directory = await mkdtemp(join(temporary, 'swu-models-'));
  const secret = randomBytes(24).toString('hex');
  const headerSecret = randomBytes(24).toString('hex');
  const service = createModelService(directory);
  try {
    expect((await service.execute({ command: 'state' })).providers.length).toBe(0);
    for (const [protocol] of modelProtocols) {
      const metadata = providerMetadataSchema.parse({ id: randomUUID(), name: protocol, protocol, baseUrl: 'http://127.0.0.1:11434', modelId: 'configured-model', timeoutSeconds: 120, contextWindow: null, maxTokens: null, vision: null, tools: true });
      const command: ModelsCommand = { command: 'save', provider: { ...metadata, apiKey: secret, headers: { Authorization: headerSecret }, payloadParameters: {} } };
      const saved = await service.execute(command);
      expect(saved.runtime).toBe('reserved');
      if (protocol === 'openaiChatCompletions') {
        const snapshots = await Promise.all([service.execute({ command: 'state' }), service.execute({ command: 'state' })]);
        expect(snapshots.every(value => value.providers.length === 1)).toBe(true);
      }
      expect(JSON.stringify(saved).includes(secret) || JSON.stringify(saved).includes(headerSecret)).toBe(false);
      const reload = createModelService(directory);
      const privateValue = await reload.privateConfiguration(metadata.id);
      expect(privateValue.apiKey === secret && privateValue.headers['Authorization'] === headerSecret).toBe(true);
      const pi = piModelConfiguration(privateValue);
      expect(pi.costKnown).toBe(false);
      expect(pi.contextWindow).toBeNull();
      expect(pi.baseUrl).toBe(protocol === 'anthropicMessages' ? 'http://127.0.0.1:11434' : protocol === 'geminiGenerateContent' ? 'http://127.0.0.1:11434/v1beta' : 'http://127.0.0.1:11434/v1');
      await service.execute({ command: 'save', provider: { ...metadata, name: 'Updated metadata' } });
      expect((await service.privateConfiguration(metadata.id)).apiKey === secret).toBe(true);
      const forgotten = await service.execute({ command: 'forget-key', id: metadata.id });
      expect(forgotten.providers.find(value => value.id === metadata.id)?.hasApiKey).toBe(false);
      const cleared = await service.privateConfiguration(metadata.id);
      expect(cleared.apiKey.length === 0 && Object.keys(cleared.headers).length === 0).toBe(true);
      await service.execute({ command: 'remove', id: metadata.id });
    }
    const disk = await readFile(join(directory, 'model-providers.json'), 'utf8');
    expect(disk.includes(secret) || disk.includes(headerSecret)).toBe(false);
    expect((await createModelService(directory).execute({ command: 'state' })).providers.length).toBe(0);
  } finally {
    if (!resolve(directory).startsWith(resolve(temporary) + '\\')) throw new Error('Model test cleanup is outside the temporary directory.');
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);
