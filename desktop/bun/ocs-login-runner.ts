import type { Page } from 'playwright-core';
import { z } from 'zod';
import { runOcsAutomation } from './ocs-automation';
import { submitIcveFormOnce } from '../ocs/login-submission-policy';
import {
  OCS_PHONE_AUTOMATION, OCS_PHONE_LOGIN_URL, redactOcsAutomationCause,
  type OcsAutomationConfirmation, type OcsAutomationValue
} from '../ocs/automation-policy';
import { OCS_ICVE_LOGIN, OCS_UNSUPPORTED_LOGINS, isSupportedOcsLogin, ocsLoginResultSchema, type OcsLoginResult, type OcsSupportedLogin } from '../shared/ocs-login';
export { OCS_ICVE_LOGIN, OCS_SUPPORTED_LOGINS, OCS_UNSUPPORTED_LOGINS, isSupportedOcsLogin, ocsLoginResultSchema, type OcsLoginResult } from '../shared/ocs-login';

export const OCS_ICVE_LOGIN_URL = 'https://sso.icve.com.cn/sso/auth?mode=simple&source=2&redirect=https://mooc.icve.com.cn/cms/';
export interface OcsLoginAutomation { readonly name: string; readonly values: readonly OcsAutomationValue[] }

const automationSchema = z.object({
  name: z.string().min(1).max(100),
  values: z.array(z.object({ key: z.string().min(1).max(100), value: z.string().max(2000) })).max(30)
});
const confirmationSchema = z.object({ confirmed: z.literal(true) });
const credentialSchema = z.string().min(1).max(2000).refine(value => value.trim().length > 0);

/** Pin the complete upstream URL, not a substring, before any credential-bearing operation. */
export function assertOcsLoginTarget(name: OcsSupportedLogin, value: string): void {
  const canonical = name === OCS_PHONE_AUTOMATION ? OCS_PHONE_LOGIN_URL : OCS_ICVE_LOGIN_URL;
  let target: URL;
  try { target = new URL(value); }
  catch { throw new DOMException('OCS 登录目标不是有效的绝对 URL；未填表或提交。', 'SecurityError'); }
  const expected = new URL(canonical);
  if (value !== canonical || target.href !== expected.href || target.origin !== expected.origin || target.protocol !== 'https:' || target.username !== '' || target.password !== '') {
    throw new DOMException('OCS 登录目标与固定上游 HTTPS 登录地址不一致；拒绝重定向、其他来源、端口、路径或参数。请本人打开对应固定登录页。', 'SecurityError');
  }
}

function requiredValue(values: readonly OcsAutomationValue[], key: 'phone' | 'username' | 'password'): string {
  const matches = values.filter(entry => entry.key === key);
  const parsed = credentialSchema.safeParse(matches[0]?.value);
  if (matches.length !== 1 || !parsed.success) throw new TypeError(`OCS 登录需要且只能提供一次非空 ${key} 字段（最多 2000 字符）；本次未操作页面。`);
  return parsed.data;
}

/**
 * Execute only after fresh per-command consent; never call this from browser startup.
 * Sources: fixed Desktop 2.12.0 wk/icve.ts and existing fixed-ID cx.ts adapter.
 * Unknown redirects/frames/layouts fail closed. No OCR, password retry or success inference.
 * The caller owns page selection and serialization. A pending result is not authentication.
 */
export async function runOcsLogin(page: Page, automation: OcsLoginAutomation, confirmation: OcsAutomationConfirmation): Promise<OcsLoginResult> {
  if (!confirmationSchema.safeParse(confirmation).success) throw new TypeError('OCS 登录执行需要本次命令明确 confirmed:true；保存配置和启动均不构成授权。');
  const parsed = automationSchema.safeParse(automation);
  if (!parsed.success) throw new TypeError('OCS 登录配置必须包含有效 name 与最多 30 项 key/value 字符串；本次未操作页面。');
  const { name, values } = parsed.data;
  if (!isSupportedOcsLogin(name)) {
    if (!Object.hasOwn(OCS_UNSUPPORTED_LOGINS, name)) throw new RangeError('未知或非登录 OCS 自动化名称；本次未导航、填表或提交。');
    const reason = OCS_UNSUPPORTED_LOGINS[name as keyof typeof OCS_UNSUPPORTED_LOGINS];
    return { name, status: 'unsupported', submitAttempts: 0, reason, loginVerified: false, requiresManualVerification: true };
  }
  const account = requiredValue(values, name === OCS_PHONE_AUTOMATION ? 'phone' : 'username');
  const password = requiredValue(values, 'password');
  if (page.isClosed()) throw new DOMException('所选 OCS 页面已关闭；本次未导航、填表或提交。', 'InvalidStateError');
  const canonical = name === OCS_PHONE_AUTOMATION ? OCS_PHONE_LOGIN_URL : OCS_ICVE_LOGIN_URL;
  // Only a fresh blank page may be navigated. Never take over an unrelated existing page.
  if (page.url() !== 'about:blank') assertOcsLoginTarget(name, page.url());
  try {
    if (page.url() === 'about:blank') {
      const response = await page.goto(canonical, { waitUntil: 'domcontentloaded', timeout: 15000 });
      if (!response || !response.ok()) throw new DOMException(`OCS 固定登录页面加载失败，HTTP 状态 ${response?.status() ?? '无响应'}；未填表或提交。`, 'NetworkError');
    }
    assertOcsLoginTarget(name, page.url());
    await page.mainFrame().waitForSelector(name === OCS_PHONE_AUTOMATION ? '#phone' : '[placeholder="请输入账号"]', { state: 'visible', timeout: 10000 });
    assertOcsLoginTarget(name, page.mainFrame().url());
    if (name === OCS_PHONE_AUTOMATION) {
      const result = await runOcsAutomation(page, name, values, confirmation);
      if (result.submitAttempts === 1) return {
        name, status: 'submitted-pending-user', submitAttempts: 1, reason: result.reason === 'captcha' ? 'captcha' : 'platform-result-unverified',
        message: result.reason === 'captcha' ? '已尝试一次提交，平台要求验证码；请本人在浏览器完成并核对，不会自动重试。' : '已派发一次登录点击；平台身份未验证，请本人核对，不会自动重试。',
        loginVerified: false, requiresManualVerification: true
      };
      return { name, status: 'awaiting-user', submitAttempts: 0, reason: result.reason === 'captcha' ? 'captcha' : 'unrecognized-page', message: '未提交；验证码或页面结构需要本人在浏览器处理。', loginVerified: false, requiresManualVerification: true };
    }
    const result = await submitIcveOnce(page, account, password);
    return ocsLoginResultSchema.parse(result);
  } catch (cause) {
    // Reuse the existing causal redactor; its identity slot also covers ICVE usernames.
    throw new Error('OCS 单次登录操作失败；不会自动重试。提交状态可能未知，请本人检查浏览器；原始原因已脱敏保留。', {
      cause: redactOcsAutomationCause(cause, { phone: account, password }, new Set<Error>())
    });
  }
}

async function submitIcveOnce(page: Page, username: string, password: string): Promise<OcsLoginResult> {
  assertOcsLoginTarget(OCS_ICVE_LOGIN, page.mainFrame().url());
  return page.mainFrame().evaluate(submitIcveFormOnce, {
    suppliedUsername: username, suppliedPassword: password, canonical: OCS_ICVE_LOGIN_URL, name: OCS_ICVE_LOGIN
  });
}
