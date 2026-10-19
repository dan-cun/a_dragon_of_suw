import type { Page } from 'playwright-core';
import {
  OCS_PHONE_AUTOMATION, OCS_PHONE_LOGIN_URL, assertOcsAutomationTarget,
  ocsAutomationResultSchema, parseOcsAutomationValues, redactOcsAutomationCause,
  type OcsAutomationConfirmation, type OcsAutomationResult, type OcsAutomationValue
} from '../ocs/automation-policy';

export type { OcsAutomationConfirmation, OcsAutomationResult, OcsAutomationValue } from '../ocs/automation-policy';

/**
 * Port the fixed-ID phone/password action from OCS Desktop 2.12.0 wk/cx.ts.
 * The canonical path is also listed in OCSJS 5.2.1 projects/background.ts.
 * This adapter never navigates, reads storage, solves challenges, retries a password,
 * or interprets a dispatched click as authenticated identity or course completion.
 * The caller owns serialization, browser selection and fresh per-operation consent.
 */
export async function runOcsAutomation(page: Page, name: string, values: readonly OcsAutomationValue[], confirmation: OcsAutomationConfirmation): Promise<OcsAutomationResult> {
  const credentials = parseOcsAutomationValues(name, values, confirmation);
  if (page.isClosed()) throw new DOMException('所选 OCS 页面已关闭；本次未填表或提交。', 'InvalidStateError');
  assertOcsAutomationTarget(page.url());
  try {
    // One synchronous document task prevents locator retargeting across a navigation.
    const result = await page.evaluate(({ credentials: supplied, canonical, automation }): OcsAutomationResult => {
      const doc = document;
      const targetMatches = (): boolean => doc === document && doc.location.href === canonical;
      const manual = (reason: 'captcha' | 'unrecognized-page', submitAttempts: 0 | 1): OcsAutomationResult => ({
        name: automation, stage: 'awaiting-verification', submitAttempts, reason,
        loginVerified: false, requiresManualVerification: true
      });
      const visible = (node: Element): boolean => {
        const box = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse' && style.opacity !== '0';
      };
      const captchaVisible = (): boolean => ['#numVerCode', '#vercode', '#captcha'].some(selector => {
        const root = doc.querySelector(selector);
        return root !== null && (visible(root) || Array.from(root.querySelectorAll('*')).some(visible));
      });
      if (!targetMatches()) throw new DOMException('固定登录页在执行前已变化；未填表或提交。', 'SecurityError');
      if (captchaVisible()) return manual('captcha', 0);
      if (['#phone', '#pwd', '#loginBtn'].some(selector => doc.querySelectorAll(selector).length !== 1)) return manual('unrecognized-page', 0);
      const phone = doc.getElementById('phone');
      const password = doc.getElementById('pwd');
      const button = doc.getElementById('loginBtn');
      if (!(phone instanceof HTMLInputElement) || phone.type !== 'text' || !(password instanceof HTMLInputElement) || password.type !== 'password'
        || !(button instanceof HTMLButtonElement) || button.type !== 'button' || button.getAttribute('onclick') !== 'loginByPhoneAndPwd();') return manual('unrecognized-page', 0);
      if ([phone, password, button].some(node => !visible(node) || node.disabled) || phone.readOnly || password.readOnly) return manual('unrecognized-page', 0);
      for (const input of [phone, password]) {
        if (input.form && input.form.action !== canonical) throw new DOMException('登录表单目标已变化；未填表或提交。', 'SecurityError');
      }
      const buttonBox = button.getBoundingClientRect();
      const hit = doc.elementFromPoint(buttonBox.x + buttonBox.width / 2, buttonBox.y + buttonBox.height / 2);
      if (hit === null || (hit !== button && !button.contains(hit))) return manual('unrecognized-page', 0);
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (!setter) throw new TypeError('浏览器缺少原生输入控件 value setter；未填表或提交。');
      const fill = (input: HTMLInputElement, value: string): void => {
        if (!targetMatches() || !input.isConnected || input.ownerDocument !== doc) throw new DOMException('输入过程中登录文档已变化；禁止继续提交，请人工核对。', 'SecurityError');
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      };
      fill(phone, supplied.phone);
      fill(password, supplied.password);
      if (!targetMatches() || !button.isConnected || doc.getElementById('phone') !== phone || doc.getElementById('pwd') !== password || doc.getElementById('loginBtn') !== button) {
        throw new DOMException('填表后登录文档已变化；未点击提交，请人工核对。', 'SecurityError');
      }
      if (captchaVisible()) return manual('captcha', 0);
      // Exactly one dispatch: platform handlers may show a challenge, but are never retried here.
      button.click();
      if (targetMatches() && captchaVisible()) return manual('captcha', 1);
      return { name: automation, stage: 'submitted', submitAttempts: 1, reason: 'platform-result-unverified', loginVerified: false, requiresManualVerification: true };
    }, { credentials, canonical: OCS_PHONE_LOGIN_URL, automation: OCS_PHONE_AUTOMATION as typeof OCS_PHONE_AUTOMATION });
    return ocsAutomationResultSchema.parse(result);
  } catch (cause) {
    throw new Error('OCS 超星登录执行失败；页面操作可能已开始，提交状态未确认。不得自动重试密码，请本人检查浏览器；原始错误已脱敏保留。', {
      cause: redactOcsAutomationCause(cause, credentials, new Set<Error>())
    });
  }
}
