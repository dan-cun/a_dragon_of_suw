import type { OcsLoginResult } from '../shared/ocs-login';

/** Execute one ICVE submission only after validating the document and effective native submitter policy. */
export function submitIcveFormOnce({ suppliedUsername, suppliedPassword, canonical, name }: {
  readonly suppliedUsername: string;
  readonly suppliedPassword: string;
  readonly canonical: string;
  readonly name: string;
}): OcsLoginResult {
  const doc = document;
  const assertDocument = (): void => {
    if (window !== window.top || doc !== document || doc.location.href !== canonical || doc.location.origin !== new URL(canonical).origin || doc.location.protocol !== new URL(canonical).protocol) {
      throw new DOMException('智慧职教实际登录 frame 来源或路径已变化；禁止继续填表和提交。', 'SecurityError');
    }
  };
  const manual = (reason: 'unrecognized-page' | 'agreement-required', message: string): OcsLoginResult => ({
    name, status: 'awaiting-user', submitAttempts: 0, reason, message, loginVerified: false, requiresManualVerification: true
  });
  const visible = (node: Element): boolean => {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility === 'visible' && style.opacity !== '0';
  };
  const accountSelector = '[placeholder="请输入账号"]';
  const passwordSelector = '[placeholder="请输入密码"]';
  const agreementSelector = '.agreement label.el-checkbox';
  const submitSelector = 'form .login';
  assertDocument();
  for (const selector of [accountSelector, passwordSelector, agreementSelector, submitSelector]) {
    if (doc.querySelectorAll(selector).length !== 1) return manual('unrecognized-page', '智慧职教上游表单定位缺失或不唯一；未填表或提交，请本人核对页面。');
  }
  const account = doc.querySelector(accountSelector);
  const secret = doc.querySelector(passwordSelector);
  const agreement = doc.querySelector(agreementSelector);
  const submit = doc.querySelector(submitSelector);
  const isNativeSubmitter = (node: Element): node is HTMLButtonElement | HTMLInputElement =>
    node instanceof HTMLButtonElement && node.type === 'submit' || node instanceof HTMLInputElement && node.type === 'submit';
  if (!(account instanceof HTMLInputElement) || !['text', 'tel', 'email'].includes(account.type)
    || !(secret instanceof HTMLInputElement) || secret.type !== 'password'
    || !submit || !isNativeSubmitter(submit) || !(agreement instanceof HTMLLabelElement)) {
    return manual('unrecognized-page', '智慧职教表单控件类型与上游预期不符；未填表或提交。');
  }
  const form = submit.form;
  if (!form || account.form !== form || secret.form !== form || submit.closest('form') !== form) {
    return manual('unrecognized-page', '智慧职教账号、密码与原生提交控件不属于同一个表单；未填表或提交。');
  }
  const assertEffectiveTarget = (): void => {
    assertDocument();
    if (!submit.isConnected || submit.form !== form || account.form !== form || secret.form !== form || submit.closest('form') !== form) {
      throw new DOMException('智慧职教提交控件或表单关系已变化；拒绝填表或提交。', 'SecurityError');
    }
    const targets = [form.action, submit.formAction];
    for (const value of targets) {
      let target: URL;
      try { target = new URL(value, doc.location.href); }
      catch { throw new DOMException('智慧职教有效提交目标无效；拒绝填表或提交。', 'SecurityError'); }
      if (target.protocol !== new URL(canonical).protocol || target.origin !== doc.location.origin || target.username !== '' || target.password !== '') {
        throw new DOMException('智慧职教表单或提交控件覆盖到非可信 HTTPS 来源；拒绝填表或提交。', 'SecurityError');
      }
    }
    const formMethod = form.getAttribute('method') ?? 'get';
    const submitMethod = submit.getAttribute('formmethod');
    const effectiveMethod = (submitMethod ?? formMethod).trim().toLowerCase();
    if (form.method.toLowerCase() !== 'post' || submit.formMethod && submit.formMethod.toLowerCase() !== 'post'
      || effectiveMethod !== 'post' || submit.hasAttribute('formmethod') && submit.formMethod.toLowerCase() !== 'post') {
      throw new DOMException('智慧职教表单或提交控件的有效方法不是 POST；拒绝填表或提交以避免凭据进入 GET URL。', 'SecurityError');
    }
  };
  assertEffectiveTarget();
  const checkboxes = agreement.querySelectorAll('input[type="checkbox"]');
  const checkbox = checkboxes[0];
  if (checkboxes.length !== 1 || !(checkbox instanceof HTMLInputElement)) return manual('unrecognized-page', '智慧职教协议控件结构无法核验；未填表或提交。');
  if (!checkbox.checked) return manual('agreement-required', '请本人先在智慧职教页面阅读并勾选协议，再单独确认执行；本程序不代替本人同意协议，未填表或提交。');
  if ([account, secret, submit, agreement].some(node => !visible(node)) || account.disabled || secret.disabled || account.readOnly || secret.readOnly
    || submit.disabled || submit.getAttribute('aria-disabled') === 'true') return manual('unrecognized-page', '智慧职教表单不可操作或被隐藏；未填表或提交。');
  const rect = submit.getBoundingClientRect();
  const hit = doc.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
  if (!hit || !submit.contains(hit)) return manual('unrecognized-page', '智慧职教提交控件被遮挡，可能需要验证码或人工操作；未填表或提交。');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter) throw new TypeError('浏览器缺少原生输入控件 setter；未填表或提交。');
  const fill = (input: HTMLInputElement, value: string): void => {
    assertEffectiveTarget();
    if (!input.isConnected || input.ownerDocument !== doc) throw new DOMException('智慧职教输入文档已变化；禁止继续。', 'SecurityError');
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  fill(account, suppliedUsername);
  fill(secret, suppliedPassword);
  assertEffectiveTarget();
  if (doc.querySelector(accountSelector) !== account || doc.querySelector(passwordSelector) !== secret || doc.querySelector(submitSelector) !== submit
    || !checkbox.checked || !visible(submit) || submit.disabled) {
    throw new DOMException('智慧职教填表后控件或协议已变化；未点击提交，请人工核对。', 'SecurityError');
  }
  // Exactly one click; no agreement toggle, challenge solving or password retry.
  submit.click();
  return {
    name, status: 'submitted-pending-user', submitAttempts: 1, reason: 'platform-result-unverified',
    message: '已派发一次智慧职教登录点击；上游没有可靠的身份成功信号，验证码、MFA 或平台拒绝均须本人在浏览器核对，不会自动重试。',
    loginVerified: false, requiresManualVerification: true
  };
}
