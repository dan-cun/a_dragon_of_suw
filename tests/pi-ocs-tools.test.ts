import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createPiOcsApprovalGate } from '../desktop/bun/pi-ocs-approval';
import { createPiOcsTools } from '../desktop/bun/pi-ocs-tools';
import { createOcsService } from '../desktop/bun/ocs';
import type { OcsState } from '../desktop/shared/ocs';

const chromePath = 'D:\\Code\\swu-campus-assistant\\ocs-2.12.0\\resources\\bin\\chrome\\chrome\\chrome.exe';
const integrationTest = existsSync(chromePath) ? test : test.skip;
const metadata = { name: 'Pi isolated test profile', folder: 'Pi-OCS-test', notes: 'No accounts or course data', tags: ['isolated-test'], startUrl: 'about:blank' };

function trackAction<T>(actions: Promise<unknown>[], action: Promise<T>): Promise<T> {
  actions.push(action);
  void action.catch(() => undefined);
  return action;
}

function realOcsService(directory: string) {
  process.env['SWU_OCS_BROWSER'] = chromePath;
  return createOcsService(directory);
}

async function waitForApproval(toolCallId: string, gate: ReturnType<typeof createPiOcsApprovalGate>): Promise<void> {
  for (let attempt = 0; attempt < 300 && gate.current()?.toolCallId !== toolCallId; attempt += 1) await Bun.sleep(10);
  if (gate.current()?.toolCallId !== toolCallId) throw new Error('Host approval request did not arrive within 3 seconds.');
}

integrationTest('Pi OCS production SDK tools expose minimal DTOs and require one-time host approval against real Chrome/DPAPI', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'swu-pi-ocs-'));
  const previousBrowser = process.env['SWU_OCS_BROWSER'];
  const ocs = realOcsService(directory);
  let epoch = 1;
  let budget = 3;
  const gate = createPiOcsApprovalGate(() => epoch, 120_000);
  const tools = createPiOcsTools(ocs, gate.request, () => epoch, () => {
    if (budget <= 0) throw new Error('budget exhausted');
    budget -= 1;
  });
  const [overview, action] = tools;
  const pendingActions: Promise<unknown>[] = [];
  try {
    const created = await ocs.execute({ command: 'browser-create', browser: metadata });
    const browser = created.browsers[0];
    if (!browser) throw new Error('Isolated OCS browser metadata was not created.');
    const overviewResult = await overview.execute('overview-call', {}, new AbortController().signal);
    const overviewText = overviewResult.content.find(item => item.type === 'text');
    if (!overviewText || overviewText.type !== 'text') throw new Error('OCS overview tool returned no text DTO.');
    const dto: unknown = JSON.parse(overviewText.text);
    if (typeof dto !== 'object' || dto === null || Array.isArray(dto)) throw new Error('OCS overview tool returned an invalid DTO.');
    expect(Object.keys(dto).sort()).toEqual(['browsers', 'capabilities', 'integration', 'phase']);
    expect(dto).toMatchObject({ integration: 'source', browsers: [{ id: browser.id, phase: 'stopped' }] });
    expect(overviewText.text).not.toContain(metadata.name);
    expect(overviewText.text).not.toContain(metadata.startUrl);
    for (const forbiddenField of ['dataDirectory', 'browserExecutable', 'settings', 'globalConfigJson', 'logs', 'preview', 'automationRun', 'automationCatalog', 'userScripts', 'extensions', 'credentials', 'password', 'cookie']) {
      expect(overviewText.text).not.toContain(`"${forbiddenField}":`);
    }

    const denied = trackAction(pendingActions, action.execute('denied-tool-call', { action: 'browser-start', browserId: browser.id }, new AbortController().signal));
    await waitForApproval('denied-tool-call', gate);
    const deniedApproval = gate.current();
    if (!deniedApproval) throw new Error('Denied OCS approval request disappeared before the decision.');
    gate.decide(deniedApproval.approvalId, false);
    await expect(denied).rejects.toThrow();
    expect(() => gate.decide(deniedApproval.approvalId, true)).toThrow('不存在');
    expect((await ocs.execute({ command: 'state' })).browsers[0]?.phase).toBe('stopped');
    budget = 3;

    const timedGate = createPiOcsApprovalGate(() => epoch, 20);
    const timedOut = timedGate.request('timeout-tool-call', 'browser-start', browser.id, undefined);
    const expiredApprovalId = timedGate.current()?.approvalId;
    await expect(timedOut).rejects.toThrow('未获本人批准');
    expect(timedGate.current()).toBeNull();
    if (!expiredApprovalId) throw new Error('Timed approval did not receive a host-generated UUID.');
    expect(() => timedGate.decide(expiredApprovalId, true)).toThrow('不存在');

    const extraOverviewParameters = { unexpected: true };
    await expect(overview.execute('invalid-overview-call', extraOverviewParameters, new AbortController().signal)).rejects.toThrow('parameters');
    await expect(action.execute('invalid-action-call', { action: 'browser-start', browserId: 'not-a-uuid' }, new AbortController().signal)).rejects.toThrow('parameters');
    await expect(action.execute('invalid-signal-call', { action: 'browser-start', browserId: browser.id }, {} as AbortSignal)).rejects.toThrow('signal');

    const settingsBefore = await ocs.execute({ command: 'state' });
    const settingsRace = trackAction(pendingActions, action.execute('private-settings-change-call', { action: 'browser-start', browserId: browser.id }, new AbortController().signal));
    await waitForApproval('private-settings-change-call', gate);
    const settingsApproval = gate.current();
    if (!settingsApproval) throw new Error('Private-settings approval disappeared before configuration changed.');
    const privateTestValue = 'not-a-real-credential-' + crypto.randomUUID();
    const privateSettings = {
      ...settingsBefore.settings,
      globalConfigJson: JSON.stringify({ 'common.settings.answererWrappers': [{ authorization: privateTestValue }] }),
    };
    const changedSettings = await ocs.execute({ command: 'settings-save', settings: privateSettings });
    expect(changedSettings.configurationRevision).toBeGreaterThan(settingsBefore.configurationRevision);
    expect(changedSettings.settings.globalConfigJson).not.toContain(privateTestValue);
    gate.decide(settingsApproval.approvalId, true);
    await expect(settingsRace).rejects.toThrow('配置版本');
    expect((await ocs.execute({ command: 'state' })).browsers[0]?.phase).toBe('stopped');
    budget = 3;

    const scriptsBefore = await ocs.execute({ command: 'state' });
    const scriptRace = trackAction(pendingActions, action.execute('script-import-change-call', { action: 'browser-start', browserId: browser.id }, new AbortController().signal));
    await waitForApproval('script-import-change-call', gate);
    const scriptApproval = gate.current();
    if (!scriptApproval) throw new Error('Script-import approval disappeared before configuration changed.');
    const importedDuringApproval = await ocs.execute({
      command: 'script-import',
      name: 'Pi approval revision test',
      content: '// ==UserScript==\n// @name Pi approval revision test\n// @match http://127.0.0.1/*\n// @grant none\n// ==/UserScript==\nvoid 0;',
    });
    expect(importedDuringApproval.configurationRevision).toBeGreaterThan(scriptsBefore.configurationRevision);
    gate.decide(scriptApproval.approvalId, true);
    await expect(scriptRace).rejects.toThrow('配置版本');
    expect((await ocs.execute({ command: 'state' })).browsers[0]?.phase).toBe('stopped');
    budget = 3;

    const stale = trackAction(pendingActions, action.execute('stale-tool-call', { action: 'browser-start', browserId: browser.id }, new AbortController().signal));
    await waitForApproval('stale-tool-call', gate);
    await ocs.execute({ command: 'browser-update', id: browser.id, browser: { ...metadata, notes: 'Changed while approval was pending' } });
    const staleApproval = gate.current();
    if (!staleApproval) throw new Error('Stale OCS approval request disappeared before the decision.');
    gate.decide(staleApproval.approvalId, true);
    await expect(stale).rejects.toThrow('已拒绝');
    expect(() => gate.decide(staleApproval.approvalId, true)).toThrow('不存在');
    expect((await ocs.execute({ command: 'state' })).browsers[0]?.phase).toBe('stopped');
    budget = 3;

    const cancelled = trackAction(pendingActions, action.execute('cancelled-tool-call', { action: 'browser-start', browserId: browser.id }, new AbortController().signal));
    await waitForApproval('cancelled-tool-call', gate);
    epoch += 1;
    gate.cancel();
    await expect(cancelled).rejects.toThrow();
    expect(gate.current()).toBeNull();
    expect((await ocs.execute({ command: 'state' })).browsers[0]?.phase).toBe('stopped');
    budget = 3;
    epoch += 1;

    const alternateState = await ocs.execute({ command: 'browser-create', browser: { ...metadata, name: 'Pi second isolated profile', folder: 'Pi-OCS-test-second' } });
    const alternateBrowser = alternateState.browsers.find(candidate => candidate.id !== browser.id);
    if (!alternateBrowser) throw new Error('Second isolated OCS browser profile was not created.');

    const firstReuse = trackAction(pendingActions, action.execute('reused-tool-call', { action: 'browser-start', browserId: browser.id }, new AbortController().signal));
    await waitForApproval('reused-tool-call', gate);
    const originalApproval = gate.current();
    if (!originalApproval) throw new Error('Original reused-call approval disappeared.');
    gate.decide(originalApproval.approvalId, false);
    await expect(firstReuse).rejects.toThrow();

    budget = 3;
    const secondReuse = trackAction(pendingActions, action.execute('reused-tool-call', { action: 'browser-start', browserId: alternateBrowser.id }, new AbortController().signal));
    await waitForApproval('reused-tool-call', gate);
    const targetApproval = gate.current();
    if (!targetApproval) throw new Error('Cross-target reused-call approval disappeared.');
    expect(targetApproval.toolCallId).toBe(originalApproval.toolCallId);
    expect(targetApproval.browserId).toBe(alternateBrowser.id);
    expect(targetApproval.approvalId).not.toBe(originalApproval.approvalId);
    expect(() => gate.decide(originalApproval.approvalId, true)).toThrow('不存在');
    expect(gate.current()?.approvalId).toBe(targetApproval.approvalId);
    gate.decide(targetApproval.approvalId, false);
    await expect(secondReuse).rejects.toThrow();

    epoch += 1;
    budget = 3;
    const thirdReuse = trackAction(pendingActions, action.execute('reused-tool-call', { action: 'browser-start', browserId: alternateBrowser.id }, new AbortController().signal));
    await waitForApproval('reused-tool-call', gate);
    const sessionApproval = gate.current();
    if (!sessionApproval) throw new Error('Cross-session reused-call approval disappeared.');
    expect(sessionApproval.toolCallId).toBe(targetApproval.toolCallId);
    expect(sessionApproval.approvalId).not.toBe(targetApproval.approvalId);
    expect(() => gate.decide(targetApproval.approvalId, true)).toThrow('不存在');
    expect(gate.current()?.approvalId).toBe(sessionApproval.approvalId);
    gate.decide(sessionApproval.approvalId, false);
    await expect(thirdReuse).rejects.toThrow();
    expect((await ocs.execute({ command: 'state' })).browsers.every(candidate => candidate.phase === 'stopped')).toBe(true);
    budget = 3;

    const start = trackAction(pendingActions, action.execute('approved-start-tool-call', { action: 'browser-start', browserId: browser.id }, new AbortController().signal));
    await waitForApproval('approved-start-tool-call', gate);
    const startApproval = gate.current();
    if (!startApproval) throw new Error('Approved OCS start request disappeared before the decision.');
    gate.decide(startApproval.approvalId, true);
    const started = await start;
    expect(started.content.some(item => item.type === 'text' && item.text.includes('"phase":"running"'))).toBe(true);
    expect((await ocs.execute({ command: 'state' })).browsers[0]?.phase).toBe('running');
    expect(() => gate.decide(startApproval.approvalId, true)).toThrow('不存在');

    const focus = trackAction(pendingActions, action.execute('approved-focus-tool-call', { action: 'browser-focus', browserId: browser.id }, new AbortController().signal));
    await waitForApproval('approved-focus-tool-call', gate);
    const focusApproval = gate.current();
    if (!focusApproval) throw new Error('Approved OCS focus request disappeared before the decision.');
    gate.decide(focusApproval.approvalId, true);
    await focus;

    const stop = trackAction(pendingActions, action.execute('approved-stop-tool-call', { action: 'browser-stop', browserId: browser.id }, new AbortController().signal));
    await waitForApproval('approved-stop-tool-call', gate);
    const stopApproval = gate.current();
    if (!stopApproval) throw new Error('Approved OCS stop request disappeared before the decision.');
    gate.decide(stopApproval.approvalId, true);
    const stopped = await stop;
    expect(stopped.content.some(item => item.type === 'text' && item.text.includes('"phase":"stopped"'))).toBe(true);
    const finalState: OcsState = await ocs.execute({ command: 'state' });
    expect(finalState.browsers[0]?.phase).toBe('stopped');
    await Bun.write(join(resolve(process.env['SWU_PI_OCS_APPROVAL_EVIDENCE'] ?? 'work'), 'pi-ocs-approval-result.json'), JSON.stringify({ realChrome: true, realDpapiService: true, modelRequests: 0, externalAccounts: false, actions: ['denied-start: no effect', 'duplicate approval rejected', 'timeout invalidated approvalId', 'runtime argument validation rejected unknown overview fields, invalid UUID and malformed signal', 'private settings change invalidated approval and remained redacted', 'script import invalidated approval', 'browser metadata change invalidated approval', 'reused toolCallId across targets rejected stale approvalId', 'reused toolCallId across session epochs rejected stale approvalId', 'stopped session cancelled approval', 'approved-start: running', 'approved-stop: stopped'], finalPhase: finalState.browsers[0]?.phase }, null, 2));
  } finally {
    epoch += 1;
    gate.cancel();
    try { await ocs.close(); }
    finally {
      if (previousBrowser === undefined) delete process.env['SWU_OCS_BROWSER'];
      else process.env['SWU_OCS_BROWSER'] = previousBrowser;
      await rm(directory, { recursive: true, force: true });
    }
  }
}, 120_000);
