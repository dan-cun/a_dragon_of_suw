import type { AppState, CheckinLocation, DesktopBridge, Result, Settings } from '../shared/contracts';
import { z } from 'zod';
import { appStateSchema } from '../shared/validation';
import { lepaoStateSchema } from '../shared/lepao';

async function request<T>(path: string, body: object, schema: z.ZodType<T>): Promise<Result<T>> {
  const response = await fetch(path, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-SWU-Request': '1' },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`本地应用请求失败（HTTP ${response.status}）。请重新打开程序。`);
  const decoded: unknown = await response.json();
  return z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), value: schema }),
    z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) })
  ]).parse(decoded);
}

const source = new EventSource('/api/events');
const voidSchema = z.null().transform(() => undefined);
const bridge: DesktopBridge = {
  getState: () => request<AppState>('/api/state', {}, appStateSchema),
  login: () => request<AppState>('/api/login', {}, appStateSchema),
  logout: () => request<AppState>('/api/logout', {}, appStateSchema),
  forgetLogin: () => request<AppState>('/api/forget-login', {}, appStateSchema),
  sync: () => request<AppState>('/api/sync', {}, appStateSchema),
  saveLocation: (location: CheckinLocation) => request<AppState>('/api/location', location, appStateSchema),
  checkin: (taskId: string) => request<AppState>('/api/checkin', { taskId }, appStateSchema),
  saveSettings: (settings: Settings) => request<AppState>('/api/settings', settings, appStateSchema),
  openDataFolder: () => request<void>('/api/data', {}, voidSchema),
  openOfficial: () => request<void>('/api/official', {}, voidSchema),
  testNotification: () => request<void>('/api/notifications/test', {}, voidSchema),
  quit: () => request<void>('/api/quit', {}, voidSchema),
  onState: (listener: (state: AppState) => void) => {
    const receive = (event: MessageEvent<string>): void => listener(appStateSchema.parse(JSON.parse(event.data)));
    source.addEventListener('state', receive);
    return () => source.removeEventListener('state', receive);
  }
};
window.desktop = bridge;
window.lepao = { execute: command => request('/api/lepao', command, lepaoStateSchema) };
