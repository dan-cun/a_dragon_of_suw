export type ErrorCode =
  | 'AUTH_REQUIRED' | 'HTTP_ERROR' | 'BUSINESS_ERROR' | 'NETWORK_ERROR' | 'TIMEOUT'
  | 'INVALID_RESPONSE' | 'RESPONSE_TOO_LARGE' | 'PAGINATION_LIMIT' | 'INVALID_TASK'
  | 'ACCOUNT_MISMATCH' | 'OUTSIDE_WINDOW' | 'INVALID_POSITION' | 'OUTSIDE_AREA'
  | 'UNSUPPORTED_PLATFORM' | 'WINDOWS_LOCATION_FAILED' | 'RETRY_EXHAUSTED' | 'SUBMISSION_HELD' | 'LEAVE_DAY' | 'SCHEDULE_ENDED' | 'OPERATION_BUSY';

export class DakaError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, cause: Error | undefined) {
    super(message, { cause });
    this.name = 'DakaError';
    this.code = code;
  }
}

export function redact(message: string, secrets: readonly string[]): string {
  let safe = message;
  for (const secret of secrets) {
    if (secret.length > 0) safe = safe.split(secret).join('[redacted]');
  }
  return safe
    .replace(/((?:access[_-]?token|fighter-auth-token|password|authorization|cookie|loginName|username|xh|imei)["']?\s*[=:]\s*["']?)[^\s,;"}]+/gi, '$1[redacted]')
    .replace(/\b\d{8,}\b/g, '[redacted]')
    .slice(0, 400);
}

export function sanitizedCause(error: Error, secrets: readonly string[]): Error {
  const cause = new Error(redact(error.message, secrets));
  cause.name = error.name;
  if (error.stack !== undefined) cause.stack = redact(error.stack, secrets);
  return cause;
}
