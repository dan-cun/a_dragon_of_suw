import type { Page } from 'playwright-core';
import { z } from 'zod';
import { assertTsinghuaPage, parseTsinghuaDetailUrl, type LegacyHooks } from './ocs-tsinghua-page';

export const TSINGHUA_LEGACY_COURSES = 'https://www.tsinghuaelt.com/legacy/studentcourse';
export const TSINGHUA_COURSE_LIST_PATH = '/tsenglish/course/stuCourseList';
const courseListSchema = z.object({
  total: z.number().int().nonnegative(),
  items: z.array(z.object({
    id: z.number().int().positive().safe(), title: z.string().trim().min(1).max(500),
    textbookType: z.number().int(), statusActive: z.number().int(), statuExamine: z.number().int(), timeOut: z.number().int()
  })).max(100)
});
export interface TsinghuaCourseLink { id: number; title: string; url: string }
export interface TsinghuaCourseList { total: number; courses: TsinghuaCourseLink[] }

/** Mirror the public legacy stuCourseList subscription and turn(item, 'study') permission checks. */
export function parseTsinghuaCourseList(value: object): TsinghuaCourseList {
  const parsed = courseListSchema.safeParse(value);
  if (!parsed.success) throw new TypeError('官网 stuCourseList 响应缺少有效 total 或 items 的课程 ID、标题和权限字段；未按卡片下标或文字猜测课程。');
  const { items, total } = parsed.data;
  if (total < items.length || new Set(items.map(item => item.id)).size !== items.length) throw new RangeError('官网课程列表总数或课程 ID 唯一性无效。');
  return {
    total,
    courses: items.filter(item => item.textbookType !== 2 && item.statusActive !== 2 && item.statuExamine !== 2 && item.timeOut !== 2).map(item => ({
      id: item.id, title: item.title, url: 'https://www.tsinghuaelt.com/legacy/course-student/' + item.id + '/study'
    }))
  };
}

/** Inspect only login control presence; course identities come from the official response, not DOM order. */
export async function tsinghuaLoginVisible(page: Page): Promise<boolean> {
  assertTsinghuaPage(page);
  return await page.evaluate(() => {
    if (location.pathname === '/legacy/login') return true;
    return [...document.querySelectorAll('#account,input[type="password"]')].some(element => {
      const rectangle = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rectangle.width > 0 && rectangle.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    });
  });
}

export async function enterTsinghuaExercise(page: Page): Promise<void> {
  assertTsinghuaPage(page);
  if (!parseTsinghuaDetailUrl(page.url())) throw new DOMException('仅允许从已观察并验证的课程详情进入练习。', 'SecurityError');
  const expectedPath = new URL(page.url()).pathname;
  const control = page.locator('.topBtn button:visible');
  if (await control.count() !== 1) throw new RangeError('清华社课程继续学习控件 .topBtn button 必须可见且唯一；未使用文字或其他按钮回退。');
  await control.evaluate((element, expected) => {
    if (location.origin !== 'https://www.tsinghuaelt.com' || location.pathname !== expected || Reflect.get(globalThis, '__SWU_TSH_BACKEND_CANCELLED__') === true) throw new DOMException('进入练习前文档变化或运行已取消。', 'AbortError');
    if (!(element instanceof HTMLButtonElement) || element.disabled || element.classList.contains('dis-continue-btn')) throw new TypeError('官网继续学习控件不可用或课程权限不足。');
    element.click();
  }, expectedPath, { timeout: 5000 });
}

export async function nextTsinghuaExercise(page: Page, expectedPath: string): Promise<boolean> {
  assertTsinghuaPage(page);
  const controls = page.locator('.page-next img[src*="tx_page_right"]:visible, img.page-next[src*="tx_page_right"]:visible');
  const count = await controls.count();
  if (count === 0) return false;
  if (count !== 1) throw new RangeError('清华社下一页右箭头不唯一；未选择最后一个按钮。');
  await controls.evaluate((element, expected) => {
    const hooks = Reflect.get(globalThis, '__SWU_TSH_LEGACY__') as LegacyHooks | undefined;
    if (location.origin !== 'https://www.tsinghuaelt.com' || !hooks || location.pathname + '#' + hooks.inspect().questionKey !== expected || Reflect.get(globalThis, '__SWU_TSH_BACKEND_CANCELLED__') === true) throw new DOMException('翻页前练习视图变化或运行已取消。', 'AbortError');
    if (!(element instanceof HTMLElement) || element.getAttribute('aria-disabled') === 'true') throw new TypeError('官网下一页控件不可用。');
    element.click();
  }, expectedPath, { timeout: 5000 });
  return true;
}
