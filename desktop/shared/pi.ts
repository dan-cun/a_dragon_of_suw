import { z } from 'zod';
import type { Result } from './contracts';
import { modelProtocolSchema } from './models';

const stateCommandSchema = z.object({ command: z.literal('state') }).strict();
const startCommandSchema = z.object({ command: z.literal('start'), providerId: z.uuid(), ocsToolsEnabled: z.boolean() }).strict();
const promptCommandSchema = z.object({ command: z.literal('prompt'), text: z.string().trim().min(1).max(16000), confirmed: z.literal(true), confirmedToolResults: z.boolean() }).strict();
const stopCommandSchema = z.object({ command: z.literal('stop') }).strict();
const clearCommandSchema = z.object({ command: z.literal('clear') }).strict();
export const piCommandSchema = z.discriminatedUnion('command', [stateCommandSchema, startCommandSchema, promptCommandSchema, stopCommandSchema, clearCommandSchema]);
export const piApprovalCommandSchema = z.object({ command: z.literal('approval'), approvalId: z.uuid(), approved: z.boolean() }).strict();
export const piServiceCommandSchema = z.union([piCommandSchema, piApprovalCommandSchema]);
export type PiCommand = z.infer<typeof piServiceCommandSchema>;
export const piMessageSchema = z.object({ id: z.uuid(), role: z.enum(['user', 'assistant']), text: z.string().max(100000), createdAt: z.string().datetime() });
export const piOcsApprovalSchema = z.object({
  approvalId: z.uuid(),
  toolCallId: z.string().min(1).max(256),
  action: z.enum(['browser-start', 'browser-stop', 'browser-focus']),
  browserId: z.uuid(),
  risk: z.string().max(500),
}).strict();
export const piStateSchema = z.object({
  runtime: z.literal('native-sdk'), sdkVersion: z.literal('1.3.0'), mode: z.enum(['diagnose', 'ocs']),
  phase: z.enum(['stopped', 'starting', 'ready', 'running', 'error']), busy: z.boolean(), costKnown: z.literal(false),
  tools: z.array(z.string()).max(2), approval: piOcsApprovalSchema.nullable(),
  model: z.object({ providerId: z.uuid(), name: z.string(), modelId: z.string(), protocol: modelProtocolSchema }).nullable(),
  messages: z.array(piMessageSchema).max(40), lastError: z.string().nullable(),
});
export type PiState = z.infer<typeof piStateSchema>;
export type PiMessage = z.infer<typeof piMessageSchema>;
declare global { interface Window { pi: { execute(command: PiCommand): Promise<Result<PiState>> } } }
