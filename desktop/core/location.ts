import type { CheckinLocation, Position } from '../shared/contracts';
import { locationSchema } from '../shared/validation';
import { DakaError } from './errors';

export function configuredPosition(location: CheckinLocation | null, now: Date): Position {
  const parsed = locationSchema.safeParse(location);
  if (!parsed.success) throw new DakaError('INVALID_POSITION', '请先填写并保存签到经度、纬度和地点名称。', undefined);
  if (!Number.isFinite(now.getTime())) throw new DakaError('INVALID_POSITION', '无法生成签到时间，请检查系统时钟。', undefined);
  // Match the upstream coordinate payload; accuracy is a protocol value, not a device measurement.
  return { ...parsed.data, accuracy: 56, timestamp: now.getTime() };
}
