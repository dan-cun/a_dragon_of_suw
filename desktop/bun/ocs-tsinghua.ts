import { randomUUID } from 'node:crypto';
import type { TsinghuaAnswerPlan } from '../ocs/tsinghua-answers';
import { parseTsinghuaSubmitResult, parseTsinghuaRecordResult, type TsinghuaResultContext, type TsinghuaExerciseResult } from '../ocs/tsinghua-result';
import { createTsinghuaResultContext, inspectTsinghuaResultView, installTsinghuaResultTracker, parseTsinghuaContentIdentity, projectTsinghuaContentAnswerPlan, projectTsinghuaRecordAnswerPlan, projectTsinghuaRecord, projectTsinghuaSubmit, tsinghuaRequestTarget, type OfficialExerciseIdentity, type TsinghuaResultView, type TsinghuaRequestTarget, type TsinghuaRecordProjection } from './ocs-tsinghua-results';
import type { BrowserContext, Page, Request } from 'playwright-core';
import { TSINGHUA_LEGACY_HOME, tsinghuaStateSchema, type TsinghuaState, type TsinghuaQuestion } from '../shared/ocs-tsinghua';
import { armTsinghuaPage, assertTsinghuaPage, beginTsinghuaMedia, exerciseCourseId, inspectTsinghuaQuestion, parseTsinghuaDetailUrl, readTsinghuaCourseScore, runTsinghuaOrdinary, stopTsinghuaHooks } from './ocs-tsinghua-page';
import { enterTsinghuaExercise, nextTsinghuaExercise, parseTsinghuaCourseList, tsinghuaLoginVisible, TSINGHUA_COURSE_LIST_PATH, TSINGHUA_LEGACY_COURSES, type TsinghuaCourseLink } from './ocs-tsinghua-navigation';
import { submitTsinghuaLogin, verifyTsinghuaLoginSlider } from './ocs-tsinghua-slider';
import { parseTsinghuaCatalogList, parseTsinghuaCatalogUnit, mergeTsinghuaCatalogUnit, type TsinghuaCatalogNode } from '../ocs/tsinghua-catalog';

export type TsinghuaReporter = (id: string, level: 'info' | 'warning' | 'error', event: string, message: string) => void;
export interface TsinghuaController {
  snapshot(): TsinghuaState;
  resumeUrl(): string | null;
  isSettled(): boolean;
  open(): Promise<void>;
  verifySlider(): Promise<void>;
  selectCourse(courseId: number): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  refresh(): Promise<void>;
  readScore(): Promise<void>;
  close(): Promise<void>;
}
interface Operation { epoch: number; signal: AbortSignal }
interface ResultRequestBinding {
  kind: 'content' | 'record' | 'submit'; epoch: number; runId: string | null;
  target: TsinghuaRequestTarget; context: TsinghuaResultContext | null;
}
interface CachedExerciseRecord {
  value: TsinghuaRecordProjection; identity: OfficialExerciseIdentity; observedAt: string; httpStatus: number;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cancel = (): void => { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, milliseconds);
    signal.addEventListener('abort', cancel, { once: true });
  });
}

/** Own one course task in the existing Chrome context; snapshots never await platform work. */
export function createTsinghuaController(browserId: string, context: BrowserContext, script: TsinghuaState['script'], report: TsinghuaReporter): TsinghuaController {
  let state: TsinghuaState = tsinghuaStateSchema.parse({ browserId, runId: null, phase: 'idle', owned: false, message: '尚未打开清华社旧版课程。', errorCode: null, updatedAt: new Date().toISOString(), courses: [], courseId: null, courseTitle: null, question: null, result: null, script });
  let page: Page | null = null;
  let courses: TsinghuaCourseLink[] = [];
  let courseTotal: number | null = null;
  let courseListError: Error | null = null;
  const courseReads = new Set<Promise<void>>();
  const catalogSnapshots = new Map<number, TsinghuaCatalogNode[]>();
  const catalogLatest = new Map<number, number>();
  const catalogErrors = new Map<number, Error>();
  let catalogSequence = 0;
  const resultRequests = new WeakMap<Request, Promise<ResultRequestBinding | null>>();
  const resultReads = new Set<Promise<void>>();
  let officialExercise: OfficialExerciseIdentity | null = null;
  let cachedRecord: CachedExerciseRecord | null = null;
  let exerciseResult: TsinghuaExerciseResult | null = null;
  let answerAuthority = 0;
  let answerPlan: { plan: TsinghuaAnswerPlan; identity: OfficialExerciseIdentity; authority: number; questionKey: string | null } | null = null;
  let resultGeneration = 0;
  let resultView: TsinghuaResultView | null = null;
  let trackerError: Error | null = null;
  let resume: string | null = null;
  let epoch = 0;
  let cancellation = new AbortController();
  let closing = false;
  let closed = false;
  let stopTask: Promise<void> | null = null;
  const tasks = new Set<Promise<void>>();
  const ordinaryKinds = new Set(['single', 'multiple', 'judge', 'dropdown', 'fill', 'drag', 'listen_fill']);
  const oralKinds = new Set(['listen_repeat', 'oral', 'roleplay']);

  function update(patch: Partial<TsinghuaState>): void {
    if (patch.result === null) exerciseResult = null;
    state = tsinghuaStateSchema.parse({ ...state, ...patch, updatedAt: new Date().toISOString() });
  }
  function failure(cause: Error): void {
    update({ phase: 'failed', message: cause.message.slice(0, 2000), errorCode: cause.name });
    report(browserId, 'error', 'tsinghua.operation.failed', JSON.stringify({ code: cause.name, runId: state.runId, courseId: state.courseId }));
  }
  function check(operation: Operation): void {
    operation.signal.throwIfAborted();
    if (operation.epoch !== epoch || closed || closing) throw new DOMException('清华社运行已取消或所有权已改变。', 'AbortError');
  }
  function current(operation: Operation): Page {
    check(operation);
    if (!page || page.isClosed() || page.context() !== context) throw new DOMException('清华社当前页面不再属于本次受控浏览器。', 'InvalidStateError');
    assertTsinghuaPage(page);
    const courseId = exerciseCourseId(page.url()) ?? parseTsinghuaDetailUrl(page.url())?.courseId ?? null;
    if (state.courseId !== null && courseId !== null && courseId !== state.courseId) throw new DOMException('清华社当前课程与已选择 ID 不一致，已禁止继续操作。', 'SecurityError');
    return page;
  }
  function begin(): Operation {
    if (closed || closing || stopTask || tasks.size > 0) throw new DOMException('清华社仍有接受的工作或停止未结算，请等待后重试。', 'InvalidStateError');
    epoch += 1;
    cancellation = new AbortController();
    cancellation.signal.addEventListener('abort', clearAnswerPlan, { once: true });
    return { epoch, signal: cancellation.signal };
  }
  function track(work: Promise<void>, operation: Operation): Promise<void> {
    update({ owned: true });
    const task = work.catch(cause => {
      if (operation.signal.aborted) return;
      const error = cause instanceof Error ? cause : new TypeError('清华社操作抛出非标准错误。');
      failure(error);
      throw error;
    }).finally(() => { tasks.delete(task); update({ owned: tasks.size > 0 }); });
    tasks.add(task);
    return task;
  }
  async function until(operation: Operation, predicate: () => Promise<boolean>, label: string): Promise<void> {
    const deadline = Date.now() + 15000;
    do {
      check(operation);
      if (await predicate()) { check(operation); return; }
      await delay(200, operation.signal);
    } while (Date.now() < deadline);
    throw new DOMException(label + '在 15 秒内未得到官网页面确认；未尝试其他按钮。', 'TimeoutError');
  }
  function clearAnswerPlan(): void {
    answerAuthority += 1;
    answerPlan = null;
  }
  function captureAnswerPlan(project: () => TsinghuaAnswerPlan | null, identity: OfficialExerciseIdentity): void {
    try {
      const plan = project();
      if (plan === null) return;
      if (plan.exerciseId !== identity.exerciseId) throw new DOMException('官方答案计划 exerciseId 与已核验 exercise.id 不一致。', 'InvalidStateError');
      answerPlan = { plan: { ...plan, answers: [...plan.answers] }, identity: { ...identity }, authority: answerAuthority, questionKey: null };
    } catch (cause) {
      clearAnswerPlan();
      update({ errorCode: 'OfficialAnswerInvalid', message: '官方答案必要字段或练习身份未通过校验，禁止自动填入；已有题级评分仍按原契约核验。' });
      report(browserId, 'warning', 'tsinghua.answer-plan.invalid', JSON.stringify({ code: cause instanceof Error ? cause.name : 'NonError', exerciseId: identity.exerciseId }));
    }
  }
  function currentAnswerPlan(question: TsinghuaQuestion): TsinghuaAnswerPlan | null {
    const binding = answerPlan;
    const identity = officialExercise;
    const view = resultView;
    if (!binding || !identity || !view || cancellation.signal.aborted || binding.authority !== answerAuthority ||
      binding.plan.exerciseId !== identity.exerciseId || binding.plan.kind !== question.kind ||
      binding.identity.exerciseId !== identity.exerciseId || binding.identity.pageId !== identity.pageId ||
      binding.identity.courseId !== identity.courseId || binding.identity.path !== view.path || identity.path !== view.path ||
      view.courseId !== identity.courseId || question.id !== view.path + '#' + view.questionKey ||
      (binding.questionKey !== null && binding.questionKey !== view.questionKey)) return null;
    answerPlan = { ...binding, questionKey: view.questionKey };
    return { ...binding.plan, answers: [...binding.plan.answers] };
  }
  function synchronizeResultView(view: TsinghuaResultView): void {
    if (answerPlan && (answerPlan.identity.path !== view.path || (answerPlan.questionKey !== null && answerPlan.questionKey !== view.questionKey))) clearAnswerPlan();
    if (answerPlan && answerPlan.questionKey === null) answerPlan = { ...answerPlan, questionKey: view.questionKey };
    if (resultView && (resultView.path !== view.path || resultView.questionKey !== view.questionKey || resultView.interactionRevision !== view.interactionRevision)) {
      resultGeneration += 1;
      update({ result: null });
    }
    resultView = view;
  }
  async function resultContext(selected: Page): Promise<TsinghuaResultContext | null> {
    const view = await inspectTsinghuaResultView(selected);
    if (!view) return null;
    synchronizeResultView(view);
    if (!officialExercise || officialExercise.path !== view.path || officialExercise.courseId !== view.courseId) return null;
    return createTsinghuaResultContext(officialExercise, view, resultGeneration);
  }
  function publishResult(parsed: TsinghuaExerciseResult): void {
    exerciseResult = parsed;
    update({ result: parsed.result, message: parsed.result.message, errorCode: null });
    report(browserId, 'info', 'tsinghua.exercise.result', JSON.stringify({ source: parsed.result.source, state: parsed.state, generation: parsed.context.generation, hasScore: parsed.result.score !== null, correctnessVerified: false }));
  }
  function hasRecordedScore(question: TsinghuaQuestion): boolean {
    const parsed = exerciseResult;
    return parsed !== null && parsed.state === 'recorded-score' && parsed.result.score !== null &&
      state.result !== null && officialExercise !== null && resultView !== null &&
      question.id === resultView.path + '#' + parsed.context.questionKey &&
      parsed.context.questionKey === resultView.questionKey && parsed.context.generation === resultGeneration &&
      parsed.context.exerciseId === officialExercise.exerciseId && parsed.context.pageId === officialExercise.pageId &&
      parsed.context.courseId === officialExercise.courseId && officialExercise.path === resultView.path;
  }
  function publishHistoricalRecord(requested: TsinghuaResultContext): boolean {
    const record = cachedRecord;
    if (!record || record.identity.path !== resultView?.path || record.identity.pageId !== requested.pageId || record.identity.exerciseId !== requested.exerciseId || record.identity.courseId !== requested.courseId) return false;
    const parsed = parseTsinghuaRecordResult(record.value, { requested, current: requested, observedAt: record.observedAt, httpStatus: record.httpStatus });
    publishResult({ ...parsed, result: { ...parsed.result, message: '官网已加载的本题历史记录；不是刚才录音的新分证明。' + parsed.result.message } });
    return true;
  }
  async function waitForRecordedScore(operation: Operation, expectedQuestionId: string): Promise<TsinghuaQuestion | null> {
    update({ phase: 'awaiting-result', message: '正在等待本题同身份官方记录和数值成绩；确认后自动继续，不把填入或 HTTP 成功当作接受，不自动重交。' });
    const deadline = Date.now() + 15000;
    do {
      const question = await sample(operation);
      if (question.id !== expectedQuestionId) throw new DOMException('等待官方结果期间练习视图已变化，未沿用旧题评分或自动重交。', 'InvalidStateError');
      if (hasRecordedScore(question)) return question;
      if (exerciseResult?.result.accepted === false) {
        update({ phase: 'awaiting-result', message: exerciseResult.result.message + ' 自动流程已停止，未翻页或重交。' });
        return null;
      }
      await delay(200, operation.signal);
    } while (Date.now() < deadline);
    update({ phase: 'awaiting-result', message: '15 秒内未取得同题官方数值成绩；自动流程已停止，请显式读取本题官方记录。未把接受/过关当作答对，也未自动重交。' });
    return null;
  }
  function observeRequest(request: Request): void {
    if (!page || closed || closing || cancellation.signal.aborted) return;
    const url = new URL(request.url());
    if (url.origin !== 'https://www.tsinghuaelt.com') return;
    const kind = url.pathname === '/tsenglish/exercise/submit' && request.method() === 'PUT' ? 'submit'
      : url.pathname === '/tsenglish/exercise/record_for_detail' && request.method() === 'POST' ? 'record'
      : ['/tsenglish/textbook/content_detail', '/tsenglish/supply/pageDetail'].includes(url.pathname) && request.method() === 'GET' ? 'content' : null;
    if (kind === null || request.frame() !== page.mainFrame()) return;
    const selected = page;
    const requestEpoch = epoch;
    const runId = state.runId;
    if (kind === 'content') clearAnswerPlan();
    if (kind === 'submit') { resultGeneration += 1; update({ result: null }); }
    const requestGeneration = resultGeneration;
    const binding = (async (): Promise<ResultRequestBinding | null> => {
      const target = tsinghuaRequestTarget(request.url(), selected.url());
      if (!target) return null;
      const context = kind === 'content' ? null : await resultContext(selected);
      if (requestEpoch !== epoch || selected !== page || cancellation.signal.aborted || (kind === 'submit' && requestGeneration !== resultGeneration)) return null;
      return { kind, epoch: requestEpoch, runId, target, context };
    })().catch(cause => {
      if (requestEpoch === epoch && !cancellation.signal.aborted) {
        update({ result: null, errorCode: 'ResultIdentityUnavailable', message: '未能独立绑定本题官方评分身份；不会用路由代替 exercise.id，请在官网正常加载当前练习后读取记录。' });
        report(browserId, 'warning', 'tsinghua.result.binding.failed', JSON.stringify({ code: cause instanceof Error ? cause.name : 'NonError' }));
      }
      return null;
    });
    resultRequests.set(request, binding);
    const settled = binding.then(() => undefined).finally(() => { resultReads.delete(settled); });
    resultReads.add(settled);
  }
  /** Project only naturally requested course directories; route keys and content keys are different domains. */
  function observeCatalog(request: Request): void {
    if (!page || closed || closing || cancellation.signal.aborted) return;
    const url = new URL(request.url());
    if (url.origin !== 'https://www.tsinghuaelt.com') return;
    const kind = url.pathname === '/tsenglish/course/newCatalogZorroListForStuForStudy' && request.method() === 'GET' ? 'list'
      : url.pathname === '/tsenglish/course/catalogZorroListForStuForStudySingleUnit' && request.method() === 'POST' ? 'unit' : null;
    if (kind === null || request.frame() !== page.mainFrame()) return;
    const courseId = Number(url.searchParams.get('id'));
    const selected = page;
    const selectedCourse = exerciseCourseId(selected.url()) ?? parseTsinghuaDetailUrl(selected.url())?.courseId ?? null;
    if (!Number.isSafeInteger(courseId) || courseId <= 0 || courseId !== selectedCourse) {
      update({ errorCode: 'OfficialCatalogIdentityUnavailable', message: '官网自然目录请求的课程 ID 与当前页面不符；未绑定答案或读取认证参数。' });
      return;
    }
    const sequence = ++catalogSequence;
    const signal = cancellation.signal;
    catalogLatest.set(courseId, sequence);
    const read = (async () => {
      const response = await request.response();
      if (!response || response.status() !== 200) throw new DOMException('官网自然目录未返回 HTTP 200，无法绑定本题页面身份。', 'NetworkError');
      const bytes = await response.body();
      if (bytes.length > 1048576) throw new RangeError('官网自然目录响应超过 1 MiB，未保留正文。');
      const value: object = JSON.parse(bytes.toString('utf8'));
      const roots = kind === 'list' ? parseTsinghuaCatalogList(value)
        : mergeTsinghuaCatalogUnit(catalogSnapshots.get(courseId) ?? [], parseTsinghuaCatalogUnit(value));
      if (signal.aborted || closed || closing || selected !== page || selected.isClosed() || catalogLatest.get(courseId) !== sequence) return;
      const currentCourse = exerciseCourseId(selected.url()) ?? parseTsinghuaDetailUrl(selected.url())?.courseId ?? null;
      if (currentCourse !== courseId) return;
      catalogSnapshots.set(courseId, roots);
      catalogErrors.delete(courseId);
    })().catch(cause => {
      if (signal.aborted || selected !== page || catalogLatest.get(courseId) !== sequence) return;
      const error = cause instanceof Error ? cause : new TypeError('官网目录投影出现非标准错误。');
      catalogErrors.set(courseId, error);
      report(browserId, 'warning', 'tsinghua.catalog.unverified', JSON.stringify({ courseId, code: error.name }));
    }).finally(() => { courseReads.delete(read); });
    courseReads.add(read);
  }
  function observeCourseList(request: Request): void {
    if (closed || closing || cancellation.signal.aborted) return;
    const url = new URL(request.url());
    if (!page || request.frame() !== page.mainFrame() || request.method() !== 'GET' || url.origin !== 'https://www.tsinghuaelt.com' || url.pathname !== TSINGHUA_COURSE_LIST_PATH) return;
    const observedEpoch = epoch;
    const selected = page;
    const read = (async () => {
      const response = await request.response();
      if (!response || response.status() !== 200) throw new DOMException('官网课程列表未返回 HTTP 200，未读取或保存认证参数。', 'NetworkError');
      const bytes = await response.body();
      if (bytes.length > 1048576) throw new RangeError('官网课程列表响应超过 1 MiB，未保留响应正文。');
      const list = parseTsinghuaCourseList(JSON.parse(bytes.toString('utf8')));
      if (epoch !== observedEpoch || cancellation.signal.aborted || page !== selected || selected.isClosed() || new URL(selected.url()).pathname !== '/legacy/studentcourse') return;
      courses = list.courses;
      courseTotal = list.total;
      update({ courses: courses.map(({ id, title }) => ({ id, title })) });
    })().catch(cause => {
      if (epoch !== observedEpoch || cancellation.signal.aborted) return;
      courseListError = new TypeError('官网 stuCourseList 响应未通过必要字段验证；课程 ID 发现已停止，请核对官方课程列表和接口结构。', { cause });
      report(browserId, 'error', 'tsinghua.course-list.failed', JSON.stringify({ code: courseListError.name }));
    }).finally(() => { courseReads.delete(read); });
    courseReads.add(read);
  }
  function observeExerciseResult(request: Request): void {
    const pending = resultRequests.get(request);
    if (!pending || !page || closed || closing || cancellation.signal.aborted) return;
    const selected = page;
    const readEpoch = epoch;
    const readGeneration = resultGeneration;
    const predecessors = [...resultReads];
    const read = (async () => {
      const binding = await pending;
      if (!binding || binding.epoch !== epoch || binding.runId !== state.runId || selected !== page || cancellation.signal.aborted) return;
      if (new URL(selected.url()).pathname !== binding.target.path) return;
      const response = await request.response();
      if (!response) throw new DOMException('官方练习请求没有可读取响应。', 'NetworkError');
      const bytes = await response.body();
      if (bytes.length > 1048576) throw new RangeError('官方练习响应超过 1 MiB，未保留正文。');
      const value: object = JSON.parse(bytes.toString('utf8'));
      if (binding.epoch !== epoch || binding.runId !== state.runId || cancellation.signal.aborted || selected !== page || new URL(selected.url()).pathname !== binding.target.path) return;
      if (binding.kind === 'content') {
        if (response.status() < 200 || response.status() >= 300) throw new DOMException('官方内容请求未返回成功 HTTP 状态，禁止使用其答案。', 'NetworkError');
        await Promise.all([...courseReads]);
        if (binding.epoch !== epoch || binding.runId !== state.runId || cancellation.signal.aborted || selected !== page || new URL(selected.url()).pathname !== binding.target.path) return;
        const catalogError = catalogErrors.get(binding.target.courseId);
        if (catalogError) throw new TypeError('官网自然目录未通过结构或身份验证，禁止绑定本题内容。', { cause: catalogError });
        const identity = parseTsinghuaContentIdentity(value, binding.target, catalogSnapshots.get(binding.target.courseId) ?? []);
        if (!officialExercise || officialExercise.exerciseId !== identity.exerciseId || officialExercise.pageId !== identity.pageId || officialExercise.path !== identity.path) {
          resultGeneration += 1;
          cachedRecord = null;
          clearAnswerPlan();
          update({ result: null });
        }
        officialExercise = identity;
        captureAnswerPlan(() => projectTsinghuaContentAnswerPlan(value), identity);
        return;
      }
      if (binding.kind === 'record') await Promise.all(predecessors);
      const current = await resultContext(selected);
      if (binding.epoch !== epoch || binding.runId !== state.runId || cancellation.signal.aborted) return;
      if (!officialExercise || officialExercise.pageId !== binding.target.pageId) {
        update({ result: null, message: '已观察官方题级响应，但尚未取得独立匹配的 content_detail 练习身份；未猜测分数，请在官网正常加载本题。' });
        return;
      }
      const observedAt = new Date().toISOString();
      if (binding.kind === 'record') {
        const projection = projectTsinghuaRecord(value);
        if (!projection.status) {
          if (binding.context && current) publishResult(parseTsinghuaRecordResult(projection, { requested: binding.context, current, observedAt, httpStatus: response.status() }));
          return;
        }
        if (projection.object.exercise.id !== officialExercise.exerciseId || projection.object.exercise.type !== officialExercise.exerciseType || projection.object.exercise.score !== officialExercise.maximumScore || projection.object.exercise.ifDigi !== officialExercise.ifDigi) throw new DOMException('官方记录 exercise.id/type/score/ifDigi 与内容响应不一致。', 'InvalidStateError');
        if (binding.context && current && binding.context.generation !== current.generation) return;
        if (response.status() >= 200 && response.status() < 300) captureAnswerPlan(() => projectTsinghuaRecordAnswerPlan(value), officialExercise);
        cachedRecord = { value: projection, identity: { ...officialExercise }, observedAt, httpStatus: response.status() };
        if (!binding.context || !current) {
          update({ message: '已加载本题官方历史记录；请求发起时本地视图身份尚未就绪，请显式读取本题成绩，不认定为刚才录音的新分。' });
          return;
        }
        publishResult(parseTsinghuaRecordResult(projection, { requested: binding.context, current, observedAt, httpStatus: response.status() }));
      } else {
        if (!binding.context || !current) throw new DOMException('提交请求发起前或响应到达时没有完整官方练习身份，未发布无法归属的评分。', 'InvalidStateError');
        publishResult(parseTsinghuaSubmitResult(projectTsinghuaSubmit(value), { requested: binding.context, current, observedAt, httpStatus: response.status() }));
      }
    })().catch(cause => {
      if (readEpoch !== epoch || readGeneration !== resultGeneration || cancellation.signal.aborted) return;
      const contentIdentityMismatch = cause instanceof Error && cause.message.startsWith('TSH_CONTENT_IDENTITY_MISMATCH:');
      update({ result: null, errorCode: contentIdentityMismatch ? 'OfficialContentIdentityMismatch' : 'OfficialResultUnverified', message: contentIdentityMismatch ? '官方目录节点、自然内容请求和响应的页面身份不一致；未使用该响应的答案或分数，不会回退到内容 key 或自动重试。' : '官方题级响应未通过目录身份、代次或必要字段校验；未发布分数。请在官网核对本题后显式读取记录。' });
      report(browserId, 'warning', 'tsinghua.result.unverified', JSON.stringify({ code: cause instanceof Error ? cause.name : 'NonError', contentIdentityMismatch }));
    }).finally(() => { resultReads.delete(read); });
    resultReads.add(read);
  }
  function invalidated(): void {
    epoch += 1;
    resultGeneration += 1;
    officialExercise = null;
    cachedRecord = null;
    resultView = null;
    cancellation.abort(new DOMException('清华社受控文档关闭，运行已取消。', 'AbortError'));
    update({ phase: closing ? 'stopped' : 'failed', message: '清华社受控页面已关闭，未确认的提交结果需本人核对。', errorCode: closing ? null : 'PageClosed', question: null, result: null });
  }
  function attach(selected: Page): void {
    page = selected;
    selected.on('request', observeRequest);
    selected.on('request', observeCatalog);
    selected.on('requestfinished', observeCourseList);
    selected.on('requestfinished', observeExerciseResult);
    selected.on('close', invalidated);
    selected.on('crash', invalidated);
  }
  async function choosePage(operation: Operation): Promise<Page> {
    await initialization;
    check(operation);
    if (trackerError) throw trackerError;
    if (page && !page.isClosed()) {
      await page.evaluate(installTsinghuaResultTracker);
      if (new URL(page.url()).origin === 'https://www.tsinghuaelt.com') await armTsinghuaPage(page);
      check(operation);
      return page;
    }
    const candidates = context.pages().filter(candidate => !candidate.isClosed() && URL.canParse(candidate.url()) && new URL(candidate.url()).origin === 'https://www.tsinghuaelt.com');
    if (candidates.length > 1) throw new RangeError('当前浏览器存在多个清华社页面，不能猜测课程目标；请保留唯一课程页面。');
    const selected = candidates[0] ?? await context.newPage();
    check(operation);
    attach(selected);
    if (new URL(selected.url()).origin === 'https://www.tsinghuaelt.com') {
      await armTsinghuaPage(selected);
      check(operation);
    }
    return selected;
  }
  async function navigate(url: string, operation: Operation): Promise<void> {
    check(operation);
    if (!page) throw new DOMException('尚未持有清华社页面。', 'InvalidStateError');
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    check(operation);
    if (response && response.status() >= 400) throw new DOMException(`清华社文档导航 HTTP ${response.status()}；未继续操作页面。`, 'NetworkError');
    assertTsinghuaPage(page);
  }
  async function inspect(operation: Operation): Promise<void> {
    const selected = current(operation);
    const login = await tsinghuaLoginVisible(selected);
    check(operation);
    if (login) {
      update({ phase: 'awaiting-login', message: '请本人在官网完成登录，再点击刷新课程；软件不读取或提交密码、Cookie、验证码。', question: null, result: null, courses: [], courseId: null, courseTitle: null });
      courses = [];
      courseTotal = null;
      resume = null;
      return;
    }
    const detail = parseTsinghuaDetailUrl(selected.url());
    if (detail) {
      resume = detail.url;
      if (state.courseId === null) update({ courseId: detail.courseId, courseTitle: await selected.title() });
    }
    if (exerciseCourseId(selected.url()) !== null) {
      await until(operation, async () => await current(operation).evaluate(() => {
        const hook = Reflect.get(globalThis, '__SWU_TSH_LEGACY__') as { adapterVersion?: string; inspect?: object } | undefined;
        const roots = [...document.querySelectorAll('app-course-task-stu')].filter(element => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        });
        if (roots.length > 1) throw new RangeError('清华社活动练习根不唯一；不能猜测读取目标。');
        if (roots.length !== 1 || hook?.adapterVersion !== 'swu-legacy-1' || typeof hook.inspect !== 'function') return false;
        try { hook.inspect(); return true; }
        catch (cause) {
          if (cause instanceof Error && cause.message.startsWith('TSH_QUESTION_TRANSITION:')) return false;
          throw cause;
        }
      }), '等待固定脚本与可见练习区域就绪');
      const question = await inspectTsinghuaQuestion(selected);
      check(operation);
      if (state.courseId === null) update({ courseId: exerciseCourseId(selected.url()), courseTitle: await selected.title() });
      const requested = await resultContext(selected);
      check(operation);
      update({ question, result: state.question?.id === question.id ? state.result : null });
      if (question.answered === true && requested && !hasRecordedScore(question)) publishHistoricalRecord(requested);
      const oral = oralKinds.has(question.kind);
      const scored = question.answered === true && hasRecordedScore(question);
      update({ phase: oral && !scored ? question.answered === false ? 'awaiting-recording' : 'awaiting-result' : 'ready', message: oral ? scored ? '已核验本题已作答的官网记录及数值分，可以继续课程；历史分不是新录音证明，不会要求自动重录。' : question.answered === false ? '已定位尚未作答的口语任务；录音及录音提交必须本人在官网完成。' : '当前口语页尚无同题官方数值分，请显式读取本题成绩；不会据此自动要求重录。' : '已识别当前练习；只使用完整的官方答案计划，等待同题官方数值分后自动续学，不随机首答或自动 Retry。' });
      return;
    }
    update({ phase: 'selecting-course', question: null, result: null, courses: courses.map(({ id, title }) => ({ id, title })), message: courseTotal === 1 && courses.length === 1 ? '已验证官网唯一可学习课程。' : courses.length > 0 ? '请在软件中明确选择官网课程 ID；多课程或未完整加载的列表不会自动选择第一门。' : '官网当前列表没有通过必要字段及权限核验的可学习课程。' });
  }
  async function enterCourse(course: TsinghuaCourseLink, operation: Operation): Promise<void> {
    update({ courseId: course.id, courseTitle: course.title, phase: 'navigating', question: null, result: null });
    await navigate(course.url, operation);
    const selected = current(operation);
    const detail = parseTsinghuaDetailUrl(selected.url());
    if (!detail || detail.courseId !== course.id) throw new DOMException('官网课程详情与所选 ID 不符。', 'SecurityError');
    resume = detail.url;
    await until(operation, async () => await current(operation).locator('.topBtn button:visible').count() === 1, '加载官网继续学习控件');
    check(operation);
    await enterTsinghuaExercise(selected);
    await until(operation, async () => exerciseCourseId(current(operation).url()) === course.id, '进入选定课程练习');
    await inspect(operation);
  }
  async function discover(operation: Operation): Promise<void> {
    const selected = current(operation);
    if (await tsinghuaLoginVisible(selected)) { await inspect(operation); return; }
    const detail = parseTsinghuaDetailUrl(selected.url());
    if (exerciseCourseId(selected.url()) !== null) { await inspect(operation); return; }
    if (detail) {
      update({ courseId: detail.courseId, courseTitle: await selected.title(), question: null, result: null });
      resume = detail.url;
      await until(operation, async () => await current(operation).locator('.topBtn button:visible').count() === 1, '加载已保存课程继续学习控件');
      check(operation);
      await enterTsinghuaExercise(selected);
      await until(operation, async () => exerciseCourseId(current(operation).url()) === detail.courseId, '从已保存课程进入练习');
      await inspect(operation);
      return;
    }
    courses = [];
    courseTotal = null;
    courseListError = null;
    update({ phase: 'selecting-course', courses: [], courseId: null, courseTitle: null, question: null, result: null, message: '正在读取官网 stuCourseList 的真实课程 ID，不按卡片位置或文字推断。' });
    await navigate(TSINGHUA_LEGACY_COURSES, operation);
    await until(operation, async () => {
      if (courseListError) throw courseListError;
      return courseTotal !== null || await tsinghuaLoginVisible(current(operation));
    }, '读取官网 stuCourseList');
    await inspect(operation);
    check(operation);
    const total = (): number | null => courseTotal;
    if (total() === 1 && courses.length === 1) await enterCourse(courses[0]!, operation);
  }
  async function sample(operation: Operation): Promise<TsinghuaQuestion> {
    const question = await inspectTsinghuaQuestion(current(operation));
    check(operation);
    await resultContext(current(operation));
    check(operation);
    update({ question, result: state.question?.id === question.id ? state.result : null });
    return question;
  }
  async function run(operation: Operation): Promise<void> {
    await armTsinghuaPage(current(operation));
    check(operation);
    for (;;) {
      let question = await sample(operation);
      await Promise.all([...resultReads]);
      check(operation);
      const requested = await resultContext(current(operation));
      check(operation);
      if (question.answered === true && requested && !hasRecordedScore(question)) publishHistoricalRecord(requested);
      const oral = oralKinds.has(question.kind);
      if (oral && (question.answered !== true || !hasRecordedScore(question))) {
        update({ phase: question.answered === false ? 'awaiting-recording' : 'awaiting-result', message: question.answered === false ? '当前口语任务尚未作答；录音及录音提交必须本人在官网完成，软件不会启动录音。' : '当前口语页尚无同题可核验数值分；请显式读取官方成绩，不会自动要求重录，历史分不证明新录音。' });
        return;
      }
      if (question.kind === 'unknown') throw new TypeError('当前练习题型未知或冲突，未提交、未翻页。');
      if (!oral) {
        if (question.media.length > 1 || (['audio', 'video'].includes(question.kind) && question.media.length !== 1)) throw new RangeError('当前活动媒体必须可见且唯一，未播放时禁止跳题。');
        if (question.media.some(media => media.phase !== 'ended')) {
          update({ phase: 'playing', message: '正在以 1 倍速正常播放；不会静音、跳结尾或伪造完成。若浏览器拒绝播放，请本人点击官网播放后刷新。' });
          await beginTsinghuaMedia(current(operation), question.id);
          for (;;) {
            await delay(300, operation.signal);
            const latest = await sample(operation);
            if (latest.id !== question.id) throw new DOMException('媒体播放期间练习已变化，已停止自动流程。', 'InvalidStateError');
            if (latest.media.length !== 1) throw new RangeError('活动媒体数量发生变化，不能确认原媒体真实结束。');
            const media = latest.media[0]!;
            if (media.phase === 'failed') throw new DOMException('清华社媒体播放失败，请检查官网播放器。', 'NotSupportedError');
            if (media.playbackRate !== 1 || media.muted) throw new DOMException('活动媒体不再是未静音的正常 1 倍播放，已停止自动流程。', 'InvalidStateError');
            if (media.phase === 'ended') break;
          }
          question = await sample(operation);
        }
      }
      check(operation);
      update({ phase: 'running', message: '正在执行当前课程流程；官方结果未确认前不报告正确率。' });
      if (ordinaryKinds.has(question.kind)) {
        await until(operation, async () => await resultContext(current(operation)) !== null, '读取本题官方 exercise.id/type/score/ifDigi');
        check(operation);
        if (question.answered !== true) {
          const plan = currentAnswerPlan(question);
          if (!plan) {
            update({ phase: 'awaiting-result', errorCode: 'OfficialAnswerUnavailable', message: '当前练习没有完整且身份匹配的官方答案计划，已停止作答；不会填入假值、随机答案、调用云模型或自动 Retry。' });
            return;
          }
          update({ result: null });
          const result = await runTsinghuaOrdinary(current(operation), question.id, plan);
          check(operation);
          if (result.kind !== question.kind) throw new DOMException('普通题执行期间题型发生变化，停止后续自动动作。', 'InvalidStateError');
        }
        const scored = await waitForRecordedScore(operation, question.id);
        if (!scored) return;
        question = scored;
      } else if (!oral && !['reading', 'audio', 'video'].includes(question.kind)) throw new TypeError('当前题型不属于已适配的普通题或媒体，未继续提交。');
      const previousId = question.id;
      update({ phase: 'running', message: oral ? '已核验官网本题已作答记录及数值分，继续课程；该历史记录不证明新的录音。' : '当前任务已满足续学条件，等待正常翻页；官网分数不换算为正确率。' });
      await delay(4000, operation.signal);
      const selected = current(operation);
      const latest = await sample(operation);
      if (latest.id !== previousId) throw new DOMException('翻页前活动练习视图变化，已停止旧运行。', 'InvalidStateError');
      if ((oral || ordinaryKinds.has(question.kind)) && !hasRecordedScore(latest)) {
        update({ phase: 'awaiting-result', message: '翻页前本题评分身份已失效，已停止；请显式读取本题官方成绩。' });
        return;
      }
      clearAnswerPlan();
      if (!await nextTsinghuaExercise(selected, previousId)) {
        update({ phase: 'awaiting-result', message: '未观察到唯一可用下一页入口；不据此宣称全课完成，请读取官网成绩。' });
        return;
      }
      update({ question: null, result: null });
      await until(operation, async () => {
        if (await current(operation).locator('app-course-task-stu:visible').count() !== 1) return false;
        return (await inspectTsinghuaQuestion(current(operation))).id !== previousId;
      }, '官网下一页练习视图');
    }
  }
  function contextClosed(): void {
    epoch += 1;
    resultGeneration += 1;
    cancellation.abort(new DOMException('受控 Chrome 已关闭。', 'AbortError'));
  }
  context.on('close', contextClosed);
  cancellation.signal.addEventListener('abort', clearAnswerPlan, { once: true });
  const initialization = context.addInitScript(installTsinghuaResultTracker).then((): void => undefined).catch(cause => {
    trackerError = new Error('清华社评分代次观察器注册失败，禁止继续自动作答。', { cause });
    failure(trackerError);
  }).finally(() => { resultReads.delete(initialization); });
  resultReads.add(initialization);
  const initialPages = context.pages().filter(candidate => !candidate.isClosed());
  if (initialPages.length === 1) attach(initialPages[0]!);

  const controller: TsinghuaController = {
    snapshot: () => tsinghuaStateSchema.parse(state),
    resumeUrl: () => resume,
    isSettled: () => tasks.size === 0 && courseReads.size === 0 && resultReads.size === 0 && stopTask === null,
    open(): Promise<void> {
      const operation = begin();
      return track((async () => {
        update({ phase: 'opening', errorCode: null, message: '正在打开清华社旧版首页并读取官方课程入口。' });
        const selected = await choosePage(operation);
        const existing = parseTsinghuaDetailUrl(selected.url());
        if (existing) { resume = existing.url; update({ courseId: existing.courseId }); }
        if (!existing && exerciseCourseId(selected.url()) === null) await navigate(TSINGHUA_LEGACY_HOME, operation);
        await discover(operation);
      })(), operation);
    },
    verifySlider(): Promise<void> {
      const operation = begin();
      return track((async () => {
        const selected = current(operation);
        update({ phase: 'awaiting-login', errorCode: null, message: '正在验证当前官网登录滑块，通过后使用页面已有填写内容单次点击登录；不读取密码、不刷新挑战、不重试。' });
        await verifyTsinghuaLoginSlider(selected, operation.signal);
        check(operation);
        await submitTsinghuaLogin(selected, operation.signal);
        await until(operation, async () => {
          const location = new URL(selected.url());
          if (location.origin !== 'https://www.tsinghuaelt.com') throw new DOMException('官网登录跳转离开清华社 HTTPS 域；已停止，未操作外部页面。', 'SecurityError');
          if (location.pathname === '/legacy/login') return false;
          await selected.waitForLoadState('domcontentloaded', { timeout: 5000 });
          check(operation);
          return !await tsinghuaLoginVisible(selected);
        }, '等待官网确认登录；若停留登录页，请检查官网提示及已有填写内容，软件不会再次点击登录');
        check(operation);
        await discover(operation);
      })(), operation);
    },
    selectCourse(courseId: number): Promise<void> {
      const operation = begin();
      return track((async () => {
        const course = courses.find(value => value.id === courseId);
        if (!course) throw new RangeError('所选课程 ID 不属于当前观察的官网课程列表，请先刷新；未构造未知课程 URL。');
        await enterCourse(course, operation);
      })(), operation);
    },
    async start(): Promise<void> {
      const operation = begin();
      if (!script.installed || !script.enabled || script.adapterVersion !== 'swu-legacy-1' || script.sourceDigest === null || script.executionDigest === null) throw new DOMException('请先安装并启用固定摘要的清华社适配脚本，再开始课程任务。', 'InvalidStateError');
      current(operation);
      if (state.courseId === null || exerciseCourseId(page!.url()) !== state.courseId) throw new DOMException('请先在软件中打开并确认唯一课程练习。', 'InvalidStateError');
      update({ runId: randomUUID(), phase: 'running', errorCode: null, message: '已登记课程后台任务；可以独立停止或读取状态。' });
      const task = track(run(operation), operation);
      void task.catch(() => { /* The original rejection is reported in the observable task state. */ });
    },
    stop(): Promise<void> {
      if (stopTask) return stopTask;
      epoch += 1;
      resultGeneration += 1;
      cancellation.abort(new DOMException('用户请求停止清华社运行。', 'AbortError'));
      update({ phase: 'stopping', result: null, message: '已撤销后续自动动作与当前评分代次；正在等待已接受的页面任务结算。' });
      stopTask = (async () => {
        try {
          const results = await Promise.allSettled([...(page ? [stopTsinghuaHooks(page)] : []), ...tasks, ...courseReads, ...resultReads]);
          const failures = results.filter((value): value is PromiseRejectedResult => value.status === 'rejected').map(value => value.reason instanceof Error ? value.reason : new TypeError('清华社任务结算出现非标准错误。'));
          if (failures.length) throw new AggregateError(failures, '清华社停止时已接受的任务报告错误，请核对官网提交结果。');
          update({ phase: 'stopped', owned: false, message: '清华社自动任务已停止且在途任务已结算；官网已收到的提交不能撤回，资料保留。', errorCode: null });
        } catch (cause) { const error = cause instanceof Error ? cause : new TypeError('清华社停止出现非标准错误。'); failure(error); throw error; }
      })().finally(() => { stopTask = null; });
      return stopTask;
    },
    refresh(): Promise<void> {
      const operation = begin();
      return track((async () => { await choosePage(operation); await discover(operation); })(), operation);
    },
    readScore(): Promise<void> {
      const operation = begin();
      return track((async () => {
        const selected = current(operation);
        if (state.courseId === null) throw new DOMException('成绩查询必须先明确选择课程。', 'InvalidStateError');
        if (exerciseCourseId(selected.url()) !== null) {
          await Promise.all([...resultReads]);
          check(operation);
          const question = await sample(operation);
          const requested = await resultContext(selected);
          check(operation);
          const record = cachedRecord;
          if (hasRecordedScore(question) && state.result?.source === 'exercise-submit') {
            update({ phase: question.answered === true ? 'ready' : 'awaiting-result', message: state.result.message + ' 已保留本题官网提交分数；已作答页面可以继续课程，未主动重交或录音。' });
            return;
          }
          if (!requested || !record || record.identity.path !== resultView?.path || record.identity.pageId !== requested.pageId || record.identity.exerciseId !== requested.exerciseId || record.identity.courseId !== requested.courseId) {
            update({ phase: 'awaiting-result', result: null, message: '尚未捕获与当前题独立匹配的官方记录；请在官网正常加载本题或本人完成录音及提交后再读取。不会自动补交、启动录音或用综合成绩冒充本题评分。' });
            return;
          }
          const current = await resultContext(selected);
          check(operation);
          if (!current) throw new DOMException('读取记录时当前题身份已变化。', 'InvalidStateError');
          const parsed = parseTsinghuaRecordResult(record.value, { requested, current, observedAt: record.observedAt, httpStatus: record.httpStatus });
          publishResult({ ...parsed, result: { ...parsed.result, message: '官网已加载的本题历史记录；不是刚才录音的新分证明。' + parsed.result.message } });
          update({ phase: question.answered === true && hasRecordedScore(question) ? 'ready' : 'awaiting-result' });
          return;
        }
        update({ phase: 'awaiting-result', message: '当前不在题目页，读取官网课程综合成绩；不会冒充题级或口语分。' });
        const result = await readTsinghuaCourseScore(selected, state.courseId);
        check(operation);
        update({ result, phase: 'ready', message: result.message });
      })(), operation);
    },
    async close(): Promise<void> {
      if (closed) return;
      closing = true;
      try {
        await controller.stop();
        if (page) { page.off('request', observeRequest); page.off('request', observeCatalog); page.off('requestfinished', observeCourseList); page.off('requestfinished', observeExerciseResult); page.off('close', invalidated); page.off('crash', invalidated); }
        context.off('close', contextClosed);
        closed = true;
      } finally { closing = false; }
    }
  };
  return controller;
}
