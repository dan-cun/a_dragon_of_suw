import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readStore, writeStore } from '../desktop/bun/store';
import { assertNotSubmitted, claimSubmission, replaceSubmission, deferConfirmation, confirmSubmission } from '../desktop/core/submissions';
import type { Task } from '../desktop/shared/contracts';

test('Persisted task claims isolate tasks, dates and accounts and do not reset confirmation budgets on restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'swu-submission-ledger-'));
  const account = randomUUID();
  const task: Task = { id: randomUUID(), formId: randomUUID(), cqfbid: '', dormitoryFormId: '', title: 'Local ledger integration',
    date: '2026-10-16', status: '', signed: false, studentId: account, window: ['21:00', '23:30'], address: '', radius: '' };
  const now = new Date('2026-10-16T13:00:00Z');
  const initial = readStore(directory);
  const claimed = claimSubmission(account, task, randomUUID(), now);
  writeStore(directory, { ...initial, submissions: replaceSubmission(initial.submissions, claimed) }, null);
  const restored = readStore(directory);
  expect(() => assertNotSubmitted(restored.submissions, account, task)).toThrow();
  expect(() => assertNotSubmitted(restored.submissions, account, { ...task, id: randomUUID() })).not.toThrow();
  expect(() => assertNotSubmitted(restored.submissions, randomUUID(), task)).not.toThrow();
  expect(() => assertNotSubmitted(restored.submissions, account, { ...task, date: '2026-10-17' })).not.toThrow();
  let pending = claimed;
  for (let index = 1; index <= 3; index += 1) {
    pending = deferConfirmation(pending, 'Awaiting a read-only result.', now);
    writeStore(directory, { ...restored, submissions: [pending] }, null);
    const saved = readStore(directory).submissions[0];
    if (saved === undefined) throw new Error('Submission ledger was not persisted.');
    expect(saved.checks).toBe(index);
    pending = saved;
  }
  expect(pending.status).toBe('unresolved');
  expect(pending.nextCheckAt).toBe(null);
  writeStore(directory, { ...restored, submissions: [{ ...pending, status: 'pending' }] }, null);
  const interrupted = readStore(directory).submissions[0];
  expect(interrupted?.status).toBe('unresolved');
  expect(interrupted?.checks).toBe(3);
  const confirmed = confirmSubmission(pending, now);
  expect(confirmed.status).toBe('confirmed');
  expect(() => assertNotSubmitted([confirmed], account, task)).toThrow();
});
