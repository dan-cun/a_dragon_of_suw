import type { Page } from 'playwright-core';
import { z } from 'zod';
import { tsinghuaQuestionKindSchema, tsinghuaQuestionSchema, type TsinghuaQuestion, type TsinghuaResult } from '../shared/ocs-tsinghua';
import type { TsinghuaAnswerPlan } from '../ocs/tsinghua-answers';

const origin = 'https://www.tsinghuaelt.com';
const courseScoreSchema = z.object({ object: z.object({
  courseScoreVo: z.object({ score: z.number().finite() }),
  stuScoreVo: z.object({ complete: z.number().min(0).max(100) })
}) });
const inspectionSchema = z.object({ questionKey: z.string().uuid(), kind: tsinghuaQuestionKindSchema, text: z.string().max(16000), referenceText: z.string().max(16000), answered: z.boolean().nullable() });
const ordinaryResultSchema = z.object({ outcome: z.enum(['submitted', 'already-answered']), kind: tsinghuaQuestionKindSchema });

export interface LegacyHooks {
  adapterVersion: string;
  inspect(): { questionKey: string; kind: string; text: string; referenceText: string; answered: boolean | null };
  runOrdinary(plan: TsinghuaAnswerPlan): Promise<{ outcome: string; kind: string }>;
  stop(): Promise<void>;
  readScore(): Promise<{ scope: 'course'; requestedCourseId: string; questionKey: null; accepted: null; object: { courseScoreVo: { score: number }; stuScoreVo: { complete: number } } } | null>;
}

/** Accept only observed, credential-free official legacy detail routes. */
export function parseTsinghuaDetailUrl(value: string): { courseId: number; url: string } | null {
  if (!URL.canParse(value)) return null;
  const url = new URL(value);
  if (url.origin !== origin || url.username || url.password || url.search || url.hash) return null;
  const match = /^\/legacy\/course-student\/([1-9]\d*)\/study\/?$/.exec(url.pathname);
  if (!match) return null;
  const courseId = Number(match[1]);
  return Number.isSafeInteger(courseId) ? { courseId, url: url.href } : null;
}

/** Project only documented legacy aggregate fields; completion is never accuracy. */
export function parseTsinghuaCourseScore(value: object): TsinghuaResult {
  const parsed = courseScoreSchema.safeParse(value);
  if (!parsed.success) throw new TypeError('清华社综合成绩缺少有效 object.courseScoreVo.score 或 object.stuScoreVo.complete；未采用猜测字段。');
  return {
    observedAt: new Date().toISOString(), source: 'course-score', accepted: null, httpStatus: null,
    score: parsed.data.object.courseScoreVo.score, maximumScore: null, correctCount: null, totalCount: null,
    accuracyPercent: null, completionPercent: parsed.data.object.stuScoreVo.complete,
    message: '官网综合成绩；完成率不是正确率，综合成绩不是本题口语评分。'
  };
}

export function assertTsinghuaPage(page: Page): void {
  if (page.isClosed()) throw new DOMException('清华社受控页面已关闭。', 'InvalidStateError');
  const url = new URL(page.url());
  if (url.origin !== origin || !/^\/legacy(?:\/|$)/.test(url.pathname) || url.username || url.password) throw new DOMException('清华社操作仅允许当前受控页面的官方 HTTPS 旧版文档。', 'SecurityError');
}

export function exerciseCourseId(value: string): number | null {
  if (!URL.canParse(value)) return null;
  const url = new URL(value);
  if (url.origin !== origin) return null;
  const match = /^\/legacy\/course-study-student\/[1-9]\d*\/([1-9]\d*)\//.exec(url.pathname);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) ? id : null;
}

export async function inspectTsinghuaQuestion(page: Page): Promise<TsinghuaQuestion> {
  assertTsinghuaPage(page);
  const expectedPath = new URL(page.url()).pathname;
  const inspection = inspectionSchema.parse(await page.evaluate(expected => {
    if (location.origin !== 'https://www.tsinghuaelt.com' || location.pathname !== expected) throw new DOMException('清华社读取题目时文档已变化。', 'AbortError');
    const hooks = Reflect.get(globalThis, '__SWU_TSH_LEGACY__') as LegacyHooks | undefined;
    if (!hooks || hooks.adapterVersion !== 'swu-legacy-1' || typeof hooks.inspect !== 'function') throw new TypeError('清华社固定脚本适配接口尚未就绪，请检查脚本启用状态和版本。');
    return hooks.inspect();
  }, expectedPath));
  const details = await page.evaluate(expected => {
    const hooks = Reflect.get(globalThis, '__SWU_TSH_LEGACY__') as LegacyHooks | undefined;
    if (location.origin !== 'https://www.tsinghuaelt.com' || location.pathname !== expected.path || hooks?.inspect().questionKey !== expected.key) throw new DOMException('清华社读取媒体时练习视图已变化。', 'AbortError');
    const visible = (element: Element): boolean => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const roots = [...document.querySelectorAll('app-course-task-stu')].filter(visible);
    if (roots.length !== 1) throw new RangeError('清华社活动练习根必须可见且唯一。');
    const root = roots[0]!;
    const media = [...root.querySelectorAll('audio,video')].filter(element => {
      if (visible(element)) return true;
      const player = element instanceof HTMLAudioElement ? element.closest('lib-audio-player, .show-audio') : null;
      return player !== null && visible(player);
    }).map(element => {
      if (!(element instanceof HTMLMediaElement)) throw new TypeError('清华社媒体节点类型无效。');
      return { kind: element.tagName.toLowerCase(), phase: element.error ? 'failed' : element.ended ? 'ended' : element.readyState === 0 ? 'unloaded' : element.paused ? 'paused' : 'playing', currentTime: element.currentTime, duration: Number.isFinite(element.duration) && element.duration >= 0 ? element.duration : null, playbackRate: element.playbackRate, muted: element.muted, errorCode: element.error?.code ?? null };
    });
    return { title: document.title.slice(0, 500), media };
  }, { path: expectedPath, key: inspection.questionKey });
  const { questionKey, ...content } = inspection;
  return tsinghuaQuestionSchema.parse({ ...details, ...content, id: expectedPath + '#' + questionKey, page: null, totalPages: null });
}

export async function armTsinghuaPage(page: Page): Promise<void> {
  assertTsinghuaPage(page);
  await page.evaluate(() => { Reflect.set(globalThis, '__SWU_TSH_BACKEND_CANCELLED__', false); });
}

export async function runTsinghuaOrdinary(page: Page, expectedQuestionId: string, plan: TsinghuaAnswerPlan): Promise<z.infer<typeof ordinaryResultSchema>> {
  assertTsinghuaPage(page);
  if (!plan || !plan.exerciseId || !Array.isArray(plan.answers) || plan.answers.length === 0) throw new TypeError('清华社本题没有完整官方答案计划，禁止填入或提交。');
  return ordinaryResultSchema.parse(await page.evaluate(async expected => {
    const hooks = Reflect.get(globalThis, '__SWU_TSH_LEGACY__') as LegacyHooks | undefined;
    if (location.origin !== 'https://www.tsinghuaelt.com' || !hooks || location.pathname + '#' + hooks.inspect().questionKey !== expected.questionId || Reflect.get(globalThis, '__SWU_TSH_BACKEND_CANCELLED__') === true) throw new DOMException('清华社题目或运行身份变化，禁止开始作答。', 'AbortError');
    if (hooks.adapterVersion !== 'swu-legacy-1' || typeof hooks.runOrdinary !== 'function') throw new TypeError('清华社普通题适配接口不可用。');
    if (hooks.inspect().kind !== expected.plan.kind) throw new DOMException('清华社官方答案计划题型与当前练习不一致。', 'InvalidStateError');
    return await hooks.runOrdinary(expected.plan);
  }, { questionId: expectedQuestionId, plan }));
}

export async function stopTsinghuaHooks(page: Page): Promise<void> {
  if (page.isClosed()) return;
  if (new URL(page.url()).origin !== origin) return;
  await page.evaluate(async () => {
    Reflect.set(globalThis, '__SWU_TSH_BACKEND_CANCELLED__', true);
    const hooks = Reflect.get(globalThis, '__SWU_TSH_LEGACY__') as LegacyHooks | undefined;
    if (hooks === undefined) return;
    if (hooks.adapterVersion !== 'swu-legacy-1' || typeof hooks.stop !== 'function') throw new TypeError('清华社停止接口版本无效；不能确认脚本已结算。');
    await hooks.stop();
    for (const media of document.querySelectorAll('audio,video')) if (media instanceof HTMLMediaElement && !media.paused) media.pause();
  });
}

export async function readTsinghuaCourseScore(page: Page, courseId: number): Promise<TsinghuaResult> {
  assertTsinghuaPage(page);
  const value = await page.evaluate(async expectedCourseId => {
    const hooks = Reflect.get(globalThis, '__SWU_TSH_LEGACY__') as LegacyHooks | undefined;
    if (!hooks || hooks.adapterVersion !== 'swu-legacy-1' || typeof hooks.readScore !== 'function') throw new TypeError('清华社成绩接口不可用。');
    const raw = await hooks.readScore();
    if (!raw || raw.scope !== 'course' || raw.requestedCourseId !== String(expectedCourseId) || raw.questionKey !== null || raw.accepted !== null) throw new TypeError('官网综合成绩的课程 ID 或范围不匹配；未当作题级或口语评分。');
    if (typeof raw !== 'object' || !raw.object || typeof raw.object !== 'object' || !raw.object.courseScoreVo || !raw.object.stuScoreVo) throw new TypeError('官网成绩响应缺少必要对象，未传递原始响应。');
    const score = raw.object.courseScoreVo.score;
    const complete = raw.object.stuScoreVo.complete;
    if (typeof score !== 'number' || !Number.isFinite(score) || typeof complete !== 'number' || !Number.isFinite(complete)) throw new TypeError('官网成绩必要字段不是有限数字，未传递原始响应。');
    return { object: { courseScoreVo: { score }, stuScoreVo: { complete } } };
  }, courseId);
  if (value === null || typeof value !== 'object') throw new TypeError('官网未返回可验证的综合成绩；本次未将空结果当作成功。');
  return parseTsinghuaCourseScore(value);
}

export async function beginTsinghuaMedia(page: Page, expectedPath: string): Promise<void> {
  assertTsinghuaPage(page);
  await page.evaluate(async expected => {
    const hooks = Reflect.get(globalThis, '__SWU_TSH_LEGACY__') as LegacyHooks | undefined;
    if (location.origin !== 'https://www.tsinghuaelt.com' || !hooks || location.pathname + '#' + hooks.inspect().questionKey !== expected || Reflect.get(globalThis, '__SWU_TSH_BACKEND_CANCELLED__') === true) throw new DOMException('清华社播放目标已变化或运行已停止。', 'AbortError');
    const visible = (element: Element): boolean => { const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'; };
    const roots = [...document.querySelectorAll('app-course-task-stu')].filter(visible);
    if (roots.length !== 1) throw new RangeError('清华社播放要求唯一可见活动练习根。');
    const media = [...roots[0]!.querySelectorAll('audio,video')].filter(element => {
      if (visible(element)) return true;
      const player = element instanceof HTMLAudioElement ? element.closest('lib-audio-player, .show-audio') : null;
      return player !== null && visible(player);
    });
    if (media.length !== 1 || !(media[0] instanceof HTMLMediaElement)) throw new RangeError('清华社播放要求唯一可见原生媒体，未猜测播放器或跳过媒体。');
    const element = media[0];
    if (element.error) throw new DOMException('清华社媒体加载失败，请在官网检查原始媒体。', 'NotSupportedError');
    element.playbackRate = 1;
    element.defaultPlaybackRate = 1;
    element.muted = false;
    await element.play();
  }, expectedPath);
}
