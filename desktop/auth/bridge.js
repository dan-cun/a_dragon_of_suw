'use strict';

async function request(path, body) {
  const response = await fetch(path, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-SWU-Request': '1' }, body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error('本地认证请求失败。');
  const result = await response.json();
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

const source = new EventSource('/api/events');
window.schoolLogin = {
  initialize: () => request('/api/auth/view', {}),
  refreshCaptcha: () => request('/api/auth/refresh', {}),
  submit: async (credentials) => {
    await request('/api/auth/submit', credentials);
    return { ok: true };
  },
  cancel: () => request('/api/auth/cancel', {}),
  onView: (listener) => source.addEventListener('state', (event) => {
    const state = JSON.parse(event.data);
    if (state.authentication) listener(state.authentication);
  })
};
