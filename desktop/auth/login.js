'use strict';

const form = document.getElementById('login-form');
const username = document.getElementById('username');
const password = document.getElementById('password');
const captcha = document.getElementById('captcha');
const image = document.getElementById('captcha-image');
const status = document.getElementById('status');
const refresh = document.getElementById('refresh');
const submit = document.getElementById('submit');
const remember = document.getElementById('remember-login');
const useSaved = document.getElementById('use-saved');
const savedOption = document.getElementById('saved-option');
let rememberedUsername = null;

function updatePasswordInput(ready) {
  const saved = useSaved.checked && username.value === rememberedUsername;
  password.disabled = !ready || saved;
  password.required = !saved;
  password.placeholder = saved ? '已加密保存，无需再次输入' : '';
}

function showView(view) {
  status.textContent = view.message;
  const ready = view.stage === 'ready';
  for (const control of [username, captcha, refresh, submit, remember, useSaved]) control.disabled = !ready;
  if (typeof view.rememberedUsername === 'string' && rememberedUsername === null) {
    rememberedUsername = view.rememberedUsername;
    username.value = rememberedUsername;
    savedOption.hidden = false;
    useSaved.checked = true;
    remember.checked = true;
  }
  updatePasswordInput(ready);
  if (view.captcha) {
    image.src = view.captcha;
    image.hidden = false;
  }
  if (ready && typeof view.captchaCode === 'string') captcha.value = view.captchaCode;
  if (ready) { if (useSaved.checked) captcha.focus(); else username.focus(); }
}

window.schoolLogin.onView(showView);
window.schoolLogin.initialize().then(showView).catch(() => {
  status.textContent = '无法初始化登录窗口，请关闭后重新登录。';
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!form.reportValidity()) return;
  const saved = useSaved.checked && username.value === rememberedUsername;
  const credentials = { username: username.value, password: saved ? '' : password.value, captcha: captcha.value, remember: remember.checked, useSaved: saved };
  password.value = '';
  showView({ stage: 'submitting', message: '正在向学校提交认证…', captcha: '' });
  try {
    const result = await window.schoolLogin.submit(credentials);
    if (!result.ok) showView({ stage: 'ready', message: result.message, captcha: '' });
  } catch {
    status.textContent = '登录已结束，请返回主界面查看结果。';
  } finally {
    credentials.password = '';
    credentials.username = '';
    credentials.captcha = '';
  }
});

refresh.addEventListener('click', async () => {
  captcha.value = '';
  showView({ stage: 'preparing', message: '正在更新验证码…', captcha: '' });
  try { await window.schoolLogin.refreshCaptcha(); }
  catch { status.textContent = '获取验证码失败，请从主界面重新登录。'; }
});

document.getElementById('cancel').addEventListener('click', () => window.schoolLogin.cancel());
useSaved.addEventListener('change', () => updatePasswordInput(!submit.disabled));
username.addEventListener('input', () => { if (username.value !== rememberedUsername) useSaved.checked = false; updatePasswordInput(!submit.disabled); });
