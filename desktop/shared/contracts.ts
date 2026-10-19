export type Phase = 'idle' | 'authenticating' | 'syncing' | 'locating' | 'verifying' | 'submitting' | 'confirming';
export type Outcome = 'success' | 'already-signed' | 'failed' | 'unconfirmed';

export interface Profile {
  username: string;
  displayName: string;
}

export interface Task {
  id: string;
  formId: string;
  cqfbid: string;
  dormitoryFormId: string;
  title: string;
  date: string;
  status: string;
  signed: boolean;
  studentId: string;
  window: [string, string];
  address: string;
  radius: string;
}

export interface Position {
  latitude: number;
  longitude: number;
  accuracy: number;
  timestamp: number;
  address: string;
}

export interface Settings {
  scheduleEnabled: boolean;
  scheduleTime: string;
  scheduleMode: 'fixed' | 'random';
  scheduleEndTime: string;
  pausedDates: string[];
  leaveDates: string[];
  closeToTray: boolean;
  launchAtLogin: boolean;
  autoLogin: boolean;
  location: CheckinLocation | null;
}

export interface CheckinLocation {
  longitude: number;
  latitude: number;
  address: string;
}

export interface ScheduleStatus {
  date: string | null;
  failures: number;
  nextCheckAt: number | null;
  pausedReason: string | null;
  targetTime: string | null;
}

export interface RequestMetrics {
  host: string;
  path: string;
  method: 'GET' | 'POST';
  httpStatus: number | null;
  businessCode: number | null;
  responseBytes: number | null;
  elapsedMs: number;
  attempt: number;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  level: 'info' | 'warning' | 'error';
  event: string;
  message: string;
  request?: RequestMetrics;
}

export interface RunRecord {
  id: string;
  timestamp: string;
  taskId: string;
  taskTitle: string;
  outcome: Outcome;
  message: string;
  trigger: 'manual' | 'scheduled';
}

export interface RunOutcome {
  outcome: Exclude<Outcome, 'failed'>;
  message: string;
  task: Task;
}

export interface Submission {
  account: string;
  date: string;
  taskId: string;
  formId: string;
  title: string;
  window: [string, string];
  recordId: string | null;
  status: 'pending' | 'confirmed' | 'unresolved';
  attemptedAt: string;
  confirmedAt: string | null;
  checks: number;
  nextCheckAt: number | null;
  lastError: string | null;
}

export interface LegacyHold { account: string | null; date: string }

export interface AppState {
  version: string;
  phase: Phase;
  sessionStatus: 'signed-out' | 'unverified' | 'valid' | 'rejected';
  rememberedLogin: boolean;
  profile: Profile | null;
  tasks: Task[];
  settings: Settings;
  history: RunRecord[];
  logs: LogEntry[];
  lastSyncedAt: string | null;
  lastScheduledDate: string | null;
  submissions: Submission[];
  legacyHold: LegacyHold | null;
  schedule: ScheduleStatus;
  lastPosition: Position | null;
  authentication: AuthenticationView | null;
}

export interface AuthenticationView {
  active: boolean;
  stage: 'preparing' | 'ready' | 'submitting';
  message: string;
  captcha: string;
  captchaCode: string;
  result: 'pending' | 'success' | 'failed';
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };

export interface DesktopBridge {
  getState(): Promise<Result<AppState>>;
  login(): Promise<Result<AppState>>;
  logout(): Promise<Result<AppState>>;
  forgetLogin(): Promise<Result<AppState>>;
  sync(): Promise<Result<AppState>>;
  saveLocation(location: CheckinLocation): Promise<Result<AppState>>;
  checkin(taskId: string): Promise<Result<AppState>>;
  saveSettings(settings: Settings): Promise<Result<AppState>>;
  openDataFolder(): Promise<Result<void>>;
  openOfficial(): Promise<Result<void>>;
  testNotification(): Promise<Result<void>>;
  quit(): Promise<Result<void>>;
  onState(listener: (state: AppState) => void): () => void;
}

declare global {
  interface Window {
    desktop: DesktopBridge;
  }
}
