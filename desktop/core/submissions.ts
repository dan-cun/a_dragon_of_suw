import type { Submission, Task } from '../shared/contracts';
import { DakaError } from './errors';

export function findSubmission(entries: readonly Submission[], account: string, date: string, taskId: string): Submission | undefined {
  return entries.find(entry => entry.account === account && entry.date === date && entry.taskId === taskId);
}

export function assertNotSubmitted(entries: readonly Submission[], account: string, task: Task): void {
  if (findSubmission(entries, account, task.date, task.id) !== undefined) {
    throw new DakaError('SUBMISSION_HELD', '这项任务已经发起过提交或确认过签到，已停止重复提交；请同步任务核对结果。', undefined);
  }
}

export function claimSubmission(account: string, task: Task, recordId: string | null, now: Date): Submission {
  return { account, date: task.date, taskId: task.id, formId: task.formId, title: task.title, window: task.window,
    recordId, status: 'pending', attemptedAt: now.toISOString(), confirmedAt: null, checks: 0,
    nextCheckAt: now.getTime() + 15_000, lastError: null };
}

export function confirmSubmission(entry: Submission, now: Date): Submission {
  return { ...entry, status: 'confirmed', confirmedAt: now.toISOString(), nextCheckAt: null, lastError: null };
}

export function deferConfirmation(entry: Submission, message: string, now: Date): Submission {
  const checks = Math.min(3, entry.checks + 1);
  return { ...entry, checks, status: checks >= 3 ? 'unresolved' : 'pending', lastError: message.slice(0, 800),
    nextCheckAt: checks >= 3 ? null : now.getTime() + (checks === 1 ? 15_000 : 45_000) };
}

export function replaceSubmission(entries: readonly Submission[], value: Submission): Submission[] {
  const rest = entries.filter(entry => !(entry.account === value.account && entry.date === value.date && entry.taskId === value.taskId));
  if (rest.length >= 2000) throw new Error('本地任务提交记录已达到 2000 条，未执行新提交；请联系维护者归档记录。');
  return [...rest, value];
}
