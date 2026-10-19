import type { Phase } from '../shared/contracts';
import { DakaError } from './errors';

export function assertCanShutdown(phase: Phase): void {
  if (phase !== 'idle' && phase !== 'authenticating') {
    throw new DakaError('OPERATION_BUSY', '任务操作正在进行，暂时不能退出或升级。请等待当前操作完成后重试。', undefined);
  }
}
