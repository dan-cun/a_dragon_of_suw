import type { CheckinLocation, Phase, Profile, RunOutcome, Task, Submission } from '../shared/contracts';
import type { Dormitory, DormitoryPayload, MapData, SelectedForm, SwuClient, TaskRecord } from './api';
import { DakaError } from './errors';
import { assertCheckinWindow, getShanghaiClock } from './time';
import { configuredPosition } from './location';
import { assertTaskNotOnLeave } from './schedule-policy';

function assertAccount(profile: Profile, selected: SelectedForm, taskId: string): void {
  if (selected.xh !== profile.username) throw new DakaError('ACCOUNT_MISMATCH', '任务学号与当前登录账号不一致，已停止操作。', undefined);
  if (selected.id !== undefined && selected.id !== taskId) throw new DakaError('INVALID_TASK', '服务端返回了其他任务的表单，已停止操作。', undefined);
}

function dormitoryPayload(taskId: string, selected: SelectedForm, clock: ReturnType<typeof getShanghaiClock>, map: MapData | string): DormitoryPayload {
  return {
    formId: selected.formId, isArchive: selected.isArchive ?? '', qdjg: selected.qdjg,
    tsrq: selected.tsrq, qsqddd: selected.qsqddd, qdbj: selected.qdbj, xh: selected.xh,
    dksj: clock.dateTime, selectMap: JSON.stringify({ $qdjg: selected.qdjg === '1' ? '已签到' : '未签到', $qddz: typeof map === 'string' ? '' : map.address }),
    ycdksfcl: selected.ycdksfcl ?? '', id: taskId, cqfbid: selected.cqfbid, qdtj: '1', qddz: map, qdsj: selected.qdsj,
  };
}

function dormitoryFields(response: Dormitory): { address: string; radius: string } {
  let address = '';
  let radius = '';
  for (const column of response.columnList) {
    if (column.prop === 'qsqddd' && typeof column.value === 'string' && column.value.trim()) address = column.value.trim();
    if (column.prop === 'qdbj' && column.value !== undefined && String(column.value).trim()) radius = String(column.value).trim();
    if (!address && column.address?.trim()) address = column.address.trim();
    if (!radius && column.qdbj !== undefined && String(column.qdbj).trim()) radius = String(column.qdbj).trim();
  }
  return { address, radius };
}

function makeTask(record: TaskRecord, selected: SelectedForm, address: string, radius: string): Task {
  if (selected.tsrq !== record.tsrq) throw new DakaError('INVALID_TASK', '任务列表与表单日期不一致，请重新同步。', undefined);
  const title = record.cqzmc ?? record.title ?? record.name;
  if (title === undefined) throw new DakaError('INVALID_TASK', '服务端任务缺少名称。', undefined);
  return {
    id: record.id, formId: record.formId, cqfbid: selected.cqfbid, dormitoryFormId: selected.formId,
    title, date: selected.tsrq, status: record.qdzt, signed: selected.qdjg === '1', studentId: selected.xh,
    window: selected.qdsj, address, radius,
  };
}

function assertDormitory(task: Task): void {
  const radius = task.radius.match(/^(\d+(?:\.\d+)?)\s*(?:米|m)?$/i);
  if (!task.address.trim() || radius === null || Number(radius[1]) <= 0 || Number(radius[1]) > 100_000) {
    throw new DakaError('INVALID_TASK', '服务端未返回有效寝室地址或签到半径，已停止提交。', undefined);
  }
}

async function todayRecords(client: SwuClient, token: string, now: Date): Promise<TaskRecord[]> {
  const clock = getShanghaiClock(now);
  const records: TaskRecord[] = [];
  const seen = new Set<string>();
  let complete = false;
  let reportedTotal: number | undefined;
  for (let page = 1; page <= 50; page += 1) {
    const response = await client.tasksPage(token, page);
    if (reportedTotal !== undefined && response.total !== undefined && reportedTotal !== response.total) {
      throw new DakaError('INVALID_RESPONSE', '分页期间任务总数变化，请重新同步以避免遗漏。', undefined);
    }
    reportedTotal = response.total ?? reportedTotal;
    for (const record of response.records) {
      if (seen.has(record.id)) throw new DakaError('INVALID_RESPONSE', '分页返回了重复任务，请重新同步。', undefined);
      seen.add(record.id);
      if (seen.size > 1000) throw new DakaError('PAGINATION_LIMIT', '今日任务超过 1000 条上限，已停止同步。', undefined);
      const title = record.cqzmc ?? record.title ?? record.name;
      if (record.tsrq === clock.date && title?.includes('查寝')) records.push(record);
    }
    if (reportedTotal !== undefined && seen.size > reportedTotal) {
      throw new DakaError('INVALID_RESPONSE', '分页记录数超过服务端任务总数。', undefined);
    }
    if (reportedTotal !== undefined ? seen.size === reportedTotal : response.records.length === 0) {
      complete = true;
      break;
    }
    if (response.records.length === 0) throw new DakaError('INVALID_RESPONSE', '分页提前结束，未取得完整任务列表。', undefined);
  }
  if (!complete) throw new DakaError('PAGINATION_LIMIT', '今日任务分页超过 50 页上限，已停止同步以避免遗漏。', undefined);
  return records;
}

export async function syncTasks(client: SwuClient, token: string, now: Date): Promise<{ profile: Profile; tasks: Task[] }> {
  const profile = await client.profile(token);
  const clock = getShanghaiClock(now);
  const records = await todayRecords(client, token, now);
  const tasks: Task[] = [];
  for (const record of records) {
    const selected = await client.select(token, record);
    assertAccount(profile, selected, record.id);
    if (selected.qdjg === '1') {
      tasks.push(makeTask(record, selected, selected.qsqddd, selected.qdbj));
      continue;
    }
    const response = await client.dormitory(token, dormitoryPayload(record.id, selected, clock, ''));
    const fields = dormitoryFields(response);
    const task = makeTask(record, selected, fields.address || selected.qsqddd, fields.radius || selected.qdbj);
    assertDormitory(task);
    tasks.push(task);
  }
  return { profile, tasks };
}

export async function runCheckin(
  client: SwuClient, token: string, taskId: string, location: CheckinLocation,
  now: () => Date, onPhase: (phase: Phase) => void,
): Promise<RunOutcome> {
  onPhase('syncing');
  const profile = await client.profile(token);
  const records = await todayRecords(client, token, now());
  const record = records.find((candidate) => candidate.id === taskId);
  if (record === undefined) throw new DakaError('INVALID_TASK', '所选任务不在今天的查寝任务列表中，请重新同步。', undefined);
  const selected = await client.select(token, record);
  assertAccount(profile, selected, record.id);
  const task = makeTask(record, selected, selected.qsqddd, selected.qdbj);
  assertTaskNotOnLeave(task);
  if (task.signed) return { outcome: 'already-signed', message: '服务端确认该任务已签到，无需重复提交。', task };
  assertCheckinWindow(task, now());
  const position = configuredPosition(location, now());
  const map: MapData = {
    latitude: position.latitude, longitude: position.longitude, accuracy: position.accuracy,
    time: position.timestamp, address: position.address, isOffset: true,
  };
  onPhase('verifying');
  const dormitory = await client.dormitory(token, dormitoryPayload(task.id, selected, getShanghaiClock(now()), map));
  const fields = dormitoryFields(dormitory);
  const currentTask = { ...task, address: fields.address || selected.qsqddd, radius: fields.radius || selected.qdbj };
  assertDormitory(currentTask);
  const verification = await client.verify(token, task.id, map);
  if (!verification.isArea) throw new DakaError('OUTSIDE_AREA', '校园服务判定所填坐标不在签到范围内，请核对坐标和任务地点。', undefined);
  const beforeSubmit = await client.select(token, task);
  assertAccount(profile, beforeSubmit, task.id);
  if (beforeSubmit.qdjg === '1') return { outcome: 'already-signed', message: '提交前查询确认任务已签到，无需重复提交。', task: { ...currentTask, signed: true } };
  if (beforeSubmit.cqfbid !== task.cqfbid || beforeSubmit.formId !== task.dormitoryFormId || beforeSubmit.tsrq !== task.date
    || beforeSubmit.qdsj[0] !== task.window[0] || beforeSubmit.qdsj[1] !== task.window[1]
    || beforeSubmit.qsqddd !== selected.qsqddd || beforeSubmit.qdbj !== selected.qdbj) {
    throw new DakaError('INVALID_TASK', '任务配置在签到过程中发生变化，请重新同步。', undefined);
  }
  assertCheckinWindow(currentTask, now());
  onPhase('submitting');
  let submissionError: DakaError | undefined;
  try {
    await client.save(token, {
      id: task.id, qdjg: '0', $qdjg: '未签到', cqfbid: task.cqfbid, formId: task.formId,
      qdtj: '1', tsrq: task.date, ycdksfcl: selected.ycdksfcl ?? '', isArchive: selected.isArchive ?? '',
      xh: task.studentId, dksj: getShanghaiClock(now()).dateTime, qdsj: task.window,
      qsqddd: currentTask.address, qdbj: currentTask.radius, qddz: { ...map, ...verification }, businessKey: task.id,
    });
  } catch (error) {
    if (!(error instanceof DakaError) || !['TIMEOUT', 'NETWORK_ERROR', 'HTTP_ERROR', 'INVALID_RESPONSE'].includes(error.code)) throw error;
    submissionError = error;
  }
  onPhase('confirming');
  try {
    const confirmed = await client.select(token, task);
    assertAccount(profile, confirmed, task.id);
    if (confirmed.tsrq !== task.date) throw new DakaError('INVALID_TASK', '确认响应的任务日期发生变化。', undefined);
    if (confirmed.qdjg === '1') return { outcome: 'success', message: '重新查询任务后，服务端确认已签到。', task: { ...currentTask, signed: true } };
    return {
      outcome: 'unconfirmed', message: submissionError !== undefined ? `提交响应异常：${submissionError.message} 重新查询仍未显示已签到；请通过官方页面确认，勿重复提交。` : '提交已返回，但重新查询仍未显示已签到；请通过官方页面确认。', task: currentTask,
    };
  } catch (error) {
    if (!(error instanceof DakaError)) throw error;
    return { outcome: 'unconfirmed', message: `提交结果尚未确认：${submissionError !== undefined ? `${submissionError.message} ` : ''}${error.message} 请通过官方页面确认，勿重复提交。`, task: currentTask };
  }
}

export async function readSubmissionConfirmation(client: SwuClient, token: string, entry: Submission): Promise<boolean> {
  const selected = await client.select(token, { id: entry.taskId, formId: entry.formId, window: entry.window });
  if (selected.xh !== entry.account || (selected.id !== undefined && selected.id !== entry.taskId) || selected.tsrq !== entry.date) {
    throw new DakaError('ACCOUNT_MISMATCH', '回查响应的账号、日期或任务不匹配，未更新提交结果。', undefined);
  }
  return selected.qdjg === '1';
}
