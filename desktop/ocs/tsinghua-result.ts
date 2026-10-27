import { z } from 'zod';
import { tsinghuaResultSchema, type TsinghuaResult } from '../shared/ocs-tsinghua';

/**
 * Reviewed legacy source: /legacy/main.4c93dc9c6da8077cd693.js, SHA-256
 * 8c9e6cb80c6cc1eaf21851a9ca48475dcf01648903e8e9a7729ceb0c9872d1a6.
 * Character ranges: submitData 10392371..10393981, loadDoRecord 10390935..10392045,
 * toExerciseDoRecord 394946..397539, toExercise 385620..394924.
 * The response has exercise points, not a verified correct-count denominator.
 * Neither non-digital acceptance nor object.success establishes objective correctness.
 */
const identifier = z.string().min(1).max(200).refine(value => value.trim() === value, 'An exact unpadded identifier is required.');
const exerciseType = z.number().int().min(1).max(31);
const points = z.number().finite().nonnegative();
const businessStatusSchema = z.object({ status: z.boolean() });

/**
 * Local correlation metadata, independently copied before an operation and re-read on delivery.
 * exerciseId must come from the official exercise.id, not a route, page ID or synthetic question key.
 * generation must change on cancellation, replacement or a new relevant recording/submission attempt.
 * These association fields are host metadata, not an assertion that the submit response echoes them.
 */
export const tsinghuaResultContextSchema = z.object({
  questionKey: z.string().uuid(), generation: z.number().int().nonnegative(),
  courseId: z.number().int().positive().safe(), pageId: identifier, exerciseId: identifier,
  exerciseType, maximumScore: points.nullable(), ifDigi: z.boolean()
}).strict();
export type TsinghuaResultContext = z.infer<typeof tsinghuaResultContextSchema>;
export const tsinghuaResultObservationSchema = z.object({
  requested: tsinghuaResultContextSchema, current: tsinghuaResultContextSchema,
  observedAt: z.string().datetime(), httpStatus: z.number().int().min(100).max(599)
}).strict();
export type TsinghuaResultObservation = z.infer<typeof tsinghuaResultObservationSchema>;

const doRecordSchema = z.object({ type: exerciseType, score: points.nullish() });
/** External schemas deliberately discard unrelated fields, including answers, audio and user metadata. */
export const tsinghuaSubmitResultProjectionSchema = z.object({
  status: z.literal(true),
  object: z.object({ isVisiable: z.number().int(), doRecord: doRecordSchema.nullish() })
});
export const tsinghuaRecordResultProjectionSchema = z.object({
  status: z.literal(true),
  object: z.object({
    exercise: z.object({ id: identifier, type: exerciseType, score: points, ifDigi: z.boolean() }),
    doRecord: doRecordSchema.nullish(), success: z.boolean(), submitNum: z.number().int().nonnegative()
  })
});

export interface TsinghuaExerciseResult {
  scope: 'exercise';
  context: TsinghuaResultContext;
  state: 'rejected' | 'blocked' | 'awaiting-record' | 'awaiting-score' | 'recorded-score';
  platformSuccess: boolean | null;
  submitNum: number | null;
  objectiveCorrectnessVerified: false;
  result: TsinghuaResult;
}

function validate<T>(schema: z.ZodType<T>, value: object, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const fields = parsed.error.issues.map(issue => issue.path.join('.')).join(', ');
    throw new TypeError(label + ': invalid or missing required fields: ' + fields + '. No result was published.');
  }
  return parsed.data;
}

/** Require exact local identity, including cancellation generation, before consuming any response. */
function observation(value: TsinghuaResultObservation): TsinghuaResultObservation {
  const parsed = validate(tsinghuaResultObservationSchema, value, 'TSH_RESULT_CONTEXT');
  const requested = parsed.requested;
  const current = parsed.current;
  if (requested.questionKey !== current.questionKey || requested.generation !== current.generation ||
      requested.courseId !== current.courseId || requested.pageId !== current.pageId ||
      requested.exerciseId !== current.exerciseId || requested.exerciseType !== current.exerciseType ||
      requested.maximumScore !== current.maximumScore || requested.ifDigi !== current.ifDigi) {
    throw new DOMException('TSH_RESULT_STALE: The request no longer belongs to the exact current question and generation.', 'InvalidStateError');
  }
  return parsed;
}

function result(
  observed: TsinghuaResultObservation, source: 'exercise-submit' | 'exercise-record',
  state: TsinghuaExerciseResult['state'], accepted: boolean | null, score: number | null,
  maximumScore: number | null, platformSuccess: boolean | null, submitNum: number | null, message: string
): TsinghuaExerciseResult {
  return {
    scope: 'exercise', context: { ...observed.current }, state, platformSuccess, submitNum,
    objectiveCorrectnessVerified: false,
    result: tsinghuaResultSchema.parse({
      observedAt: observed.observedAt, source, accepted, httpStatus: observed.httpStatus,
      score, maximumScore: maximumScore !== null && maximumScore > 0 ? maximumScore : null,
      correctCount: null, totalCount: null, accuracyPercent: null, completionPercent: null, message
    })
  };
}

function assertPoints(score: number, maximumScore: number | null): void {
  if (maximumScore !== null && score > maximumScore) {
    throw new RangeError('TSH_RESULT_SCORE_RANGE: Recorded points exceed the verified current exercise maximum. No value was clamped or published.');
  }
}

/**
 * Parse the minimal exercise/submit projection. The submit response does not echo exercise identity;
 * callers must pin the exact request to requested and independently re-read current before delivery.
 * status=true acknowledges the operation, not objective correctness or completion. Visibility states
 * 2/4/5 are the official closed/locked/already-submitted early-return branches.
 */
export function parseTsinghuaSubmitResult(value: object, input: TsinghuaResultObservation): TsinghuaExerciseResult {
  const observed = observation(input);
  const status = validate(businessStatusSchema, value, 'TSH_SUBMIT_STATUS');
  if (!status.status) return result(observed, 'exercise-submit', 'rejected', false, null, null, null, null, '官网业务 status=false，未确认接受此次提交。');
  if (observed.httpStatus < 200 || observed.httpStatus >= 300) throw new DOMException('TSH_SUBMIT_HTTP: Non-success HTTP transport cannot establish an accepted exercise submission.', 'NetworkError');
  const parsed = validate(tsinghuaSubmitResultProjectionSchema, value, 'TSH_SUBMIT_RESULT');
  const visibility = parsed.object.isVisiable;
  if ([2, 4, 5].includes(visibility)) {
    return result(observed, 'exercise-submit', 'blocked', false, null, null, null, null, '官网 isVisiable=' + visibility + '：章节关闭、上锁或已提交，本次不确认新提交成功。');
  }
  const record = parsed.object.doRecord;
  if (record == null) return result(observed, 'exercise-submit', 'awaiting-record', true, null, null, null, null, '官网业务已接受；响应未提供本题作答记录，需读取当前题官方记录。');
  if (record.type !== observed.current.exerciseType) throw new DOMException('TSH_SUBMIT_TYPE: Returned doRecord.type differs from the current exercise type.', 'InvalidStateError');
  if (record.score == null) return result(observed, 'exercise-submit', 'awaiting-score', true, null, null, null, null, '官网业务已接受且提供作答记录，但没有明确数值成绩；不将接受或非空作答当作答对。');
  assertPoints(record.score, observed.current.maximumScore);
  return result(observed, 'exercise-submit', 'recorded-score', true, record.score, observed.current.maximumScore, null, null,
    observed.current.ifDigi ? '官网返回本题记录分数；未提供正确题数及分母，正确率仍未验证。' : '官网接受开放作答并返回记录分数；非空可过关不等于客观答对，正确率未验证。');
}

/**
 * Parse exercise/record_for_detail with an additional official exercise.id/type/scale match.
 * Retrieval may return an older attempt: it never acknowledges a new submission or proves a fresh
 * microphone recording. object.success is retained separately and never converted to accuracy.
 */
export function parseTsinghuaRecordResult(value: object, input: TsinghuaResultObservation): TsinghuaExerciseResult {
  const observed = observation(input);
  const status = validate(businessStatusSchema, value, 'TSH_RECORD_STATUS');
  if (!status.status) return result(observed, 'exercise-record', 'rejected', false, null, null, null, null, '官网记录查询业务 status=false，本次没有有效题级结果。');
  if (observed.httpStatus < 200 || observed.httpStatus >= 300) throw new DOMException('TSH_RECORD_HTTP: Non-success HTTP transport cannot establish a verified exercise record.', 'NetworkError');
  const parsed = validate(tsinghuaRecordResultProjectionSchema, value, 'TSH_RECORD_RESULT');
  const official = parsed.object.exercise;
  const expected = observed.current;
  if (official.id !== expected.exerciseId || official.type !== expected.exerciseType || official.ifDigi !== expected.ifDigi ||
      (expected.maximumScore !== null && official.score !== expected.maximumScore)) {
    throw new DOMException('TSH_RECORD_IDENTITY: Official exercise identity, type or grading scale does not match the exact current question.', 'InvalidStateError');
  }
  const record = parsed.object.doRecord;
  if (record == null) return result(observed, 'exercise-record', 'awaiting-record', null, null, null, parsed.object.success, parsed.object.submitNum, '官网当前题尚无作答记录；查询成功不代表提交或录音完成。');
  if (record.type !== official.type) throw new DOMException('TSH_RECORD_TYPE: Official doRecord.type differs from its exercise.type.', 'InvalidStateError');
  if (record.score == null) return result(observed, 'exercise-record', 'awaiting-score', null, null, null, parsed.object.success, parsed.object.submitNum, '官网当前题已有记录但未给出数值成绩；success 或完成状态不代替评分。');
  assertPoints(record.score, official.score);
  return result(observed, 'exercise-record', 'recorded-score', null, record.score, official.score, parsed.object.success, parsed.object.submitNum,
    official.ifDigi ? '官网当前题记录分数；没有正确题数分母，也未证明是刚发生的录音或最新提交。' : '官网开放作答记录分数；接受、过关与完成不能转换为客观正确率，也未证明是最新录音。');
}
