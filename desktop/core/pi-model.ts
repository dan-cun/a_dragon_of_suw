import type { ModelProvider } from '../shared/models';

const adapters = { openaiChatCompletions: 'openai-completions', ollamaChatCompletions: 'openai-completions', openaiResponses: 'openai-responses', anthropicMessages: 'anthropic-messages', geminiGenerateContent: 'google-generative-ai' } as const;

export function piModelConfiguration(provider: ModelProvider) {
  if (provider.tools === false) throw new Error('所选模型已标记为不支持工具调用，不能用于后续 Pi 工具会话。');
  const url = new URL(provider.baseUrl);
  let path = url.pathname.replace(/\/+$/, '');
  if (provider.protocol === 'geminiGenerateContent') {
    if (!/\/v1(beta)?$/.test(path)) path += '/v1beta';
  } else {
    const suffix = provider.protocol === 'openaiResponses' ? '/responses' : provider.protocol === 'anthropicMessages' ? '/messages' : '/chat/completions';
    if (path.endsWith(suffix)) path = path.slice(0, -suffix.length);
    if (!path.endsWith('/v1')) path += '/v1';
    if (provider.protocol === 'anthropicMessages') path = path.slice(0, -3);
  }
  return { providerId: provider.id, displayName: provider.name, modelId: provider.modelId, protocol: provider.protocol,
    api: adapters[provider.protocol], baseUrl: url.origin + path, apiKey: provider.apiKey, headers: { ...provider.headers },
    timeoutSeconds: provider.timeoutSeconds, contextWindow: provider.contextWindow, maxTokens: provider.maxTokens,
    vision: provider.vision, tools: provider.tools, payloadParameters: structuredClone(provider.payloadParameters), costKnown: false as const };
}
