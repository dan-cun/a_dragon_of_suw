import { z } from 'zod';

export const OCS_PHONE_AUTOMATION = '超星-手机密码登录';
export const OCS_ICVE_LOGIN = '智慧职教-账号密码登录';
export const OCS_SUPPORTED_LOGINS = [OCS_PHONE_AUTOMATION, OCS_ICVE_LOGIN] as const;
export type OcsSupportedLogin = typeof OCS_SUPPORTED_LOGINS[number];
export const OCS_UNSUPPORTED_LOGINS = {
  '超星-学校机构登录': '上游使用 HTTP 入口并点击首个机构结果；尚无可信机构唯一标识校验，不自动选择或发送密码。',
  '智慧树-手机密码登录': '尚未验证固定登录入口切换后的唯一表单与可信页面状态，不自动点击或发送密码。',
  '智慧树-学校登录': '上游点击首个学校结果并调用页面内部函数；尚无可信学校唯一标识校验，不自动选择或发送密码。',
  '职教云-账号密码登录': '上游仅以 /sso/auth 路径子串判断跳转；尚无该入口实际 SSO origin、参数及表单的可信校验，不发送密码。'
} as const;

export function isSupportedOcsLogin(name: string): name is OcsSupportedLogin {
  return OCS_SUPPORTED_LOGINS.some(supported => supported === name);
}

const resultBase = { name: z.string(), loginVerified: z.literal(false), requiresManualVerification: z.literal(true) };
export const ocsLoginResultSchema = z.discriminatedUnion('status', [
  z.object({ ...resultBase, status: z.literal('unsupported'), submitAttempts: z.literal(0), reason: z.string() }).strict(),
  z.object({ ...resultBase, status: z.literal('awaiting-user'), submitAttempts: z.literal(0), reason: z.enum(['captcha', 'unrecognized-page', 'agreement-required']), message: z.string() }).strict(),
  z.object({ ...resultBase, status: z.literal('submitted-pending-user'), submitAttempts: z.literal(1), reason: z.enum(['captcha', 'platform-result-unverified']), message: z.string() }).strict()
]);
export type OcsLoginResult = z.infer<typeof ocsLoginResultSchema>;
