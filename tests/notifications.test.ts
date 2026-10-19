import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNotifications } from '../desktop/bun/notifications';

test('The real Windows tray accepts a notification and closes its native process cleanly', async () => {
  const failures: Error[] = [];
  const service = await createNotifications(mkdtempSync(join(tmpdir(), 'swu-tray-')), async () => {}, error => failures.push(error));
  try {
    await service.notify('西大日常 · 本机验证', '正在验证后台提醒与托盘清理。本次测试没有提交学校任务。');
  } finally {
    await service.close();
  }
  expect(failures.map(error => error.message)).toEqual([]);
}, 30_000);
