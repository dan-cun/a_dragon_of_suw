import type { Page } from 'playwright-core';
import { z } from 'zod';

const geometrySchema = z.object({
  startX: z.number().finite().nonnegative(), startY: z.number().finite().nonnegative(),
  endX: z.number().finite().positive(), verified: z.boolean()
}).strict();

/**
 * Run the existing OCS mouse-drag sequence once for the official legacy login slider.
 * Reviewed legacy main SHA-256 8c9e6cb80c6cc1eaf21851a9ca48475dcf01648903e8e9a7729ceb0c9872d1a6,
 * hkCheckInit 7518369..7519247 and verifySuccess 7519274..7519533.
 * The official handler compares mouse clientX displacement with offsetWidth differences.
 * Only visible widget state is inspected; no credentials, storage or challenge API is read.
 */
export async function verifyTsinghuaLoginSlider(page: Page, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const url = new URL(page.url());
  if (url.origin !== 'https://www.tsinghuaelt.com' || url.pathname !== '/legacy/login') throw new DOMException('自动滑块仅允许当前受控的清华社 HTTPS 旧版登录页；未操作其他页面。', 'SecurityError');
  const button = page.locator('#sliderBtn');
  if (await button.count() !== 1) throw new RangeError('清华社登录滑块 #sliderBtn 必须唯一；未猜测或尝试其他控件。');
  const handle = await button.elementHandle();
  if (handle === null) throw new DOMException('清华社登录滑块已消失；本次未拖动。', 'InvalidStateError');
  try {
    const geometry = geometrySchema.parse(await handle.evaluate(element => {
      if (location.origin !== 'https://www.tsinghuaelt.com' || location.pathname !== '/legacy/login' || !(element instanceof HTMLElement) || !element.isConnected || document.getElementById('sliderBtn') !== element) throw new DOMException('清华社登录文档或滑块身份已变化。', 'AbortError');
      const tracks = document.querySelectorAll('.slider-bg');
      const tips = document.querySelectorAll('#sliderTip');
      const track = element.closest('.slider-bg');
      const tip = tips[0];
      if (tracks.length !== 1 || !(track instanceof HTMLElement) || tracks[0] !== track || tips.length !== 1 || !(tip instanceof HTMLElement) || !track.contains(tip) || track.querySelectorAll('.slider-track').length !== 1) throw new RangeError('清华社滑块轨道或状态结构不符合已核实的官网模板；未拖动。');
      for (const node of [element, track, tip]) {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        if (rect.width <= 0 || rect.height <= 0 || style.display === 'none' || style.visibility === 'hidden') throw new DOMException('清华社登录滑块与轨道必须实际可见；未拖动。', 'InvalidStateError');
      }
      const rect = element.getBoundingClientRect();
      const startX = rect.x + rect.width / 2;
      const startY = rect.y + rect.height / 2;
      const distance = track.offsetWidth - element.offsetWidth;
      const endX = startX + distance;
      const verified = tip.textContent?.trim() === '验证通过' && element.textContent?.trim() === '✓' && element.style.cursor === 'default';
      if (!verified && (distance <= 0 || startX < 0 || startY < 0 || endX >= innerWidth || startY >= innerHeight || Math.abs(rect.left - track.getBoundingClientRect().left) > 5)) throw new RangeError('清华社滑块位置或可拖距离无效，请本人检查窗口与当前挑战；未拖动。');
      return { startX, startY, endX, verified };
    }));
    signal.throwIfAborted();
    if (geometry.verified) return;
    await page.mouse.move(geometry.startX, geometry.startY);
    signal.throwIfAborted();
    await handle.evaluate(element => {
      if (location.origin !== 'https://www.tsinghuaelt.com' || location.pathname !== '/legacy/login' || !element.isConnected || document.getElementById('sliderBtn') !== element) throw new DOMException('清华社滑块在按下前已被替换，未开始拖动。', 'AbortError');
    });
    signal.throwIfAborted();
    let movementError: Error | null = null;
    try {
      await page.mouse.down();
      signal.throwIfAborted();
      await page.mouse.move(geometry.endX, geometry.startY, { steps: 10 });
      signal.throwIfAborted();
    } catch (cause) {
      movementError = cause instanceof Error ? cause : new TypeError('清华社单次滑块拖动发生非标准错误。');
    }
    try { await page.mouse.up(); }
    catch (cause) {
      const releaseError = cause instanceof Error ? cause : new TypeError('清华社滑块鼠标释放发生非标准错误。');
      if (movementError !== null) throw new AggregateError([movementError, releaseError], '清华社滑块拖动及鼠标释放均失败；未重试。');
      throw releaseError;
    }
    if (movementError !== null) throw movementError;
    signal.throwIfAborted();
    const verified = await handle.evaluate(element => {
      const tip = document.getElementById('sliderTip');
      return location.origin === 'https://www.tsinghuaelt.com' && location.pathname === '/legacy/login' && element.isConnected && document.getElementById('sliderBtn') === element && element instanceof HTMLElement && tip?.textContent?.trim() === '验证通过' && element.textContent?.trim() === '✓' && element.style.cursor === 'default';
    });
    signal.throwIfAborted();
    if (!verified) throw new DOMException('已拖动一次，但官网未显示本次滑块验证通过；未点击登录、刷新挑战或自动重试，请本人检查当前页面。', 'OperationError');
  } finally { await handle.dispose(); }
}

/** Click the reviewed official login control once using the page's existing form values. */
export async function submitTsinghuaLogin(page: Page, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const url = new URL(page.url());
  if (url.origin !== 'https://www.tsinghuaelt.com' || url.pathname !== '/legacy/login') throw new DOMException('单次登录仅允许当前清华社 HTTPS 旧版登录页；未操作其他页面。', 'SecurityError');
  const control = page.locator('.login-btn:visible');
  if (await control.count() !== 1) throw new RangeError('官网登录控件 .login-btn 必须可见且唯一；未猜测或点击其他控件。');
  signal.throwIfAborted();
  await control.evaluate(element => {
    if (location.origin !== 'https://www.tsinghuaelt.com' || location.pathname !== '/legacy/login' || Reflect.get(globalThis, '__SWU_TSH_BACKEND_CANCELLED__') === true) throw new DOMException('登录前官网文档已变化或任务已停止，未点击登录。', 'AbortError');
    const tip = document.querySelectorAll('#sliderTip');
    const sliders = document.querySelectorAll('#sliderBtn');
    const slider = sliders[0];
    if (tip.length !== 1 || tip[0]?.textContent?.trim() !== '验证通过' || sliders.length !== 1 || !(slider instanceof HTMLElement) || slider.textContent?.trim() !== '✓' || slider.style.cursor !== 'default') throw new DOMException('官网未显示当前滑块验证通过；未点击登录。', 'InvalidStateError');
    if (!(element instanceof HTMLElement) || !element.isConnected || element.getAttribute('aria-disabled') === 'true' || element.hasAttribute('disabled') || document.querySelectorAll('.login-btn').length !== 1) throw new DOMException('官网登录控件不可用或已被替换；未点击登录。', 'InvalidStateError');
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (rect.width <= 0 || rect.height <= 0 || style.display === 'none' || style.visibility === 'hidden') throw new DOMException('官网登录控件不再可见；未点击登录。', 'InvalidStateError');
    element.click();
  }, undefined, { timeout: 5000 });
  signal.throwIfAborted();
}
