import assert from 'node:assert/strict';
import test from 'node:test';
import type { Position, Task } from '../desktop/shared/contracts';
import { DakaError, redact } from '../desktop/core/errors';
import { assertCheckinWindow, assertPosition, getShanghaiClock, isDate } from '../desktop/core/time';
import { configuredPosition } from '../desktop/core/location';
import { assertCanShutdown } from '../desktop/core/shutdown';

const task: Task = {
  id: 'task', formId: 'form', cqfbid: 'publish', dormitoryFormId: 'dorm', title: '查寝',
  date: '2026-09-30', status: '进行中', signed: false, studentId: 'student',
  window: ['21:00', '23:30'], address: '寝室地址', radius: '800米',
};

test('Shanghai task date and window remain correct when the host uses another timezone', () => {
  const now = new Date('2026-09-30T13:00:00Z');
  assert.deepEqual(getShanghaiClock(now), { date: '2026-09-30', time: '21:00', dateTime: '2026-09-30 21:00', minuteOfDay: 1260 });
  assert.doesNotThrow(() => assertCheckinWindow(task, now));
  assert.doesNotThrow(() => assertCheckinWindow(task, new Date('2026-09-30T15:30:00Z')));
  assert.throws(() => assertCheckinWindow(task, new Date('2026-09-30T12:59:59Z')), (error: Error) => error instanceof DakaError && error.code === 'OUTSIDE_WINDOW');
  assert.throws(() => assertCheckinWindow(task, new Date('2026-10-01T13:00:00Z')), (error: Error) => error instanceof DakaError && error.code === 'OUTSIDE_WINDOW');
});

test('Cross-midnight windows and impossible dates fail explicitly', () => {
  assert.throws(() => assertCheckinWindow({ ...task, window: ['23:00', '01:00'] }, new Date('2026-09-30T15:30:00Z')), (error: Error) => error instanceof DakaError && error.code === 'INVALID_TASK');
  assert.equal(isDate('2026-02-29'), false);
  assert.equal(isDate('2024-02-29'), true);
  assert.equal(isDate('2026-09-31'), false);
});

test('Position checks reject stale, future, imprecise, and impossible coordinates', () => {
  const now = new Date('2026-09-30T13:00:00Z');
  const position: Position = { latitude: 0, longitude: 0, accuracy: 20, timestamp: now.getTime(), address: '' };
  assert.doesNotThrow(() => assertPosition(position, now));
  const invalid: Position[] = [
    { ...position, timestamp: now.getTime() - 120_001 },
    { ...position, timestamp: now.getTime() + 5_001 },
    { ...position, accuracy: 201 }, { ...position, accuracy: 0 },
    { ...position, latitude: 91 }, { ...position, longitude: Number.NaN },
  ];
  for (const entry of invalid) assert.throws(() => assertPosition(entry, now), (error: Error) => error instanceof DakaError && error.code === 'INVALID_POSITION');
});

test('Error messages do not expose credentials or account identifiers', () => {
  const safe = redact('fighter-auth-token=secret-token username=student password=private 12345678901', ['secret-token']);
  assert.equal(safe.includes('secret-token'), false);
  assert.equal(safe.includes('student'), false);
  assert.equal(safe.includes('private'), false);
  assert.equal(safe.includes('12345678901'), false);
});

test('Saved coordinates retain their values and receive a fresh request timestamp', () => {
  const input = { longitude: 0, latitude: 0, address: '坐标输入验证' };
  const now = new Date('2026-10-09T13:00:00Z');
  const position = configuredPosition(input, now);
  assert.equal(position.longitude, input.longitude);
  assert.equal(position.latitude, input.latitude);
  assert.equal(position.address, input.address);
  assert.equal(position.timestamp, now.getTime());
  assert.doesNotThrow(() => assertPosition(position, now));
  assert.throws(() => configuredPosition(null, now), (error: Error) => error instanceof DakaError && error.code === 'INVALID_POSITION');
  for (const invalid of [{ ...input, longitude: 181 }, { ...input, latitude: -91 }, { ...input, latitude: Number.NaN }, { ...input, address: ' ' }]) {
    assert.throws(() => configuredPosition(invalid, now), (error: Error) => error instanceof DakaError && error.code === 'INVALID_POSITION');
  }
});

test('Shutdown is allowed while idle or authenticating, but never interrupts a business operation', () => {
  assert.doesNotThrow(() => assertCanShutdown('idle'));
  assert.doesNotThrow(() => assertCanShutdown('authenticating'));
  for (const phase of ['syncing', 'locating', 'verifying', 'submitting', 'confirming'] as const) {
    assert.throws(() => assertCanShutdown(phase), (error: Error) => error instanceof DakaError && error.code === 'OPERATION_BUSY');
  }
});
