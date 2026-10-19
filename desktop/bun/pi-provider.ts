import { createModels, createProvider, InMemoryCredentialStore, type Model, type MutableModels, type ProviderStreams } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import type { ModelProvider } from '../shared/models';
import { piRuntimeModel, type PiApi } from '../core/pi-runtime-model';

export class PiConfigurationError extends Error { override name = 'PiConfigurationError'; }

/** Restrict credential-bearing requests to the configured API origin and one message endpoint. */
export function piProviderFetch(model: Model<PiApi>, protocol: ModelProvider['protocol']): typeof globalThis.fetch {
  const base = new URL(model.baseUrl);
  const suffix = protocol === 'openaiResponses' ? '/responses' : protocol === 'anthropicMessages' ? '/v1/messages' : '/chat/completions';
  const endpoint = base.pathname.replace(/\/+$/, '') + suffix;
  const guarded: typeof globalThis.fetch = Object.assign(async (input: string | URL | Request, init: RequestInit | undefined): Promise<Response> => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    if (target.origin !== base.origin || target.pathname !== endpoint || target.username || target.password || target.hash) {
      throw new PiConfigurationError('Pi 请求地址超出本人配置的模型接口范围；已阻止发送鉴权信息。');
    }
    return globalThis.fetch(input, { ...init, redirect: 'error' });
  }, { preconnect: globalThis.fetch.preconnect });
  return guarded;
}

function providerApi(protocol: ModelProvider['protocol']): ProviderStreams {
  switch (protocol) {
    case 'openaiChatCompletions': case 'ollamaChatCompletions': return openAICompletionsApi();
    case 'openaiResponses': return openAIResponsesApi();
    case 'anthropicMessages': return anthropicMessagesApi();
    case 'geminiGenerateContent': throw new PiConfigurationError('当前 Pi 1.3.0 Gemini 原生适配器不支持受限 fetch，暂不开放该协议会话；配置可保留，请改用已核实的 Chat、Responses、Anthropic 或 Ollama 兼容接口。');
  }
}

/** Only the selected app provider exists here; ambient environment and credential files are unavailable. */
export function createPiProvider(provider: ModelProvider): { models: MutableModels; model: Model<PiApi> } {
  const model = piRuntimeModel(provider);
  const models = createModels({ credentials: new InMemoryCredentialStore(), authContext: {
    env: async () => undefined, fileExists: async () => false,
  } });
  const api = providerApi(provider.protocol);
  const key = provider.apiKey || (provider.protocol === 'ollamaChatCompletions' ? 'ollama' : '');
  models.setProvider(createProvider({ id: model.provider, name: provider.name, baseUrl: model.baseUrl, models: [model], api,
    auth: { apiKey: { name: '西大日常私有模型配置',
      check: async () => key ? { type: 'api_key', source: 'SWU private configuration' } : undefined,
      resolve: async () => key ? { auth: { apiKey: key, headers: { ...provider.headers } }, source: 'SWU private configuration' } : undefined,
    } },
  }));
  return { models, model };
}
