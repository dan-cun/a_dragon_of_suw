import type { OcsBrowser, OcsCommand, OcsState } from '../shared/ocs';

export type ExecuteOcs = (command: OcsCommand) => Promise<boolean>;
export type BrowserMetadata = Extract<OcsCommand, { command: 'browser-create' }>['browser'];
export type AutomationDefinition = OcsState['automationCatalog'][number];
export type Confirmation = { title: string; description: string; command: OcsCommand };
export type ConfirmOcs = (confirmation: Confirmation) => void;

export const browserPhaseLabels: Record<OcsBrowser['phase'], string> = {
  stopped: '未运行', starting: '启动中', running: '运行中', stopping: '停止中', failed: '失败'
};

export function formatTime(value: string): string {
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', { hour12: false, dateStyle: 'short', timeStyle: 'medium' }).format(time);
}

export function metadataFromBrowser(browser: OcsBrowser): BrowserMetadata {
  return { name: browser.name, folder: browser.folder, notes: browser.notes, tags: [...browser.tags], startUrl: browser.startUrl };
}

export function emptyMetadata(): BrowserMetadata {
  return { name: '', folder: '', notes: '', tags: [], startUrl: 'about:blank' };
}
