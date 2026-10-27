import { createHash } from 'node:crypto';
import { tsinghuaExternalScript } from '../shared/ocs-external';
import type { TsinghuaQuestionKind } from '../shared/ocs-tsinghua';
import type { TsinghuaAnswerPlan } from './tsinghua-answers';

export const TSINGHUA_ADAPTER_VERSION = 'swu-legacy-1';

export interface TsinghuaScriptAdaptation {
  content: string;
  adapterVersion: 'swu-legacy-1';
  sourceDigest: string;
  executionDigest: string;
}

export interface LegacyInspection {
  questionKey: string;
  kind: TsinghuaQuestionKind;
  text: string;
  referenceText: string;
  answered: boolean | null;
}

export interface LegacyRunResult {
  outcome: 'submitted' | 'already-answered';
  kind: TsinghuaQuestionKind;
}

/** Validate the external hook boundary and copy its answers before scheduling any work. */
export function parseLegacyAnswerPlan(value: TsinghuaAnswerPlan, currentKind: TsinghuaQuestionKind): TsinghuaAnswerPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('TSH_PLAN_REQUIRED: runOrdinary requires an explicit official answer plan.');
  if (!['exerciseId', 'kind', 'answers'].every(field => Object.prototype.hasOwnProperty.call(value, field))) throw new TypeError('TSH_PLAN_FIELDS: exerciseId, kind and answers are required own fields.');
  if (typeof value.exerciseId !== 'string' || !value.exerciseId.trim() || value.exerciseId !== value.exerciseId.trim() || value.exerciseId.length > 200) throw new TypeError('TSH_PLAN_EXERCISE: exerciseId must be a nonempty, bounded official exercise identity.');
  const ordinaryKinds: readonly TsinghuaQuestionKind[] = ['single', 'multiple', 'judge', 'dropdown', 'fill', 'drag', 'listen_fill'];
  if (!ordinaryKinds.includes(currentKind) || !ordinaryKinds.includes(value.kind)) throw new TypeError('TSH_PLAN_KIND: Only ordinary question kinds are accepted; speech, media and unknown plans are prohibited.');
  if (value.kind !== currentKind) throw new TypeError('TSH_PLAN_KIND_MISMATCH: The answer plan does not match the currently inspected question kind.');
  if (!Array.isArray(value.answers) || value.answers.length === 0 || value.answers.length > 1000) throw new TypeError('TSH_PLAN_ANSWERS: A complete nonempty answer array of at most 1000 fields is required.');
  const answers: string[] = [];
  for (const answer of value.answers) {
    if (typeof answer !== 'string' || !answer.trim() || answer.length > 16000) throw new TypeError('TSH_PLAN_ANSWER: Every field requires a nonempty bounded string; missing objective answers cannot be invented.');
    answers.push(answer);
  }
  return { exerciseId: value.exerciseId, kind: currentKind, answers };
}

export interface LegacyFillAnswer {
  kind: 'provided' | 'open';
  text: string;
}

/** An explicit platform open-answer marker permits nonempty input, not a correctness claim. */
export function parseLegacyFillAnswer(value: string): LegacyFillAnswer {
  const text = value.trim();
  if (!text) throw new TypeError('TSH_ANSWER_UNAVAILABLE: An empty objective answer cannot be replaced with placeholder text.');
  const open = /^(?:\*ANY\*|(?:answers?|responses?)\s+(?:will|may)\s+vary[.!]?|(?:参考答案|答案)?(?:略|省略)[。.!]?)$/i.test(text);
  return open ? { kind: 'open', text: 'This is my response.' } : { kind: 'provided', text };
}

export interface LegacyScoreResponse {
  scope: 'course';
  requestedCourseId: string;
  questionKey: null;
  accepted: null;
  object: {
    courseScoreVo: { score: number };
    stuScoreVo: { studyScore: number; complete: number };
  };
}

export type LegacyJsonValue = null | boolean | number | string | LegacyJsonValue[] | { [key: string]: LegacyJsonValue };
type JsonValue = LegacyJsonValue;

/**
 * The pinned 2.3.0 legacy engine reads these aggregate fields at source lines
 * 3283-3313. No question identity, speech assessment or acceptance contract is
 * established there. The requested course binding is not a server-confirmed ID.
 * Additional response fields are deliberately never forwarded to the host.
 */
export function parseLegacyCourseScore(value: LegacyJsonValue, requestedCourseId: string): LegacyScoreResponse {
  function object(fieldValue: LegacyJsonValue | undefined, field: string): { [key: string]: LegacyJsonValue } {
    if (!fieldValue || typeof fieldValue !== 'object' || Array.isArray(fieldValue)) throw new TypeError('TSH_SCORE_RESPONSE: Expected an object at ' + field + '.');
    return fieldValue;
  }
  function number(fieldValue: LegacyJsonValue | undefined, field: string): number {
    if (typeof fieldValue !== 'number' || !Number.isFinite(fieldValue) || fieldValue < 0) throw new TypeError('TSH_SCORE_RESPONSE: Expected a finite nonnegative number at ' + field + '.');
    return fieldValue;
  }
  if (!/^[1-9]\d*$/.test(requestedCourseId) || !Number.isSafeInteger(Number(requestedCourseId))) throw new TypeError('TSH_SCORE_COURSE: A safe positive requested course ID is required.');
  const response = object(value, 'response');
  if (response.blocked === true) throw new Error('TSH_SCORE_RATE_LIMIT: The platform blocked this aggregate score query; wait before requesting again.');
  const body = object(response.object, 'object');
  const course = object(body.courseScoreVo, 'object.courseScoreVo');
  const student = object(body.stuScoreVo, 'object.stuScoreVo');
  const score = number(course.score, 'object.courseScoreVo.score');
  const studyScore = number(student.studyScore, 'object.stuScoreVo.studyScore');
  const complete = number(student.complete, 'object.stuScoreVo.complete');
  if (complete > 100) throw new RangeError('TSH_SCORE_COMPLETION: The course completion percentage must not exceed 100.');
  return { scope: 'course', requestedCourseId, questionKey: null, accepted: null, object: { courseScoreVo: { score }, stuScoreVo: { studyScore, complete } } };
}
export interface LegacyViewBinding {
  pathname: string;
  fingerprint: string;
  renderRevision: string;
  questionKey: string;
}

/** Bind a local view identity, never a server assessment, to one observed render. */
export function bindLegacyQuestionView(previous: LegacyViewBinding | null, pathname: string, fingerprint: string, renderRevision: string, freshKey: string): LegacyViewBinding {
  if (!/^\/legacy\/course-study-student\//.test(pathname) || !fingerprint.trim() || !renderRevision || !freshKey) throw new TypeError('TSH_QUESTION_IDENTITY: A legacy exercise path and an observed nonempty render are required.');
  if (previous?.pathname !== pathname && previous?.fingerprint === fingerprint) throw new Error('TSH_QUESTION_TRANSITION: The route changed but the previous exercise content is still rendered; wait for the new question or an officially bound exercise plan.');
  if (previous?.pathname === pathname && previous.fingerprint === fingerprint) return { ...previous, renderRevision };
  return { pathname, fingerprint, renderRevision, questionKey: freshKey };
}

interface LegacyDependencies {
  choice: (multiple: boolean) => Promise<string>;
  judge: () => Promise<string>;
  dropdown: () => Promise<string>;
  fill: () => Promise<string>;
  drag: () => Promise<string>;
  listenFill: () => Promise<string>;
  score: (signal: AbortSignal) => Promise<JsonValue>;
  parseScore: (value: LegacyJsonValue, requestedCourseId: string) => LegacyScoreResponse;
  parseFillAnswer: (value: string) => LegacyFillAnswer;
  parsePlan: (value: TsinghuaAnswerPlan, currentKind: TsinghuaQuestionKind) => TsinghuaAnswerPlan;
  bindView: (previous: LegacyViewBinding | null, pathname: string, fingerprint: string, renderRevision: string, freshKey: string) => LegacyViewBinding;
}
interface LegacyAdapter {
  adapterVersion: 'swu-legacy-1';
  sourceDigest: string;
  inspect: () => LegacyInspection;
  runOrdinary: (plan: TsinghuaAnswerPlan) => Promise<LegacyRunResult>;
  stop: () => Promise<void>;
  readScore: () => Promise<LegacyScoreResponse>;
  selectAll: (selector: string, parent: ParentNode | null | undefined) => Element[];
  selectOne: (selector: string, parent: ParentNode | null | undefined) => Element | null;
  sleep: (milliseconds: number) => Promise<void>;
  assertTarget: (element: Element | null) => void;
  fillElement: (element: Element, value: string) => void;
  assertActive: () => void;
  validateAnswers: (answers: string[]) => void;
  planAnswers: () => string[];
  fillAnswer: (value: string) => string;
  submit: () => Promise<boolean>;
}

/** This connector is serialized into the verified external script, never evaluated in the host. */
function connectLegacy(dependencies: LegacyDependencies, sourceDigest: string): LegacyAdapter {
  const adapterVersion = 'swu-legacy-1';
  const typeSelectors: ReadonlyArray<readonly [TsinghuaQuestionKind, string]> = [
    ['video', 'lib-video-exercise-cs-study, lib-video-exercise-cs-stu-info'],
    ['listen_repeat', 'lib-listen-and-repeat-exercise-cs-study, lib-listen-and-repeat-exercise-cs-stu-info, .lib-listen-container'],
    ['oral', 'lib-oral-brief-exercise-cs-study, lib-oral-brief-exercise-cs-stu-info, lib-free-assess-exercise-cs-study, lib-free-assess-exercise-cs-stu-info, lib-paragraph-assess-exercise-cs-study, lib-paragraph-assess-exercise-cs-stu-info'],
    ['roleplay', 'lib-role-play-exercise-cs-study, lib-role-play-exercise-cs-stu-info, .lib-role-select-item'],
    ['judge', 'lib-judge-exercise-cs-study, lib-judge-exercise-cs-stu-info, .lib-judge-radio'],
    ['dropdown', 'lib-drop-down-exercise-cs-study, lib-drop-down-exercise-cs-stu-info, .lib-drop-down-container, .lib-drop-down-item-select'],
    ['fill', 'lib-fill-blank-exercise-cs-study, lib-fill-blank-exercise-cs-stu-info, .lib-fill-blank-do-input-left'],
    ['drag', 'lib-drag-drop-one-exercise-cs-study, lib-drag-drop-one-exercise-cs-stu-info, lib-drag-drop-many-exercise-cs-study, lib-drag-drop-many-exercise-cs-stu-info, lib-paragraph-drop-exercise-cs-study, lib-paragraph-drop-exercise-cs-stu-info, .lib-drag-box, .lib-drag-item'],
    ['multiple', 'lib-multiple-choice-exercise-cs-study, lib-multiple-choice-exercise-cs-stu-info'],
    ['single', 'lib-single-choice-exercise-cs-study, lib-single-choice-exercise-cs-stu-info'],
    ['listen_fill', '.lib-textarea-container, .img-blank-answer']
  ];
  let epoch = 0;
  let session: { epoch: number; controller: AbortController; url: string; root: Element | null; kind: TsinghuaQuestionKind; phase: 'answering' | 'submitting'; plan: TsinghuaAnswerPlan | null } | null = null;
  let pending: Promise<LegacyRunResult | LegacyScoreResponse> | null = null;
  let lastView: LegacyViewBinding | null = null;
  let boundExercise: { pathname: string; exerciseId: string; questionKey: string } | null = null;

  function visible(element: Element): boolean {
    if (!element.isConnected || element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    for (let current: Element | null = element; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) return false;
    }
    return element.getClientRects().length > 0;
  }
  function assertOrigin(): void {
    if (location.origin !== 'https://www.tsinghuaelt.com' || !/^\/legacy(?:\/|$)/.test(location.pathname)) throw new Error('TSH_ORIGIN: Expected the official HTTPS legacy document.');
  }
  function exerciseRoot(): Element {
    assertOrigin();
    const roots = Array.from(document.querySelectorAll('app-course-task-stu')).filter(visible);
    if (roots.length !== 1 || !roots[0]) throw new Error('TSH_EXERCISE_ROOT: Expected exactly one visible app-course-task-stu; open one exercise and refresh.');
    return roots[0];
  }
  function allWithin(root: ParentNode, selector: string): Element[] {
    return Array.from(root.querySelectorAll(selector)).filter(visible);
  }
  /** Public bundle 8c9e6cb8, offsets 10406480-10412600: R1/A1/L1 bind these structures, not labels. */
  function actionState(root: Element): { answered: boolean | null; submit: HTMLButtonElement | null } {
    if (!root.isConnected) throw new Error('TSH_DOCUMENT_CHANGED: The inspected exercise is detached.');
    const bars = allWithin(root, '.wy-course-btn-right');
    if (bars.length !== 1 || !bars[0]) return { answered: null, submit: null };
    // The separate T1 verification widget must remain under the user's control.
    if (allWithin(root, '#wyy-submit, #ic-submit').length > 0) return { answered: null, submit: null };
    const retry = allWithin(bars[0], ':scope > button.wy-btn:not(.mg-l)');
    const primary = allWithin(bars[0], ':scope > button.wy-btn.mg-l');
    const result = allWithin(root, '.task-content > lib-adap-exercise-cs-stu-info');
    const recorded = allWithin(root, '.do-time');
    if (retry.length > 1 || result.length > 1 || recorded.length > 1) throw new Error('TSH_ACTION_AMBIGUOUS: Multiple official exercise result/action structures are visible.');
    if (retry.length === 1 || result.length === 1 || recorded.length === 1) return { answered: true, submit: null };
    // ReChallenge and goal-summary also use mg-l; never choose by position when they coexist.
    const study = allWithin(root, '.task-content > lib-adap-exercise-cs-study');
    if (primary.length === 1 && primary[0] instanceof HTMLButtonElement && !primary[0].disabled && study.length === 1) return { answered: false, submit: primary[0] };
    return { answered: null, submit: null };
  }
  function answered(root: Element): boolean | null {
    return actionState(root).answered;
  }
  function activeMedia(root: Element): HTMLMediaElement[] {
    return Array.from(root.querySelectorAll('audio, video')).filter((element): element is HTMLMediaElement => {
      if (!(element instanceof HTMLMediaElement)) return false;
      if (visible(element)) return true;
      const player = element instanceof HTMLAudioElement ? element.closest('lib-audio-player, .show-audio') : null;
      return player !== null && visible(player);
    });
  }
  function classify(root: Element): TsinghuaQuestionKind {
    const kinds = typeSelectors.filter(([, selector]) => allWithin(root, selector).length > 0).map(([kind]) => kind);
    if (kinds.length === 1 && kinds[0]) return kinds[0];
    if (kinds.length > 1) return 'unknown';
    if (allWithin(root, '.lib-single-box').length > 0) return allWithin(root, '.lib-single-item-img img[src*="no-choices"]').length > 0 ? 'multiple' : 'single';
    const media = activeMedia(root);
    if (media.some(element => element instanceof HTMLVideoElement)) return 'video';
    if (media.some(element => element instanceof HTMLAudioElement)) return 'audio';
    return 'unknown';
  }
  function inspect(): LegacyInspection {
    if (boundExercise && boundExercise.pathname !== location.pathname) {
      epoch++;
      session?.controller.abort();
      boundExercise = null;
    }
    const root = exerciseRoot();
    function questionText(element: Element): string {
      const snapshot = element.cloneNode(true);
      if (!(snapshot instanceof Element)) throw new TypeError('TSH_QUESTION_SNAPSHOT: The exercise snapshot must be an element.');
      snapshot.querySelectorAll('button, input, textarea, [contenteditable], .do-time, .lib-edit-score, .lib-single-cs-answer, .lib-judge-info, .lib-judge-info-text, .lib-drag-answer, .lib-drag-answer-box, [class*="score"]').forEach(node => node.remove());
      return (snapshot.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 16000);
    }
    const text = questionText(root);
    const references = allWithin(root, '.exercise-content, .default-stem-content, .exercise-directiveContent, .lib-listen-item');
    const referenceText = references.map(questionText).filter(Boolean).join('\n').slice(0, 16000);
    const kind = classify(root);
    const fingerprint = JSON.stringify([kind, referenceText || text]);
    // Official exercise identity survives study/result component replacement and record annotations.
    const view: LegacyViewBinding = boundExercise
      ? { pathname: location.pathname, fingerprint, renderRevision: boundExercise.exerciseId, questionKey: boundExercise.questionKey }
      : dependencies.bindView(lastView, location.pathname, fingerprint, 'question-content', crypto.randomUUID());
    lastView = view;
    return { questionKey: view.questionKey, kind, text, referenceText, answered: answered(root) };
  }
  function assertActive(): void {
    const current = session;
    if (!current || current.epoch !== epoch || current.controller.signal.aborted) throw new DOMException('TSH_CANCELLED: The operation was stopped.', 'AbortError');
    if (location.href !== current.url || (current.plan && (!boundExercise || boundExercise.pathname !== location.pathname || boundExercise.exerciseId !== current.plan.exerciseId))) {
      epoch++;
      current.controller.abort();
      throw new DOMException('TSH_DOCUMENT_CHANGED: The route or official exercise identity changed; the previous operation is invalid.', 'AbortError');
    }
    assertOrigin();
    if (current.root && !current.root.isConnected) throw new Error('TSH_DOCUMENT_CHANGED: The exercise root is detached; start a new operation after refreshing its state.');
    if (current.root && (exerciseRoot() !== current.root || (classify(current.root) !== current.kind && !(current.phase === 'submitting' && answered(current.root) === true)))) throw new Error('TSH_QUESTION_CHANGED: The active exercise identity or question kind changed.');
  }
  function assertTarget(element: Element | null): void {
    assertActive();
    const root = session?.root;
    if (!root || !element || !visible(element) || (!root.contains(element) && !element.closest('.ant-select-dropdown:not(.ant-select-dropdown-hidden)'))) throw new Error('TSH_TARGET: The action target is not a visible element of the active exercise or its open dropdown.');
    if (element instanceof HTMLButtonElement && element.disabled) throw new Error('TSH_TARGET_DISABLED: The platform has disabled this action.');
  }
  function fillElement(element: Element, value: string): void {
    assertTarget(element);
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      if (element.disabled || element.readOnly) throw new Error('TSH_FIELD_DISABLED: The platform input is disabled or read-only.');
      const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (!setter) throw new Error('TSH_FIELD_SETTER: The native input setter is unavailable.');
      setter.call(element, value);
    } else if (element instanceof HTMLElement && element.isContentEditable) {
      element.textContent = value;
    } else {
      throw new Error('TSH_FIELD_TYPE: Only native inputs and active contenteditable fields can be filled.');
    }
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    for (const event of ['change', 'blur', 'keyup']) element.dispatchEvent(new Event(event, { bubbles: true }));
  }
  function selectAll(selector: string, parent: ParentNode | null | undefined): Element[] {
    assertActive();
    const root = session?.root;
    if (!root) throw new Error('TSH_QUERY: An exercise operation is required for DOM access.');
    if (parent) {
      if (!(parent instanceof Element) || (!root.contains(parent) && parent !== root && !parent.closest('.ant-select-dropdown:not(.ant-select-dropdown-hidden)'))) throw new Error('TSH_QUERY_SCOPE: The query parent is outside the current exercise.');
      return allWithin(parent, selector);
    }
    if (selector.startsWith('.ant-select-dropdown')) return allWithin(document, selector);
    return allWithin(root, selector);
  }
  function selectOne(selector: string, parent: ParentNode | null | undefined): Element | null {
    return selectAll(selector, parent)[0] ?? null;
  }
  function sleep(milliseconds: number): Promise<void> {
    assertActive();
    const signal = session!.controller.signal;
    return new Promise((resolve, reject) => {
      const abort = (): void => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new DOMException('TSH_CANCELLED: Pending exercise delay was cancelled.', 'AbortError')); };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', abort);
        try { assertActive(); resolve(); } catch (error) { reject(error); }
      }, milliseconds);
      signal.addEventListener('abort', abort, { once: true });
    });
  }
  function planAnswers(): string[] {
    assertActive();
    const plan = session!.plan;
    if (!plan || plan.kind !== session!.kind) throw new TypeError('TSH_PLAN_REQUIRED: No validated answer plan is bound to this operation.');
    return [...plan.answers];
  }
  function fillAnswer(value: string): string {
    assertActive();
    if (session!.kind !== 'fill' && session!.kind !== 'listen_fill') throw new TypeError('TSH_OPEN_ANSWER_KIND: Open nonempty input is only permitted for the reviewed text-fill path.');
    return dependencies.parseFillAnswer(value).text;
  }
  function validateAnswers(answers: string[]): void {
    assertActive();
    if (!answers.length) throw new Error('TSH_ANSWER_UNAVAILABLE: Platform answers or explicit platform open-answer markers are required; no objective answers were invented.');
    const root = session!.root!;
    const kind = session!.kind;
    for (const answer of answers) {
      const parsed = dependencies.parseFillAnswer(answer);
      if (parsed.kind === 'open' && kind !== 'fill' && kind !== 'listen_fill') throw new TypeError('TSH_OPEN_ANSWER_KIND: An open text marker cannot be mapped to an objective choice, judge, dropdown or drag answer.');
    }
    const counts: Partial<Record<TsinghuaQuestionKind, number>> = {
      single: allWithin(root, 'lib-single-choice-exercise-cs-study, lib-single-choice-exercise-tb-study').length || allWithin(root, '.lib-single-box').length,
      multiple: allWithin(root, 'lib-multiple-choice-exercise-cs-study').length || allWithin(root, '.lib-single-box').length,
      judge: allWithin(root, '.lib-judge-left-item').length,
      dropdown: allWithin(root, '.lib-drop-down-item-select nz-select, .lib-drop-down-item-select .ant-select, .ant-select').length,
      fill: allWithin(root, '.lib-fill-blank-do-input-left, .lib-textarea-container textarea, .img-blank-answer input').length,
      listen_fill: allWithin(root, '.lib-textarea-container textarea, .img-blank-answer input').length,
      drag: allWithin(root, '.lib-drag-item-place, .lib-drop-zone, [class*="drop-zone"], .blank, .lib-drag-ffzz').length
    };
    if (counts[kind] !== answers.length) throw new Error('TSH_ANSWER_COUNT: Platform answer count does not match all active question fields.');
    if (kind === 'single' || kind === 'multiple') {
      const groups = allWithin(root, 'lib-single-choice-exercise-cs-study, lib-single-choice-exercise-tb-study, lib-multiple-choice-exercise-cs-study');
      const boxes = groups.length ? groups : allWithin(root, '.lib-single-box');
      for (const [index, answer] of answers.entries()) {
        const group = boxes[index];
        if (!group || !/^[A-J]+$/.test(answer) || (kind === 'single' && answer.length !== 1) || new Set(answer).size !== answer.length || [...answer].some(letter => letter.charCodeAt(0) - 65 >= allWithin(group, '.lib-single-item').length)) throw new Error('TSH_CHOICE_ANSWER: A platform answer cannot be mapped unambiguously to the active options.');
      }
    }
    if (kind === 'drag') {
      const items = allWithin(root, '.lib-drag-item, [class*="drag-item"]');
      if (answers.some(answer => items.filter(item => item.textContent?.trim() === answer).length !== 1)) throw new Error('TSH_DRAG_ANSWER: A platform answer does not identify exactly one draggable item.');
    }
  }
  async function submit(): Promise<boolean> {
    assertActive();
    const root = session!.root!;
    const media = activeMedia(root);
    if (media.some(element => element.error !== null)) throw new Error('TSH_MEDIA_FAILED: The official exercise media reports a playback error.');
    if (media.some(element => !element.ended)) throw new Error('TSH_MEDIA_PENDING: Wait for normal audio/video playback to end before submitting.');
    const target = actionState(root).submit;
    if (!target) throw new Error('TSH_SUBMIT_UNAVAILABLE: The official plain submit structure is missing, ambiguous, or replaced by a verification widget; no alternative action was clicked.');
    assertTarget(target);
    session!.phase = 'submitting';
    target.click();
    for (let attempt = 0; attempt < 60; attempt++) {
      await sleep(250);
      if (answered(root) === true) return true;
    }
    throw new Error('TSH_SUBMIT_UNCONFIRMED: The platform did not render its recorded/result state within 15 seconds. No automatic retry was performed; this does not establish correctness.');
  }
  function exclusive<T extends LegacyRunResult | LegacyScoreResponse>(root: Element | null, kind: TsinghuaQuestionKind, work: () => Promise<T>): Promise<T> {
    if (pending) return Promise.reject(new Error('TSH_OPERATION_BUSY: Wait for the previous operation or stop to settle before restarting.'));
    assertOrigin();
    epoch++;
    const current: NonNullable<typeof session> = { epoch, controller: new AbortController(), url: location.href, root, kind, phase: 'answering', plan: null };
    session = current;
    const task = Promise.resolve().then(work).finally(() => { if (session === current) session = null; pending = null; });
    pending = task;
    return task;
  }
  function runOrdinary(plan: TsinghuaAnswerPlan): Promise<LegacyRunResult> {
    if (!plan || typeof plan !== 'object') throw new TypeError('TSH_PLAN_REQUIRED: runOrdinary requires an explicit official answer plan.');
    const root = exerciseRoot();
    const kind = classify(root);
    const verified = dependencies.parsePlan(plan, kind);
    const pathname = location.pathname;
    const sameExercise = boundExercise?.pathname === pathname && boundExercise.exerciseId === verified.exerciseId;
    if (boundExercise && !sameExercise) {
      epoch++;
      session?.controller.abort();
    }
    const questionKey = sameExercise && boundExercise
      ? boundExercise.questionKey
      : !boundExercise && lastView?.pathname === pathname ? lastView.questionKey : crypto.randomUUID();
    boundExercise = { pathname, exerciseId: verified.exerciseId, questionKey };
    inspect();
    return exclusive(root, kind, async () => {
      session!.plan = verified;
      assertActive();
      if (kind === 'oral' || kind === 'listen_repeat' || kind === 'roleplay') throw new Error('TSH_MANUAL_RECORDING: Use the official recorder yourself and wait for the official assessment; automatic recording is disabled.');
      if (kind === 'unknown' || kind === 'audio' || kind === 'video' || kind === 'reading') throw new Error('TSH_NOT_ORDINARY: This exercise is unknown, conflicting, or requires native media/manual handling.');
      const state = answered(root);
      if (state === true) return { outcome: 'already-answered', kind };
      if (state !== false) throw new Error('TSH_ACTION_STATE: The official exercise action structure is ambiguous, loading, or requires personal verification. No field was changed.');
      let result: string;
      switch (kind) {
        case 'single': result = await dependencies.choice(false); break;
        case 'multiple': result = await dependencies.choice(true); break;
        case 'judge': result = await dependencies.judge(); break;
        case 'dropdown': result = await dependencies.dropdown(); break;
        case 'fill': result = await dependencies.fill(); break;
        case 'drag': result = await dependencies.drag(); break;
        case 'listen_fill': result = await dependencies.listenFill(); break;
      }
      assertActive();
      if (result === 'no-answer') throw new Error('TSH_ANSWER_UNAVAILABLE: No complete platform answer is visible; await the user or a separately authorized answer source. Random guessing and implicit AI are disabled.');
      if (result !== 'done' || answered(root) !== true) throw new Error('TSH_SOLVER_UNCONFIRMED: The reused solver did not produce a confirmed platform answer; result=' + result + '.');
      return { outcome: 'submitted', kind };
    });
  }
  async function stop(): Promise<void> {
    epoch++;
    session?.controller.abort();
    const task = pending;
    if (task) {
      try { await task; } catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) throw error; }
    }
  }
  function readScore(): Promise<LegacyScoreResponse> {
    return exclusive(null, 'unknown', async () => {
      assertActive();
      const pathname = new URL(session!.url).pathname;
      const match = /^\/legacy\/course-study-student\/[1-9]\d*\/([1-9]\d*)\//.exec(pathname) ?? /^\/legacy\/course-student\/([1-9]\d*)\/study\/?$/.exec(pathname);
      const requestedCourseId = match?.[1];
      if (!requestedCourseId) throw new TypeError('TSH_SCORE_COURSE: Open an observed legacy course detail or exercise route before querying aggregate scores.');
      const response = await dependencies.score(session!.controller.signal);
      assertActive();
      return dependencies.parseScore(response, requestedCourseId);
    });
  }
  return { adapterVersion, sourceDigest, inspect, runOrdinary, stop, readScore, selectAll, selectOne, sleep, assertTarget, fillElement, assertActive, validateAnswers, planAnswers, fillAnswer, submit };
}

function replaceOnce(source: string, search: string, replacement: string, label: string): string {
  const index = source.indexOf(search);
  if (index < 0 || source.indexOf(search, index + search.length) >= 0) throw new Error('TSH_ADAPTER_ANCHOR: Expected exactly one ' + label + '.');
  return source.slice(0, index) + replacement + source.slice(index + search.length);
}

function transformFunction(source: string, signature: string, transform: (body: string) => string): string {
  const start = source.indexOf(signature);
  if (start < 0 || source.indexOf(signature, start + signature.length) >= 0) throw new Error('TSH_ADAPTER_FUNCTION: Expected exactly one ' + signature + '.');
  const end = source.indexOf('\n    }', start + signature.length);
  if (end < 0) throw new Error('TSH_ADAPTER_FUNCTION: Missing complete boundary for ' + signature + '.');
  const body = source.slice(start, end + '\n    }'.length);
  return source.slice(0, start) + transform(body) + source.slice(end + '\n    }'.length);
}

function removeBetween(source: string, startAnchor: string, endAnchor: string, replacement: string): string {
  const start = source.indexOf(startAnchor);
  const end = source.indexOf(endAnchor, start + startAnchor.length);
  if (start < 0 || end < 0 || source.indexOf(startAnchor, start + startAnchor.length) >= 0 || source.indexOf(endAnchor, end + endAnchor.length) >= 0) throw new Error('TSH_ADAPTER_RANGE: Expected unique ordered solver boundaries.');
  return source.slice(0, start) + replacement + source.slice(end);
}

/** Preserve the downloaded GPL source identity; only the pinned source receives an in-memory execution variant. */
export function adaptTsinghuaScript(content: string, digest: string): TsinghuaScriptAdaptation {
  const actual = createHash('sha256').update(content).digest('hex');
  if (digest !== tsinghuaExternalScript.digest || actual !== digest) throw new Error('TSH_ADAPTER_DIGEST: The adapter requires the reviewed 2.3.0 source SHA-256; expected=' + tsinghuaExternalScript.digest + ', declared=' + digest + ', actual=' + actual + '.');
  const startAnchor = 'function __TSH_OLD_ENGINE__() {';
  const endAnchor = '\n    setTimeout(mkUI, 1500);\n\n}';
  const start = content.indexOf(startAnchor);
  const end = content.indexOf(endAnchor, start);
  if (start < 0 || end < 0 || content.indexOf(startAnchor, start + startAnchor.length) >= 0 || content.indexOf(endAnchor, end + endAnchor.length) >= 0) throw new Error('TSH_ADAPTER_ENGINE: Expected exactly one complete legacy engine boundary.');
  let legacy = content.slice(start, end + endAnchor.length);
  legacy = replaceOnce(legacy, 'const $ = (s, p) => Array.from((p || document).querySelectorAll(s));', 'const $ = (s, p) => swuLegacy.selectAll(s, p);', 'scoped query-all helper');
  legacy = replaceOnce(legacy, 'const $1 = (s, p) => (p || document).querySelector(s);', 'const $1 = (s, p) => swuLegacy.selectOne(s, p);', 'scoped query-one helper');
  legacy = replaceOnce(legacy, 'const sleep = ms => new Promise(r => setTimeout(r, ms));', 'const sleep = ms => swuLegacy.sleep(ms);', 'cancellable delay');
  legacy = replaceOnce(legacy, 'const rw = () => WORDS[rnd(0, WORDS.length)];', "const rw = () => { throw new Error('TSH_RANDOM_DISABLED: A complete platform answer is required.'); };", 'random-word prohibition');
  for (const name of ['click', 'clickSeq']) legacy = transformFunction(legacy, '    function ' + name + '(el) {', body => replaceOnce(body, '        if (!el) return false;', '        swuLegacy.assertTarget(el);', name + ' cancellation guard'));
  legacy = transformFunction(legacy, '    function clickSeq(el) {', body => replaceOnce(replaceOnce(body, '        try {', '', 'click sequence exception boundary'), '        } catch (e) { click(el); }', '', 'click sequence silent recovery'));
  legacy = transformFunction(legacy, '    function fill(el, val) {', () => '    function fill(el, val) { swuLegacy.assertTarget(el); swuLegacy.fillElement(el, val); }');
  legacy = transformFunction(legacy, '    async function submitSmart() {', () => '    async function submitSmart() { return await swuLegacy.submit(); }');
  legacy = transformFunction(legacy, '    async function clickSubmit() {', () => '    async function clickSubmit() { return await swuLegacy.submit(); }');
  legacy = transformFunction(legacy, '    async function clickRetry() {', () => "    async function clickRetry() { swuLegacy.assertActive(); throw new Error('TSH_RETRY_DISABLED: Automatic retries are not permitted.'); }");
  for (const name of ['solveOral', 'solveListenRepeat', 'solveRoleplay', 'solveVideo']) legacy = transformFunction(legacy, '    async function ' + name + '() {', () => '    async function ' + name + "() { throw new Error('TSH_MANUAL_ONLY: Use native playback or the official personal recording workflow.'); }");
  const specifications: ReadonlyArray<readonly [string, string, string, string, string]> = [
    ['solveChoice(isMultiple)', '        const groups = getQuizGroups();', '        const answers = readChoiceAnswers();', '', 'answers'],
    ['solveJudge()', "        const rows = $('.lib-judge-left-item');", '        const keys = [];', 'judge-columns', 'keys'],
    ['solveDropdown()', '        const sels = $(', '        const keys = [];', '', 'keys'],
    ['solveFill()', '        let inputs = $(', '        let anyVary = false;', '', 'ans'],
    ['solveDrag()', '        for (let i = 0; i < Math.min(items.length, zones.length); i++) {', '        let ans = [];', '', 'ans'],
    ['solveListenFill()', '        const inputs = $(', '        const ans = [];', '', 'ans']
  ];
  for (const [signature, first, last, preamble, answers] of specifications) {
    legacy = transformFunction(legacy, '    async function ' + signature + ' {', body => {
      const columnLine = preamble === 'judge-columns' ? body.match(/^        const colCount = .+;$/m)?.[0] : '';
      if (preamble && !columnLine) throw new Error('TSH_ADAPTER_JUDGE: Missing reviewed judge-column calculation.');
      let result = removeBetween(body, first, last, columnLine ? columnLine + '\n' : '');
      if (signature === 'solveListenFill()') result = replaceOnce(result, '        if (ans.length && await clickRetry()) {', '        swuLegacy.validateAnswers(ans);\n        if (ans.length) {', 'listen-fill answer validation');
      else {
        result = replaceOnce(result, "        if (!await clickRetry()) return 'no-retry';", '        swuLegacy.validateAnswers(' + answers + ');', signature + ' trusted-answer validation');
      }
      if (signature === 'solveDropdown()') result = replaceOnce(result, "            for (const o of opts) {\n                if ((o.textContent || '').trim() === keys[i]) { clickSeq(o); break; }\n            }", "            const matching = opts.filter(option => (option.textContent || '').trim() === keys[i]);\n            if (matching.length !== 1) throw new Error('TSH_DROPDOWN_ANSWER: Expected exactly one platform option for this answer.');\n            clickSeq(matching[0]);", 'exact dropdown answer');
      if (signature === 'solveDrag()') result = replaceOnce(result, '            if (!from || !to) return;', '            swuLegacy.assertTarget(from); swuLegacy.assertTarget(to);', 'drag cancellation guard');
      result = removeBetween(result, last, '        swuLegacy.validateAnswers(' + answers + ');', '        const ' + answers + ' = swuLegacy.planAnswers();\n');
      if (signature === 'solveFill()') result = replaceOnce(result, "const v = ans[i] === '*ANY*' ? rw() : (ans[i] || rw());", 'const v = swuLegacy.fillAnswer(ans[i]);', 'deterministic platform open-answer input');
      if (signature === 'solveListenFill()') result = replaceOnce(result, 'fill(inputs2[i], ans[i] || rw())', 'fill(inputs2[i], swuLegacy.fillAnswer(ans[i]))', 'listen-fill explicit answer input');
      return result;
    });
  }
  legacy = transformFunction(legacy, '    async function fetchScore() {', body => replaceOnce(replaceOnce(body, 'async function fetchScore()', 'async function fetchScore(signal)', 'score cancellation parameter'), "body: '{}' });", "body: '{}', signal });", 'score request signal'));
  const connector = connectLegacy.toString();
  const install = '\n    const swuLegacy = (' + connector + ')({ choice: solveChoice, judge: solveJudge, dropdown: solveDropdown, fill: solveFill, drag: solveDrag, listenFill: solveListenFill, score: fetchScore, parseScore: (' + parseLegacyCourseScore.toString() + '), parseFillAnswer: (' + parseLegacyFillAnswer.toString() + '), parsePlan: (' + parseLegacyAnswerPlan.toString() + '), bindView: (' + bindLegacyQuestionView.toString() + ') }, ' + JSON.stringify(actual) + ');\n    globalThis.__SWU_TSH_LEGACY__ = { adapterVersion: swuLegacy.adapterVersion, sourceDigest: swuLegacy.sourceDigest, inspect: swuLegacy.inspect, runOrdinary: swuLegacy.runOrdinary, stop: swuLegacy.stop, readScore: swuLegacy.readScore };\n';
  legacy = replaceOnce(legacy, '\n    setTimeout(mkUI, 1500);', install, 'controlled hook installation');
  const newEngineAnchor = 'function __TSH_NEW_ENGINE__() {';
  const newEngineStart = content.indexOf(newEngineAnchor);
  const dispatcherAnchor = "\n(function () {\n    'use strict';\n\n    var path = location.pathname;";
  const dispatcherStart = content.indexOf(dispatcherAnchor, end + endAnchor.length);
  if (newEngineStart < 0 || newEngineStart >= start || content.indexOf(newEngineAnchor, newEngineStart + newEngineAnchor.length) >= 0 || dispatcherStart < 0 || content.indexOf(dispatcherAnchor, dispatcherStart + dispatcherAnchor.length) >= 0) throw new Error('TSH_ADAPTER_DISPATCH: Expected the reviewed engine declarations and one trailing dispatcher.');
  // Exclude both the uncontrolled new engine and the original dispatcher from execution.
  const executionContent = content.slice(0, newEngineStart) + "\n(function () {\n    'use strict';\n    if (location.origin !== 'https://www.tsinghuaelt.com' || !/^\\/legacy(?:\\/|$)/.test(location.pathname)) return;\n" + legacy + '\n    __TSH_OLD_ENGINE__();\n})();\n';
  const executionDigest = createHash('sha256').update(executionContent).digest('hex');
  return { content: executionContent, adapterVersion: 'swu-legacy-1', sourceDigest: actual, executionDigest };
}
