import type { Page } from 'playwright-core';
import { z } from 'zod';
import { tsinghuaRecordResultProjectionSchema, tsinghuaSubmitResultProjectionSchema, type TsinghuaResultContext } from '../ocs/tsinghua-result';
import { assertTsinghuaPage, type LegacyHooks } from './ocs-tsinghua-page';
import { parseTsinghuaAnswerPlan, type TsinghuaAnswerPlan } from '../ocs/tsinghua-answers';
import { resolveTsinghuaCatalogPage, type TsinghuaCatalogNode } from '../ocs/tsinghua-catalog';

const identifier = z.string().min(1).max(200);
const exerciseSchema = tsinghuaRecordResultProjectionSchema.shape.object.shape.exercise;
const contentSchema = z.object({ status: z.literal(true), object: z.object({ id: identifier, item: z.object({ object: exerciseSchema }) }) });
const viewSchema = z.object({ questionKey: z.string().uuid(), path: z.string(), courseId: z.number().int().positive().safe(), routeKey: identifier, interactionRevision: z.number().int().nonnegative().safe() });
export type TsinghuaResultView = z.infer<typeof viewSchema>;
export interface OfficialExerciseIdentity { path: string; courseId: number; pageId: string; exerciseId: string; exerciseType: number; maximumScore: number; ifDigi: boolean }
export interface TsinghuaRequestTarget { path: string; routeKey: string; courseId: number; pageId: string }
export type TsinghuaRecordProjection = z.infer<typeof tsinghuaRecordResultProjectionSchema> | { status: false };

/** Count trusted interactions conservatively, without listening to or collecting microphone audio. */
export function installTsinghuaResultTracker(): void {
  if (Reflect.get(globalThis, '__SWU_TSH_RESULT_TRACKER__') === true) return;
  Reflect.set(globalThis, '__SWU_TSH_RESULT_TRACKER__', true);
  Reflect.set(globalThis, '__SWU_TSH_RESULT_REVISION__', 0);
  const changed = (event: Event): void => {
    if (!event.isTrusted || !(event.target instanceof Element) || !/^\/legacy\/course-study-student\//.test(location.pathname)) return;
    const revision = Reflect.get(globalThis, '__SWU_TSH_RESULT_REVISION__') as number;
    Reflect.set(globalThis, '__SWU_TSH_RESULT_REVISION__', revision + 1);
  };
  document.addEventListener('click', changed, true);
  document.addEventListener('input', changed, true);
}

/** Read only official route identity and the adapter's local view identity, never an account token. */
export async function inspectTsinghuaResultView(page: Page): Promise<TsinghuaResultView | null> {
  assertTsinghuaPage(page);
  const value = await page.evaluate(() => {
    const route = /^\/legacy\/course-study-student\/[1-9]\d*\/([1-9]\d*)\/[^/]+\/([^/]+)\/?$/.exec(location.pathname);
    if (!route) return null;
    const hooks = Reflect.get(globalThis, '__SWU_TSH_LEGACY__') as LegacyHooks | undefined;
    if (!hooks || hooks.adapterVersion !== 'swu-legacy-1' || typeof hooks.inspect !== 'function') return null;
    const roots = [...document.querySelectorAll('app-course-task-stu')].filter(element => { const rectangle = element.getBoundingClientRect(); const style = getComputedStyle(element); return rectangle.width > 0 && rectangle.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'; });
    if (roots.length === 0) return null;
    if (roots.length !== 1) throw new RangeError('当前官方题目根不唯一，不能绑定评分身份。');
    return { questionKey: hooks.inspect().questionKey, path: location.pathname, courseId: Number(route[1]), routeKey: decodeURIComponent(route[2]!), interactionRevision: Reflect.get(globalThis, '__SWU_TSH_RESULT_REVISION__') as number };
  });
  return value === null ? null : viewSchema.parse(value);
}

/** pageId is the reviewed public API field; it is not inferred from the route's catalog key. */
export function tsinghuaRequestTarget(requestUrl: string, documentUrl: string): TsinghuaRequestTarget | null {
  const request = new URL(requestUrl);
  const document = new URL(documentUrl);
  if (request.origin !== 'https://www.tsinghuaelt.com' || document.origin !== request.origin) return null;
  const route = /^\/legacy\/course-study-student\/[1-9]\d*\/([1-9]\d*)\/[^/]+\/([^/]+)\/?$/.exec(document.pathname);
  if (!route) return null;
  const pageId = identifier.safeParse(request.searchParams.get('pageId'));
  const courseId = Number(route[1]);
  if (!pageId.success || !Number.isSafeInteger(courseId)) throw new TypeError('官方练习请求缺少可验证 pageId 或课程路由 ID。');
  const requestedCourse = request.searchParams.get('courseId');
  if (requestedCourse !== null && requestedCourse !== String(courseId)) throw new DOMException('官方练习请求课程与当前文档不一致。', 'SecurityError');
  return { path: document.pathname, routeKey: decodeURIComponent(route[2]!), courseId, pageId: pageId.data };
}

/** Bind the unique natural route node's pageId to both request and response; detail.key is unrelated. */
export function parseTsinghuaContentIdentity(value: object, target: TsinghuaRequestTarget, catalog: readonly TsinghuaCatalogNode[]): OfficialExerciseIdentity {
  const catalogPageId = resolveTsinghuaCatalogPage(catalog, target.routeKey);
  const parsed = contentSchema.safeParse(value);
  if (!parsed.success) throw new TypeError('官方 content_detail 缺少 status、页面身份或真实 exercise.id/type/score/ifDigi；未使用路由替代练习 ID。');
  const detail = parsed.data.object;
  const requestPageIdMatches = catalogPageId === target.pageId;
  const responsePageIdMatches = catalogPageId === detail.id;
  if (!requestPageIdMatches || !responsePageIdMatches) throw new DOMException('TSH_CONTENT_IDENTITY_MISMATCH: catalogRequestPageIdMatches=' + requestPageIdMatches + '; catalogResponsePageIdMatches=' + responsePageIdMatches, 'InvalidStateError');
  const exercise = detail.item.object;
  return { path: target.path, courseId: target.courseId, pageId: detail.id, exerciseId: exercise.id, exerciseType: exercise.type, maximumScore: exercise.score, ifDigi: exercise.ifDigi };
}

export function createTsinghuaResultContext(identity: OfficialExerciseIdentity, view: TsinghuaResultView, generation: number): TsinghuaResultContext {
  if (identity.path !== view.path || identity.courseId !== view.courseId) throw new DOMException('官方练习身份不属于当前课程视图。', 'InvalidStateError');
  return { questionKey: view.questionKey, generation, courseId: identity.courseId, pageId: identity.pageId, exerciseId: identity.exerciseId, exerciseType: identity.exerciseType, maximumScore: identity.maximumScore, ifDigi: identity.ifDigi };
}

/** Parse transient natural response exercises; only the answer plan leaves this boundary. */
export function projectTsinghuaContentAnswerPlan(value: object): TsinghuaAnswerPlan | null {
  const exercise = z.object({ object: z.object({ item: z.object({ object: exerciseSchema.passthrough() }) }) }).parse(value).object.item.object;
  return parseTsinghuaAnswerPlan(exercise);
}

export function projectTsinghuaRecordAnswerPlan(value: object): TsinghuaAnswerPlan | null {
  const exercise = z.object({ object: z.object({ exercise: exerciseSchema.passthrough() }) }).parse(value).object.exercise;
  return parseTsinghuaAnswerPlan(exercise);
}

/** Retain a minimal projection only; unrelated answer/audio/user fields are discarded. */
export function projectTsinghuaRecord(value: object): TsinghuaRecordProjection {
  const status = z.object({ status: z.boolean() }).safeParse(value);
  if (!status.success) throw new TypeError('官方记录响应缺少布尔 status。');
  if (!status.data.status) return { status: false };
  const parsed = tsinghuaRecordResultProjectionSchema.safeParse(value);
  if (!parsed.success) throw new TypeError('官方题级记录缺少必要判分或练习身份字段，未保留原始正文。');
  return parsed.data;
}

export function projectTsinghuaSubmit(value: object): z.infer<typeof tsinghuaSubmitResultProjectionSchema> | { status: false } {
  const status = z.object({ status: z.boolean() }).safeParse(value);
  if (!status.success) throw new TypeError('官方提交响应缺少布尔 status，未把 HTTP 200 当作业务接受。');
  if (!status.data.status) return { status: false };
  const parsed = tsinghuaSubmitResultProjectionSchema.safeParse(value);
  if (!parsed.success) throw new TypeError('官方提交响应缺少 isVisiable 或 doRecord 必要字段。');
  return parsed.data;
}
