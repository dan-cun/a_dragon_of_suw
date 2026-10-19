import { dirname, join } from 'node:path';
import { createAuthentication } from './auth';
import type { BrowserCookie } from './auth-http';
import { createCaptchaRecognizer } from './captcha-ocr';
import type { LoginMemory } from './login-memory';

export async function authenticateAcademicSession(directory: string, edge: string, memory: LoginMemory): Promise<BrowserCookie[]> {
  const executable = process.env['SWU_CAPTCHA_OCR'] ?? join(dirname(process.execPath), 'engine', 'captcha-ocr.exe');
  const authentication = createAuthentication(edge, join(directory, 'auth-sessions'), memory.cookies,
    (image, signal) => createCaptchaRecognizer(executable).recognize(image, signal),
    entry => console[entry.level === 'info' ? 'info' : entry.level === 'warning' ? 'warn' : 'error'](JSON.stringify({
      event: `academic.${entry.event}`, message: entry.message.replaceAll(memory.username, '[账号]').replaceAll(memory.password, '[密码]'),
    })), () => {});
  try {
    await authentication.start();
    const view = authentication.getView();
    if (view.stage === 'ready') {
      if (!/^\d{4}$/.test(view.captchaCode)) throw new Error('教务自动登录停止：内置 OCR 未识别出有效的 4 位验证码。请在学校窗口完成登录后重新检测，或断开后重新连接。');
      await authentication.submit({ username: memory.username, password: memory.password, captcha: view.captchaCode });
    }
    await authentication.wait();
    return authentication.getCookies();
  } finally {
    await authentication.cancel();
  }
}
