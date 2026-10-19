import type { OcsBrowser } from '../shared/ocs';

export type OcsLifecycleSource = 'owner.attached' | 'context.close' | 'browser.disconnected' | 'browser.disconnected-state' | 'context.close.requested' | 'browser.close.requested' | 'page.close' | 'page.crash';
export interface OcsLifecycleFields {
  source: OcsLifecycleSource;
  ownerSequence: number;
  currentOwnerSequence: number | null;
  ownerCurrent: boolean;
  attempted: boolean;
  confirmedBefore: boolean;
  contextCloseObserved: boolean;
  browserDisconnectObserved: boolean;
  previousPhase: OcsBrowser['phase'] | null;
  elapsedMs: number;
  browserConnected: boolean | null;
  pageCount: number;
}

/** Encode only allowlisted lifecycle facts in the existing four-argument log contract. */
export function ocsLifecycleMessage(fields: OcsLifecycleFields): string {
  return JSON.stringify({
    version: 1, source: fields.source, ownerSequence: fields.ownerSequence,
    currentOwnerSequence: fields.currentOwnerSequence, ownerCurrent: fields.ownerCurrent,
    attempted: fields.attempted, confirmedBefore: fields.confirmedBefore,
    contextCloseObserved: fields.contextCloseObserved, browserDisconnectObserved: fields.browserDisconnectObserved,
    previousPhase: fields.previousPhase, elapsedMs: fields.elapsedMs,
    browserConnected: fields.browserConnected, pageCount: fields.pageCount
  });
}
