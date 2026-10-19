import { randomUUID } from 'node:crypto';
import type { PiState } from '../shared/pi';

type OcsAction = NonNullable<PiState['approval']>['action'];

interface PendingDecision {
  approval: NonNullable<PiState['approval']>;
  epoch: number;
  settle(approved: boolean): void;
}

/** A one-shot host-only approval gate bound to a backend nonce and one session epoch. */
export function createPiOcsApprovalGate(getSessionEpoch: () => number, requestTimeoutMs: number) {
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) throw new RangeError('Pi OCS approval timeout must be a positive safe integer.');
  let pending: PendingDecision | null = null;

  function current(): PiState['approval'] {
    return pending?.approval ?? null;
  }

  function request(toolCallId: string, action: OcsAction, browserId: string, signal: AbortSignal | undefined): Promise<boolean> {
    if (pending !== null) throw new Error('已有 OCS 动作等待本人审批；拒绝并发申请。');
    if (signal?.aborted) return Promise.reject(new Error('Pi 工具调用已取消。'));
    const epoch = getSessionEpoch();
    const approvalId = randomUUID();
    return new Promise<boolean>((resolve, reject) => {
      let settled = false;
      const finish = (approved: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
        pending = null;
        if (approved) resolve(true);
        else reject(new Error('OCS 动作未获本人批准，未执行。'));
      };
      const abort = (): void => finish(false);
      const timeout = setTimeout(() => finish(false), requestTimeoutMs);
      pending = {
        approval: {
          approvalId, toolCallId, action, browserId,
          risk: action === 'browser-start' ? '启动独立 Chrome 浏览器并可能打开已保存起始页。' : action === 'browser-stop' ? '正常关闭所选 OCS 浏览器及其页面。' : '将所选 OCS 浏览器窗口置于前台。',
        },
        epoch,
        settle: finish,
      };
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  function decide(approvalId: string, approved: boolean): void {
    if (pending === null || pending.epoch !== getSessionEpoch() || pending.approval.approvalId !== approvalId) {
      throw new Error('审批目标不存在、已过期或与当前 Pi 会话不匹配；未执行 OCS 动作。');
    }
    pending.settle(approved);
  }

  function cancel(): void {
    pending?.settle(false);
  }

  return { current, request, decide, cancel };
}
