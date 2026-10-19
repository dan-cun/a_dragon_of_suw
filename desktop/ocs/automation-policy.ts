import { z } from 'zod';
import { OCS_PHONE_AUTOMATION } from '../shared/ocs-login';
export { OCS_PHONE_AUTOMATION } from '../shared/ocs-login';

export const OCS_PHONE_LOGIN_URL = 'https://passport2.chaoxing.com/login';
export interface OcsAutomationValue { readonly key: string; readonly value: string }
export interface OcsAutomationConfirmation { readonly confirmed: boolean }

const requiredText = z.string().min(1).max(2000).refine(value => value.trim().length > 0);
const phoneValuesSchema = z.object({ phone: requiredText, password: requiredText });
const entriesSchema = z.array(z.object({ key: z.string().min(1).max(100), value: z.string().max(2000) })).max(30);
const confirmationSchema = z.object({ confirmed: z.literal(true) });
export type OcsPhoneLoginValues = z.infer<typeof phoneValuesSchema>;

const resultBase = {
  name: z.literal(OCS_PHONE_AUTOMATION),
  loginVerified: z.literal(false),
  requiresManualVerification: z.literal(true)
};
export const ocsAutomationResultSchema = z.discriminatedUnion('stage', [
  z.object({ ...resultBase, stage: z.literal('submitted'), submitAttempts: z.literal(1), reason: z.literal('platform-result-unverified') }).strict(),
  z.object({ ...resultBase, stage: z.literal('awaiting-verification'), submitAttempts: z.union([z.literal(0), z.literal(1)]), reason: z.enum(['captcha', 'unrecognized-page']) }).strict()
]);
export type OcsAutomationResult = z.infer<typeof ocsAutomationResultSchema>;

/** Only this fixed-ID upstream adapter is implemented; catalog membership is not execution support. */
export function assertOcsAutomationSupported(name: string): void {
  if (name !== OCS_PHONE_AUTOMATION) throw new RangeError('此 OCS 登录自动化没有已验证的固定 ID 适配；本次未导航、填表或提交。当前仅支持超星-手机密码登录。');
}

/** Validate confirmation before touching the page, and never include supplied values in errors. */
export function parseOcsAutomationValues(name: string, values: readonly OcsAutomationValue[], confirmation: OcsAutomationConfirmation): OcsPhoneLoginValues {
  if (!confirmationSchema.safeParse(confirmation).success) throw new TypeError('OCS 登录执行需要本次操作明确 confirmed:true；保存配置或启动浏览器不构成提交授权。');
  assertOcsAutomationSupported(name);
  const entries = entriesSchema.safeParse(values);
  if (!entries.success) throw new TypeError('OCS 登录参数必须是最多 30 项 key/value 字符串，每个值最多 2000 字符；本次未操作页面。');
  const selected = entries.data.filter(entry => entry.key === 'phone' || entry.key === 'password');
  if (selected.filter(entry => entry.key === 'phone').length !== 1 || selected.filter(entry => entry.key === 'password').length !== 1) {
    throw new TypeError('超星手机密码登录需要且只能各提供一次 phone 与 password；本次未操作页面。');
  }
  const parsed = phoneValuesSchema.safeParse(Object.fromEntries(selected.map(entry => [entry.key, entry.value])));
  if (!parsed.success) throw new TypeError('超星手机密码登录的 phone 与 password 均须为非空字符串，最多 2000 字符；本次未操作页面。');
  return parsed.data;
}

/** Reject redirected, parameterized, embedded-credential and lookalike targets without echoing their URL. */
export function assertOcsAutomationTarget(value: string): void {
  let target: URL;
  try { target = new URL(value); }
  catch { throw new DOMException('OCS 登录目标不是有效的绝对 URL；本次未填表或提交。', 'SecurityError'); }
  if (target.origin !== 'https://passport2.chaoxing.com' || target.pathname !== '/login' || target.search !== '' || target.hash !== '' || target.username !== '' || target.password !== '' || target.href !== OCS_PHONE_LOGIN_URL) {
    throw new DOMException('OCS 登录只允许 https://passport2.chaoxing.com/login 的无查询参数页面；请本人打开该固定登录地址，本次未填表或提交。', 'SecurityError');
  }
}

/** Preserve the causal error chain while removing private input and URL query/fragment data. */
export function redactOcsAutomationCause(cause: unknown, values: OcsPhoneLoginValues, seen: ReadonlySet<Error>): Error {
  const redact = (text: string): string => {
    let clean = text.replace(/https?:\/\/[^\s"'<>]+/gi, '[redacted-url]');
    for (const value of [values.phone, values.password].sort((left, right) => right.length - left.length)) {
      for (const encoded of [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(new TextDecoder().decode(new TextEncoder().encode(value)))]) {
        clean = clean.split(encoded).join('[redacted]');
      }
    }
    return clean;
  };
  if (!(cause instanceof Error)) return new Error('底层页面操作抛出了非 Error 原因；其内容已隐藏以保护私有参数。');
  if (seen.has(cause)) return new Error('底层错误原因包含循环引用。');
  const next = new Set(seen); next.add(cause);
  const error = cause instanceof AggregateError
    ? new AggregateError((cause.errors as unknown[]).map(child => redactOcsAutomationCause(child, values, next)), redact(cause.message))
    : new Error(redact(cause.message));
  error.name = redact(cause.name);
  if (cause.stack) error.stack = redact(cause.stack);
  if (cause.cause !== undefined) error.cause = redactOcsAutomationCause(cause.cause, values, next);
  return error;
}
