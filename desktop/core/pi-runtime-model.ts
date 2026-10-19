import type { Model } from '@earendil-works/pi-ai';
import { providerSecretSchema, type ModelProvider } from '../shared/models';

const protocolApis = { openaiChatCompletions: 'openai-completions', ollamaChatCompletions: 'openai-completions', openaiResponses: 'openai-responses', anthropicMessages: 'anthropic-messages', geminiGenerateContent: 'google-generative-ai' } as const;
export type PiApi = typeof protocolApis[ModelProvider['protocol']];

/** Preserve explicitly configured API roots; SDK adapters append their own endpoint paths. */
export function piRuntimeModel(provider: ModelProvider): Model<PiApi> {
  const checked = providerSecretSchema.parse(provider);
  const url = new URL(checked.baseUrl);
  let path = url.pathname.replace(/\/+$/, '');
  if (checked.protocol === 'geminiGenerateContent') {
    if (!/\/v1(beta)?$/.test(path)) path += '/v1beta';
  } else {
    const endpoint = checked.protocol === 'openaiResponses' ? '/responses' : checked.protocol === 'anthropicMessages' ? '/messages' : '/chat/completions';
    if (path.endsWith(endpoint)) path = path.slice(0, -endpoint.length);
    if (checked.protocol === 'anthropicMessages' && path.endsWith('/v1')) path = path.slice(0, -3);
  }
  // These are local conversation/request budgets, not claims about upstream limits or prices.
  const contextWindow = checked.contextWindow ?? 32768;
  const maxTokens = Math.min(checked.maxTokens ?? 4096, contextWindow);
  return { id: checked.modelId, name: checked.name, provider: `swu-${checked.id}`, api: protocolApis[checked.protocol],
    baseUrl: url.origin + path, input: ['text'], reasoning: false, contextWindow, maxTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
}
