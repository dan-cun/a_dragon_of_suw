import { existsSync } from 'node:fs';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { protectToken, unprotectToken } from './native';
import { providerSecretSchema, publicProviderSchema, type ModelProvider, type ModelsCommand, type ModelsState } from '../shared/models';

const storedSchema = z.object({ version: z.literal(1), encrypted: z.string().min(1).max(100000) }).strict();
const providersSchema = z.array(providerSecretSchema).max(20).refine(values => new Set(values.map(value => value.id)).size === values.length);

export function createModelService(directory: string) {
  const path = join(directory, 'model-providers.json');
  let pending = 0;
  let queue: Promise<void> = Promise.resolve();
  async function read(): Promise<ModelProvider[]> {
    if (!existsSync(path)) return [];
    const stored = storedSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    return providersSchema.parse(JSON.parse(await unprotectToken(stored.encrypted)));
  }
  async function save(values: ModelProvider[]): Promise<void> {
    const serialized = JSON.stringify(providersSchema.parse(values));
    if (Buffer.byteLength(serialized) > 32768) throw new Error('模型配置超过 32 KB，请减少自定义请求头或参数。');
    const encrypted = await protectToken(serialized);
    await writeFile(path + '.pending', JSON.stringify({ version: 1, encrypted }), { encoding: 'utf8', mode: 0o600 });
    await rename(path + '.pending', path);
  }
  function snapshot(values: ModelProvider[]): ModelsState {
    return { runtime: 'reserved', protocolVersion: 1, referencePiVersion: '1.1.0', providers: values.map(value => {
      const { apiKey, headers, payloadParameters, ...metadata } = value;
      return publicProviderSchema.parse({ ...metadata, hasApiKey: apiKey.length > 0, headerNames: Object.keys(headers).sort(), hasPayloadParameters: Object.keys(payloadParameters).length > 0 });
    }) };
  }
  return {
    isBusy: () => pending > 0,
    execute(command: ModelsCommand): Promise<ModelsState> {
      pending += 1;
      const operation = queue.then(async () => {
        const values = await read();
        if (command.command === 'state') return snapshot(values);
        if (command.command === 'save') {
          const previous = values.find(value => value.id === command.provider.id);
          const provider = providerSecretSchema.parse({ ...command.provider, apiKey: command.provider.apiKey ?? previous?.apiKey ?? '', headers: command.provider.headers ?? previous?.headers ?? {}, payloadParameters: command.provider.payloadParameters ?? previous?.payloadParameters ?? {} });
          const next = [...values.filter(value => value.id !== provider.id), provider];
          await save(next);
          return snapshot(next);
        }
        if (!values.some(value => value.id === command.id)) throw new Error('模型配置已不存在，请刷新列表。');
        const next = command.command === 'remove' ? values.filter(value => value.id !== command.id) : values.map(value => value.id === command.id ? { ...value, apiKey: '', headers: {} } : value);
        await save(next);
        return snapshot(next);
      });
      // Each caller receives its error; later requests still enter the queue.
      queue = operation.then(() => undefined, () => undefined);
      return operation.finally(() => { pending -= 1; });
    },
    async privateConfiguration(id: string): Promise<ModelProvider> {
      const value = (await read()).find(value => value.id === id);
      if (!value) throw new Error('尚未配置所选模型。');
      return structuredClone(value);
    },
  };
}
