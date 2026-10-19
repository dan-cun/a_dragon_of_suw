import { test, expect } from 'bun:test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModelService } from '../desktop/bun/models';
import { createPiService } from '../desktop/bun/pi-service';
import { createPiProvider, piProviderFetch } from '../desktop/bun/pi-provider';
import { piRuntimeModel } from '../desktop/core/pi-runtime-model';
import { piCommandSchema, piServiceCommandSchema, piStateSchema } from '../desktop/shared/pi';
import type { ModelProvider } from '../desktop/shared/models';

function provider(protocol: ModelProvider['protocol'], baseUrl: string): ModelProvider {
  return { id: crypto.randomUUID(), name: 'Pi lifecycle diagnostic', protocol, baseUrl, modelId: 'deepseek-flash', timeoutSeconds: 5,
    contextWindow: null, maxTokens: null, vision: null, tools: false, apiKey: '', headers: {}, payloadParameters: {} };
}

async function saveModel(directory: string, value: ModelProvider) {
  const models = createModelService(directory);
  await models.execute({ command: 'save', provider: value });
  return models;
}

test('Real official Pi initializes with DPAPI configuration, no tools or model requests, then clears and closes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'swu-pi-runtime-'));
  const value = provider('openaiChatCompletions', 'https://api.deepseek.com');
  const models = await saveModel(directory, value);
  const service = createPiService(directory, models.privateConfiguration, null);
  try {
    expect((await service.execute({ command: 'state' })).phase).toBe('stopped');
    expect(service.isBusy()).toBe(false);
    const state = piStateSchema.parse(await service.execute({ command: 'start', providerId: value.id, ocsToolsEnabled: false }));
    expect(state.phase).toBe('ready');
    expect(state.runtime).toBe('native-sdk');
    expect(state.sdkVersion).toBe('1.3.0');
    expect(state.mode).toBe('diagnose');
    expect(state.tools).toEqual([]);
    expect(state.costKnown).toBe(false);
    expect(state.messages).toEqual([]);
    expect(createPiProvider(value).models.getProviders()).toHaveLength(1);
    expect(await createPiProvider(value).models.getAuth(`swu-${value.id}`)).toBeUndefined();
    expect(piCommandSchema.safeParse({ command: 'prompt', text: '只分析配置状态。', confirmed: false }).success).toBe(false);
    expect(piServiceCommandSchema.safeParse({ command: 'approval', toolCallId: 'reused-tool-call', approved: true }).success).toBe(false);
    expect(piServiceCommandSchema.safeParse({ command: 'approval', approvalId: crypto.randomUUID(), approved: true }).success).toBe(true);
    const running = await service.execute({ command: 'prompt', text: '只分析我提供的模型配置现象，不执行任何操作。', confirmed: true, confirmedToolResults: false });
    expect(running.phase).toBe('running');
    for (let attempt = 0; attempt < 100 && service.isBusy(); attempt += 1) await Bun.sleep(10);
    expect((await service.execute({ command: 'state' })).phase).toBe('error');
    const failed = await service.execute({ command: 'state' });
    expect(failed.lastError).toContain('没有本项目 API Key');
    expect(failed.messages.filter(message => message.role === 'assistant').every(message => message.text === '')).toBe(true);
    expect(service.isBusy()).toBe(false);
    expect((await service.execute({ command: 'stop' })).phase).toBe('stopped');
    const cleared = await service.execute({ command: 'clear' });
    expect(cleared.messages).toEqual([]);
    expect(cleared.model).toBeNull();
    expect(cleared.lastError).toBeNull();
    await service.close();
    await service.close();
    await expect(service.execute({ command: 'start', providerId: value.id, ocsToolsEnabled: false })).rejects.toThrow('已经关闭');
    expect((await readdir(directory)).sort()).toEqual(['model-providers.json']);
    const disk = await readFile(join(directory, 'model-providers.json'), 'utf8');
    expect(disk).not.toContain('只分析我提供');
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Pi OCS startup rejects false/unknown provider tools capability and missing host OCS without fallback', async () => {
  for (const capability of [{ tools: false, message: 'tools=true' }, { tools: null, message: 'tools=true' }, { tools: true, message: '本机会话必须接入 OCS 服务' }] as const) {
    const directory = await mkdtemp(join(tmpdir(), 'swu-pi-ocs-gate-'));
    const value = { ...provider('openaiChatCompletions', 'https://api.deepseek.com'), tools: capability.tools };
    const models = await saveModel(directory, value);
    const service = createPiService(directory, models.privateConfiguration, null);
    try {
      await expect(service.execute({ command: 'start', providerId: value.id, ocsToolsEnabled: true })).rejects.toThrow(capability.message);
      const state = await service.execute({ command: 'state' });
      expect(state.phase).toBe('error');
      expect(state.mode).toBe('diagnose');
      expect(state.tools).toEqual([]);
      expect(state.lastError).toContain(capability.message);
    } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
  }
});

test('Runtime endpoint roots preserve official DeepSeek paths and deny cross-origin requests before fetch', async () => {
  for (const [protocol, baseUrl, expected] of [
    ['openaiChatCompletions', 'https://api.deepseek.com', 'https://api.deepseek.com'],
    ['openaiResponses', 'https://api.deepseek.com', 'https://api.deepseek.com'],
    ['anthropicMessages', 'https://api.deepseek.com/anthropic', 'https://api.deepseek.com/anthropic'],
    ['ollamaChatCompletions', 'http://localhost:11434/v1', 'http://localhost:11434/v1'],
  ] as const) {
    const value = provider(protocol, baseUrl);
    const prepared = createPiProvider(value);
    expect(prepared.model.baseUrl).toBe(expected);
    expect(prepared.model.input).toEqual(['text']);
    expect(prepared.models.getProviders()).toHaveLength(1);
    await expect(piProviderFetch(prepared.model, protocol)('https://example.com/stolen', { method: 'POST' })).rejects.toThrow('超出');
  }
  expect(piRuntimeModel(provider('openaiChatCompletions', 'https://api.deepseek.com/chat/completions')).baseUrl).toBe('https://api.deepseek.com');
  expect(() => createPiProvider(provider('geminiGenerateContent', 'https://generativelanguage.googleapis.com/v1beta'))).toThrow('暂不开放');
});

test('Real Pi request cancellation settles an owned loopback connection without fabricating any model response', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'swu-pi-cancel-'));
  let requests = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 30,
    fetch: () => { requests += 1; return new Promise<Response>(() => {}); },
  });
  const value = provider('ollamaChatCompletions', `http://127.0.0.1:${server.port}/v1`);
  const models = await saveModel(directory, value);
  const service = createPiService(directory, models.privateConfiguration, null);
  try {
    await service.execute({ command: 'start', providerId: value.id, ocsToolsEnabled: false });
    await service.execute({ command: 'prompt', text: '停止发生在私有配置读取完成前，不应发出请求。', confirmed: true, confirmedToolResults: false });
    expect((await service.execute({ command: 'stop' })).phase).toBe('stopped');
    expect(requests).toBe(0);
    await service.execute({ command: 'start', providerId: value.id, ocsToolsEnabled: false });
    await service.execute({ command: 'prompt', text: '只检查取消生命周期，不提供任何模型响应。', confirmed: true, confirmedToolResults: false });
    for (let attempt = 0; attempt < 400 && requests === 0; attempt += 1) await Bun.sleep(10);
    expect(requests).toBe(1);
    expect(service.isBusy()).toBe(true);
    await expect(service.execute({ command: 'prompt', text: '不得重复发送。', confirmed: true, confirmedToolResults: false })).rejects.toThrow('尚未结束');
    const stopped = await service.execute({ command: 'stop' });
    expect(stopped.phase).toBe('stopped');
    expect(stopped.busy).toBe(false);
    expect(requests).toBe(1);
    expect(stopped.tools).toEqual([]);
    expect(stopped.messages.filter(message => message.role === 'assistant').every(message => message.text === '')).toBe(true);
  } finally { await service.close(); await server.stop(true); await rm(directory, { recursive: true, force: true }); }
}, 15000);
