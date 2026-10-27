import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import {
  parseTsinghuaRecordResult, parseTsinghuaSubmitResult, tsinghuaResultContextSchema,
  tsinghuaResultObservationSchema, tsinghuaRecordResultProjectionSchema, tsinghuaSubmitResultProjectionSchema,
  type TsinghuaResultObservation
} from '../desktop/ocs/tsinghua-result';

/** Local correlation inputs and scalar boundaries are not fabricated platform response fixtures. */
function localObservation(): TsinghuaResultObservation {
  const context = { questionKey: randomUUID(), generation: 1, courseId: 1, pageId: 'local-page-boundary', exerciseId: 'local-exercise-boundary', exerciseType: 1, maximumScore: 1, ifDigi: true };
  return { requested: context, current: { ...context }, observedAt: '2026-10-27T10:00:00.000Z', httpStatus: 200 };
}

test('Result correlation requires exact question, generation and grading context before any body is parsed', () => {
  const initial = localObservation();
  expect(tsinghuaResultObservationSchema.safeParse(initial).success).toBe(true);
  const changed = [
    { ...initial.current, generation: 2 }, { ...initial.current, questionKey: randomUUID() },
    { ...initial.current, courseId: 2 }, { ...initial.current, pageId: 'other-local-page' },
    { ...initial.current, exerciseId: 'other-local-exercise' }, { ...initial.current, exerciseType: 2 },
    { ...initial.current, maximumScore: 2 }, { ...initial.current, ifDigi: false }
  ];
  for (const current of changed) {
    const observation = { ...initial, current };
    expect(() => parseTsinghuaSubmitResult({}, observation)).toThrow('TSH_RESULT_STALE');
    expect(() => parseTsinghuaRecordResult({}, observation)).toThrow('TSH_RESULT_STALE');
  }
  expect(initial.current).toEqual(initial.requested);
});

test('Missing business status is not inferred from HTTP 200 or an empty response', () => {
  const observation = localObservation();
  expect(() => parseTsinghuaSubmitResult({}, observation)).toThrow('TSH_SUBMIT_STATUS');
  expect(() => parseTsinghuaRecordResult({}, observation)).toThrow('TSH_RECORD_STATUS');
  expect(tsinghuaSubmitResultProjectionSchema.shape.status.safeParse(200).success).toBe(false);
  expect(tsinghuaRecordResultProjectionSchema.shape.status.safeParse('true').success).toBe(false);
});

test('Official score projections accept finite point scalars but never coerce numeric strings or invented count fields', () => {
  const score = tsinghuaRecordResultProjectionSchema.shape.object.shape.exercise.shape.score;
  expect(score.safeParse(0).success).toBe(true);
  expect(score.safeParse(0.5).success).toBe(true);
  for (const invalid of [Number.NaN, Infinity, -1, '1', null, undefined]) expect(score.safeParse(invalid).success).toBe(false);
  expect(tsinghuaResultContextSchema.shape.maximumScore.safeParse(null).success).toBe(true);
  expect(tsinghuaResultContextSchema.shape.maximumScore.safeParse(Infinity).success).toBe(false);
  expect(Object.keys(tsinghuaRecordResultProjectionSchema.shape.object.shape)).toEqual(['exercise', 'doRecord', 'success', 'submitNum']);
  expect(Object.keys(tsinghuaRecordResultProjectionSchema.shape.object.shape.exercise.shape)).toEqual(['id', 'type', 'score', 'ifDigi']);
  expect(Object.keys(tsinghuaSubmitResultProjectionSchema.shape.object.shape)).toEqual(['isVisiable', 'doRecord']);
});

const sourceTest = process.env['SWU_TSINGHUA_LEGACY_SOURCE'] ? test : test.skip;

/** Positive protocol evidence is the real public implementation, never a manufactured successful reply. */
sourceTest('Pinned official legacy consumers establish points and acceptance but not objective counts or bound raw speech scores', async () => {
  const path = process.env['SWU_TSINGHUA_LEGACY_SOURCE'];
  if (!path || !isAbsolute(path) || !(await lstat(path)).isFile()) throw new TypeError('SWU_TSINGHUA_LEGACY_SOURCE must name the reviewed public legacy JS body.');
  const bytes = await readFile(path);
  expect(createHash('sha256').update(bytes).digest('hex')).toBe('8c9e6cb80c6cc1eaf21851a9ca48475dcf01648903e8e9a7729ceb0c9872d1a6');
  const source = bytes.toString('utf8');
  const submit = source.slice(10392371, 10393981);
  const record = source.slice(10390935, 10392045);
  const convertRecord = source.slice(394946, 397539);
  const convertExercise = source.slice(385620, 394924);
  const speech = source.slice(694433, 696825);
  expect(submit.startsWith('function(n){')).toBe(true);
  expect(record.startsWith('function(){')).toBe(true);
  expect(source).toContain('if(!1===l.body.status)throw new e.f({status:501');
  expect(submit).toContain('exercise/submit?pageId=');
  expect(submit).toContain('pageId:this.pageId,courseId:this.courseId,doRecord:this.doRecord');
  expect(submit).toContain('[2,4,5].indexOf(n.object.isVisiable)>-1');
  expect(submit).toContain('F.b.toExerciseDoRecord(n.object.doRecord)');
  expect(submit).toContain('!l.exercise.ifDigi||l.exercise.score===l.doRecord.score');
  expect(record).toContain('exercise/record_for_detail?courseId=');
  expect(record).toContain('n.submitNum=l.object.submitNum');
  expect(record).toContain('n.exercise=F.b.toExercise(l.object.exercise)');
  expect(record).toContain('l.object.doRecord?');
  expect(record).toContain('n.isSuccess=l.object.success');
  expect(convertRecord).toContain('(l.score||0===l.score)&&(t.score=l.score)');
  expect(convertExercise).toContain('l.id&&(t.id=l.id)');
  expect(convertExercise).toContain('t.ifDigi=!1!==l.ifDigi');
  expect(convertExercise).toContain('(l.score||0===l.score)&&(t.score=l.score)');
  for (const field of ['rightNum', 'wrongNum', 'noDoNum', 'rightRate', 'questionAnswerItemVOList']) {
    expect(submit).not.toContain(field);
    expect(record).not.toContain(field);
  }
  expect(source).toContain('n.toCsExerciseDoRecordStatistic=function');
  expect(speech).toContain('e.audioUrl&&1e4!==e.result.info.tipId');
  expect(speech).toContain('u.score=e.result.overall');
  expect(speech).toContain('e.request.coreType===l.saSentType');
  expect(speech).not.toContain('exerciseId');
  expect(speech).not.toContain('pageId');
  expect(source).toContain('saWordType="en.word.score"');
  expect(source).toContain('saSentType="en.sent.score"');
  expect(source).toContain('saExamType="en.pred.exam"');
});
