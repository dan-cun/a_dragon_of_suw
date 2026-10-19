import { mkdtempSync, unlinkSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readStore, writeStore } from '../desktop/bun/store';
import { createApplication } from '../desktop/bun/application';
import { resolveEdge, unprotectToken } from '../desktop/bun/native';
import { createClient } from '../desktop/core/api';
import { readSubmissionConfirmation } from '../desktop/core/workflow';

const source = process.env['SWU_READONLY_SESSION_SOURCE'];
const evidence = process.env['SWU_READONLY_EVIDENCE'];
if (source === undefined || evidence === undefined) throw new Error('Select an authorized real session and evidence output explicitly.');
const before = readStore(source);
if (before.session === null) throw new Error('The selected real session is missing.');
const directory = mkdtempSync(join(source, 'readonly-3.1.0-'));
writeStore(directory, { ...before, settings: { ...before.settings, scheduleEnabled: false, launchAtLogin: false } }, before.session);
const application = await createApplication(directory, resolveEdge(), () => false);
try {
  const initial = application.getState().logs.filter(log => log.request !== undefined).length;
  const synchronized = await application.sync();
  if (synchronized.sessionStatus !== 'valid') throw new Error('The real session was not confirmed.');
  const entry = synchronized.submissions.find(entry => entry.account === synchronized.profile?.username && entry.status === 'confirmed');
  if (entry === undefined) throw new Error('No independently confirmed real task is available for read-only verification.');
  let confirmations = 0;
  const client = createClient(fetch, report => {
    if (report.request !== undefined) {
      if (report.request.method !== 'GET' || !report.request.path.endsWith('/form-instance/select')) throw new Error('Confirmation attempted an unexpected endpoint.');
      confirmations += 1;
    }
  });
  if (!await readSubmissionConfirmation(client, await unprotectToken(before.session.encryptedToken), entry)) throw new Error('The independent school query did not confirm the task.');
  const requests = synchronized.logs.filter(log => log.request !== undefined).slice(initial);
  if (requests.some(log => log.request?.path.endsWith('/form-instance/save'))) throw new Error('A save request was issued during read-only validation.');
  const after = readStore(source);
  if (JSON.stringify(after.session) !== JSON.stringify(before.session) || JSON.stringify(after.history) !== JSON.stringify(before.history) || after.lastScheduledDate !== before.lastScheduledDate) throw new Error('The source session or submission history changed.');
  const proof = { version: synchronized.version, realSessionValidated: true, taskConfirmedByIndependentRead: true, legacyHoldMigrated: synchronized.legacyHold === null,
    confirmedLedgerEntries: synchronized.submissions.filter(entry => entry.status === 'confirmed').length, independentSelectRequests: confirmations,
    additionalSaveRequests: 0, originalHistoryUnchanged: true, originalSubmissionMarkerUnchanged: true };
  writeFileSync(evidence, JSON.stringify(proof, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify(proof));
} finally {
  await application.close();
  unlinkSync(join(directory, 'state.json'));
  rmdirSync(directory);
}
