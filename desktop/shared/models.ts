import { z } from 'zod';
import type { Result } from './contracts';

export const modelProtocolSchema = z.enum(['openaiChatCompletions', 'openaiResponses', 'anthropicMessages', 'geminiGenerateContent', 'ollamaChatCompletions']);
export const modelProtocols = [
  ['openaiChatCompletions', 'OpenAI Chat Completions'], ['openaiResponses', 'OpenAI Responses'],
  ['anthropicMessages', 'Anthropic Messages'], ['geminiGenerateContent', 'Gemini GenerateContent'],
  ['ollamaChatCompletions', 'Ollama 兼容接口'],
] as const;
const providerUrl = z.url().max(2048).refine(value => {
  const url = new URL(value);
  return !url.username && !url.password && !url.search && !url.hash &&
    (url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
}, 'Use HTTPS, or HTTP on localhost, without credentials, query or fragment.');
const headerSchema = z.record(z.string().regex(/^[A-Za-z0-9-]{1,100}$/), z.string().max(8192).refine(value => !/[\r\n\0]/.test(value)))
  .refine(headers => Object.keys(headers).length <= 20 && Object.keys(headers).every(key => !['host', 'content-length', 'connection', 'cookie'].includes(key.toLowerCase())));
const protectedFields = new Set(['model', 'messages', 'input', 'system', 'tools', 'tool_choice', 'contents', 'systemInstruction', 'toolConfig', 'instructions', 'previous_response_id', 'stream', '__proto__', 'constructor', 'prototype']);
export const providerMetadataSchema = z.object({
  id: z.uuid(), name: z.string().trim().min(1).max(80), protocol: modelProtocolSchema,
  baseUrl: providerUrl, modelId: z.string().trim().min(1).max(200),
  timeoutSeconds: z.number().int().min(5).max(600), contextWindow: z.number().int().min(1024).max(4000000).nullable(),
  maxTokens: z.number().int().min(1).max(1000000).nullable(), vision: z.boolean().nullable(), tools: z.boolean().nullable(),
}).strict();
export const providerSecretSchema = providerMetadataSchema.extend({ apiKey: z.string().max(8192).refine(value => !/[\r\n\0]/.test(value)), headers: headerSchema,
  payloadParameters: z.record(z.string(), z.json()).refine(body => Object.keys(body).length <= 30 && Object.keys(body).every(key => !protectedFields.has(key))),
}).strict().refine(value => value.contextWindow === null || value.maxTokens === null || value.maxTokens <= value.contextWindow, 'Output limit cannot exceed the context window.');
export type ModelProvider = z.infer<typeof providerSecretSchema>;
export const publicProviderSchema = providerMetadataSchema.extend({ hasApiKey: z.boolean(), headerNames: z.array(z.string()), hasPayloadParameters: z.boolean() });
export type PublicModelProvider = z.infer<typeof publicProviderSchema>;
export const modelsStateSchema = z.object({ runtime: z.literal('reserved'), protocolVersion: z.literal(1), referencePiVersion: z.literal('1.1.0'), providers: z.array(publicProviderSchema).max(20) });
export type ModelsState = z.infer<typeof modelsStateSchema>;
export const modelsCommandSchema = z.discriminatedUnion('command', [
  z.object({ command: z.literal('state') }).strict(),
  z.object({ command: z.literal('save'), provider: providerMetadataSchema.extend({ apiKey: providerSecretSchema.shape.apiKey.optional(), headers: headerSchema.optional(), payloadParameters: providerSecretSchema.shape.payloadParameters.optional() }).strict() }).strict(),
  z.object({ command: z.literal('remove'), id: z.uuid() }).strict(),
  z.object({ command: z.literal('forget-key'), id: z.uuid() }).strict(),
]);
export type ModelsCommand = z.infer<typeof modelsCommandSchema>;
declare global { interface Window { models: { execute(command: ModelsCommand): Promise<Result<ModelsState>> } } }
