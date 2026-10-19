import { Type } from 'typebox';
import { Value } from 'typebox/value';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { OcsCommand, OcsState } from '../shared/ocs';

export interface PiOcsExecutor { execute(command: OcsCommand): Promise<OcsState>; isBusy(): boolean }
type OcsAction = 'browser-start' | 'browser-stop' | 'browser-focus';
type ApprovalRequest = (toolCallId: string, action: OcsAction, browserId: string, signal: AbortSignal | undefined) => Promise<boolean>;
type SessionEpoch = () => number;
type ConsumeBudget = () => void;

const overviewParameters = Type.Object({}, { additionalProperties: false });
const actionParameters = Type.Object({
  action: Type.Union([Type.Literal('browser-start'), Type.Literal('browser-stop'), Type.Literal('browser-focus')]),
  browserId: Type.String({ pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' }),
}, { additionalProperties: false });
type PiOcsParameters = typeof overviewParameters | typeof actionParameters;
type PiOcsTools = readonly [AgentTool<typeof overviewParameters, null>, AgentTool<typeof actionParameters, null>];

function validateToolCall(toolCallId: unknown, params: unknown, schema: PiOcsParameters, signal: unknown): void {
  if (typeof toolCallId !== 'string' || toolCallId.length < 1 || toolCallId.length > 256) throw new TypeError('Pi OCS tool call ID is invalid.');
  if (!Value.Check(schema, params)) throw new TypeError('Pi OCS tool parameters do not match the declared schema; no OCS action was performed.');
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('Pi OCS tool cancellation signal is invalid.');
}

function publicOverview(state: OcsState) {
  return {
    integration: state.integration,
    phase: state.phase,
    browsers: state.browsers.map(browser => ({ id: browser.id, phase: browser.phase })),
    capabilities: state.capabilities.map(capability => ({ id: capability.id, available: capability.available })),
  };
}

function requireApplicable(state: OcsState, action: OcsAction, browserId: string): string {
  if (!Number.isSafeInteger(state.configurationRevision) || state.configurationRevision < 0) throw new Error('OCS 配置版本无效，拒绝继续审批。');
  const browser = state.browsers.find(candidate => candidate.id === browserId);
  if (!browser) throw new Error('目标浏览器资料已变化或不存在，请重新读取 OCS 概览。');
  if (action !== 'browser-start' && browser.owned !== true) throw new Error('目标浏览器当前不由 OCS 服务持有，拒绝停止或聚焦。');
  if (action === 'browser-start' && browser.phase !== 'stopped' && browser.phase !== 'failed') throw new Error('目标浏览器状态已变化，启动申请已失效。');
  if (action === 'browser-stop' && browser.phase !== 'running') throw new Error('目标浏览器状态已变化，停止申请已失效。');
  if (action === 'browser-focus' && browser.phase !== 'running') throw new Error('目标浏览器状态已变化，聚焦申请已失效。');
  return JSON.stringify({ configurationRevision: state.configurationRevision, browser });
}

async function readOcsState(ocs: PiOcsExecutor): Promise<OcsState> {
  try { return await ocs.execute({ command: 'state' }); }
  catch (cause) { throw new Error('OCS 状态读取失败，未向模型提供状态细节。', { cause }); }
}

async function executeOcsAction(ocs: PiOcsExecutor, command: OcsCommand): Promise<OcsState> {
  try { return await ocs.execute(command); }
  catch (cause) { throw new Error('OCS 动作执行失败，敏感异常详情不会提供给模型。', { cause }); }
}

function safeActionResult(state: OcsState, browserId: string) {
  const browser = state.browsers.find(candidate => candidate.id === browserId);
  if (!browser) throw new Error('OCS 操作返回时目标资料已不存在。');
  return { browserId, phase: browser.phase, capabilities: state.capabilities.filter(capability => capability.available).map(capability => capability.id) };
}

/** Creates the only OCS tools exposed to an explicitly enabled Pi session. */
export function createPiOcsTools(ocs: PiOcsExecutor, requestApproval: ApprovalRequest, getSessionEpoch: SessionEpoch, consumeBudget: ConsumeBudget): PiOcsTools {
  const overview: AgentTool<typeof overviewParameters, null> = {
    name: 'ocs_overview',
    label: '读取 OCS 最小概览',
    description: 'Read only browser profile IDs and runtime phases plus real capability IDs and availability. No titles, URLs, paths, settings, logs, automation values, or preview data are returned.',
    parameters: overviewParameters,
    execute: async (toolCallId, params, signal) => {
      validateToolCall(toolCallId, params, overviewParameters, signal);
      if (signal?.aborted) throw new Error('Pi OCS 概览调用已取消。');
      consumeBudget();
      return { content: [{ type: 'text', text: JSON.stringify(publicOverview(await readOcsState(ocs))) }], details: null };
    },
  };
  const action: AgentTool<typeof actionParameters, null> = {
    name: 'ocs_browser_action',
    label: '申请 OCS 浏览器动作',
    description: 'Request one host-mediated browser start, stop, or focus action. Every request waits for a separate user approval in the application UI; the tool cannot approve itself.',
    parameters: actionParameters,
    executionMode: 'sequential',
    replay: 'never',
    execute: async (toolCallId, params, signal) => {
      validateToolCall(toolCallId, params, actionParameters, signal);
      if (signal?.aborted) throw new Error('Pi OCS 动作调用已取消。');
      consumeBudget();
      const requestEpoch = getSessionEpoch();
      const before = await readOcsState(ocs);
      const beforeFingerprint = requireApplicable(before, params.action, params.browserId);
      const approved = await requestApproval(toolCallId, params.action, params.browserId, signal);
      if (!approved || signal?.aborted || requestEpoch !== getSessionEpoch()) throw new Error('用户未批准或会话已取消，本次 OCS 动作未执行。');
      const current = await readOcsState(ocs);
      const currentFingerprint = requireApplicable(current, params.action, params.browserId);
      if (currentFingerprint !== beforeFingerprint || ocs.isBusy()) throw new Error('OCS 配置版本、目标资料或运行状态在审批期间发生变化，本次动作已拒绝。');
      if (signal?.aborted || requestEpoch !== getSessionEpoch()) throw new Error('审批后 Pi 会话已停止，本次 OCS 动作未执行。');
      const command: OcsCommand = params.action === 'browser-start'
        ? { command: 'browser-start', id: params.browserId }
        : params.action === 'browser-stop'
          ? { command: 'browser-stop', id: params.browserId }
          : { command: 'browser-focus', id: params.browserId };
      const result = await executeOcsAction(ocs, command);
      return { content: [{ type: 'text', text: JSON.stringify(safeActionResult(result, params.browserId)) }], details: null };
    },
  };
  return [overview, action];
}
