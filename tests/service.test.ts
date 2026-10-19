import { expect, test } from 'bun:test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { createLepaoService } from '../desktop/bun/lepao';
import { createApplication } from '../desktop/bun/application';
import { resolveEdge } from '../desktop/bun/native';
import { DakaError } from '../desktop/core/errors';

async function testDirectory(): Promise<string> {
  const root = process.env['TEMP'];
  if (root === undefined) throw new Error('TEMP is unavailable.');
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, 'swu-service-'));
}

test.skipIf(process.env['SWU_LEPAO_ENGINE'] === undefined)('A cold real engine reserves the operation before startup and releases it after completion', async () => {
  const service = createLepaoService(await testDirectory());
  try {
    const operation = service.execute({ command: 'check' });
    expect(service.isBusy()).toBe(true);
    expect(() => service.assertCanClose()).toThrow(DakaError);
    await expect(service.execute({ command: 'check' })).rejects.toMatchObject({ code: 'OPERATION_BUSY' });
    const accepted = await operation;
    expect(accepted.busy).toBe(true);
    expect(accepted.operation?.action).toBe('check');
    expect(accepted.operation?.member).toBeNull();
    expect(accepted.operation?.status).toBe('running');
    const deadline = Date.now() + 40_000;
    while (service.isBusy() && Date.now() < deadline) await Bun.sleep(100);
    expect(service.isBusy()).toBe(false);
    const finished = await service.execute({ command: 'state' });
    expect(finished.result).toContain('环境检查完成');
    expect(finished.capabilities?.licenseValid).toBe(true);
    expect(finished.operation?.id).toBe(accepted.operation?.id);
    expect(finished.operation?.status).toBe('succeeded');
    expect(finished.operation?.phase).toBe('finished');
    expect(finished.operation?.proxyRestored).toBe(true);
    expect(finished.operation?.finishedAt).not.toBeNull();
  } finally {
    if (service.isBusy()) {
      await service.execute({ command: 'stop' });
      const deadline = Date.now() + 40_000;
      while (service.isBusy() && Date.now() < deadline) await Bun.sleep(100);
    }
    await service.close();
  }
  await expect(service.execute({ command: 'state' })).rejects.toMatchObject({ code: 'OPERATION_BUSY' });
}, 90_000);

test('Closing the application prevents new business operations or login from reopening it', async () => {
  const application = await createApplication(await testDirectory(), resolveEdge(), () => false);
  const settings = application.getState().settings;
  await application.close();
  await expect(application.login()).rejects.toMatchObject({ code: 'OPERATION_BUSY' });
  await expect(application.saveSettings(settings)).rejects.toMatchObject({ code: 'OPERATION_BUSY' });
  expect(application.getState().phase).toBe('idle');
});
