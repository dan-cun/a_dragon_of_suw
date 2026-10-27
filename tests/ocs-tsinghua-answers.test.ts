import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { parseTsinghuaAnswerPlan } from '../desktop/ocs/tsinghua-answers';

/** Local normalizer inputs below are scalar/layout boundaries, not successful platform replies. */
function textContent(text: string) {
  return { paragraphs: [{ contentItems: [{ type: 1, text }] }] };
}

function localFill(answers: readonly (string | null)[]) {
  return {
    type: 3, id: 'local-layout-boundary',
    content: { paragraphs: [{ contentItems: answers.map((_, index) => ({ type: 2, id: 'blank-' + index })) }] },
    fillBlanks: answers.map((answer, index) => ({ id: 'blank-' + index, styleStandardAnswer: answer === null ? null : textContent(answer) }))
  };
}

test('Fill normalizes complete standards in stem order, preserving exact open-marker text and ignoring unrelated data', () => {
  const input = localFill(['ordinary standard', ' Answers will vary. ', '答案略', '*ANY*']);
  const reordered = { ...input, fillBlanks: [...input.fillBlanks].reverse(), ifDigi: false, doRecord: { answer: 'must not be used' }, audio: 'must not be retained' };
  const before = JSON.stringify(reordered);
  expect(parseTsinghuaAnswerPlan(reordered)).toEqual({
    exerciseId: input.id, kind: 'fill', answers: ['ordinary standard', ' Answers will vary. ', '答案略', '*ANY*']
  });
  expect(JSON.stringify(reordered)).toBe(before);
  for (const missing of [null, '', '   ']) {
    expect(parseTsinghuaAnswerPlan({ ...localFill(['known', missing]), ifDigi: false })).toBeNull();
  }
  expect(parseTsinghuaAnswerPlan({ ...localFill([null]), ifDigi: false, answer: '*ANY*' })).toBeNull();
});

test('Plain textarea standards preserve markers; empty, markup and speech do not become open answers', () => {
  for (const type of [6, 7, 20]) {
    for (const answer of ['a complete standard', 'Responses may vary!', '答案略', '*ANY*']) {
      expect(parseTsinghuaAnswerPlan({ type, id: 'local-text-boundary', answer })).toEqual({ exerciseId: 'local-text-boundary', kind: 'listen_fill', answers: [answer] });
    }
    for (const answer of [null, '', ' ', '<p>Answers will vary.</p>']) {
      expect(parseTsinghuaAnswerPlan({ type, id: 'local-text-boundary', answer, ifDigi: false })).toBeNull();
    }
  }
  for (const type of [4, 5, 8, 9, 11, 13, 14, 15, 16, 17, 18, 19, 21, 23, 24, 25, 26, 27, 28, 29, 30, 31, 999]) {
    expect(parseTsinghuaAnswerPlan({ type, answer: '*ANY*' })).toBeNull();
  }
});

test('Choice IDs, judge labels and dropdown content follow official consumers without guessed labels', () => {
  const choices = [{ id: 'local-a' }, { id: 'local-b' }, { id: 'local-c' }];
  expect(parseTsinghuaAnswerPlan({ id: 'local-choice-boundary', type: 1, choices, answer: 'local-b' })?.answers).toEqual(['B']);
  expect(parseTsinghuaAnswerPlan({ id: 'local-choice-boundary', type: 2, choices, answer: ['local-c', 'local-a'] })?.answers).toEqual(['AC']);
  expect(parseTsinghuaAnswerPlan({ id: 'local-judge-boundary', type: 22, options: [{ id: 'local-a', text: ' True ' }, { id: 'local-b', text: 'False' }], sentItems: [{ id: 'local-row', optionId: 'local-b' }] })?.answers).toEqual(['False']);
  expect(parseTsinghuaAnswerPlan({ id: 'local-dropdown-boundary', type: 12, dragged: [{ id: 'local-a', content: ' selected text ' }], drag: [{ id: 'local-slot', answer: 'local-a' }] })?.answers).toEqual(['selected text']);
  expect(parseTsinghuaAnswerPlan({ id: 'local-drag-boundary', type: 10, dragged: [{ id: 'local-a', styleContent: textContent(' drag text ') }], drag: [{ id: 'local-slot', answer: 'local-a' }] })?.answers).toEqual(['drag text']);
});

test('Known malformed structures, duplicates, dangling IDs and incomplete counts fail explicitly', () => {
  expect(() => parseTsinghuaAnswerPlan({})).toThrow('TSH_ANSWER_SHAPE');
  for (const type of [1, 2, 3, 6, 7, 10, 12, 20, 22]) {
    expect(() => parseTsinghuaAnswerPlan({ type })).toThrow('TSH_ANSWER_SHAPE');
  }
  const choices = [{ id: 'local-a' }, { id: 'local-b' }];
  expect(() => parseTsinghuaAnswerPlan({ id: 'local-choice-boundary', type: 1, choices, answer: 'missing' })).toThrow('TSH_ANSWER_REFERENCE');
  expect(() => parseTsinghuaAnswerPlan({ id: 'local-choice-boundary', type: 2, choices, answer: ['local-a', 'local-a'] })).toThrow('TSH_ANSWER_DUPLICATE');
  const fill = localFill(['one', 'two']);
  expect(() => parseTsinghuaAnswerPlan({ ...fill, fillBlanks: fill.fillBlanks.slice(0, 1) })).toThrow('TSH_ANSWER_BLANKS');
  expect(() => parseTsinghuaAnswerPlan({ ...fill, fillBlanks: [fill.fillBlanks[0], fill.fillBlanks[0]] })).toThrow('TSH_ANSWER_DUPLICATE');
  expect(() => parseTsinghuaAnswerPlan({ ...fill, fillBlanks: [{ id: 'blank-0', styleStandardAnswer: 123 }] })).toThrow('TSH_ANSWER_SHAPE');
});

const sourceTest = process.env['SWU_TSINGHUA_LEGACY_SOURCE'] ? test : test.skip;

/** Positive protocol evidence comes from the pinned real official consumers, not fabricated success fixtures. */
sourceTest('Pinned official consumers establish field names, blank ordering and solver-compatible mapping', async () => {
  const path = process.env['SWU_TSINGHUA_LEGACY_SOURCE'];
  if (!path || !isAbsolute(path) || !(await lstat(path)).isFile()) throw new TypeError('SWU_TSINGHUA_LEGACY_SOURCE must name the reviewed public legacy JS body.');
  const bytes = await readFile(path);
  expect(createHash('sha256').update(bytes).digest('hex')).toBe('8c9e6cb80c6cc1eaf21851a9ca48475dcf01648903e8e9a7729ceb0c9872d1a6');
  const source = bytes.toString('utf8');
  const convert = source.slice(385620, 394924);
  expect(convert).toContain('e.answer=l.answer');
  expect(convert).toContain('r.fillBlanks[i]=n.toFillBlank(a[i])');
  expect(convert).toContain('D.options[i]=n.toOptions(L[i])');
  expect(convert).toContain('D.sentItems[i]=n.toJudgeItem($[i])');
  expect(source.slice(548897, 549106)).toContain('n.answer.indexOf(l.id)>-1');
  expect(source.slice(548897, 549106)).toContain('String.fromCharCode(65+e)');
  expect(source.slice(613744, 613854)).toContain('l.id===n.answer');
  const fillKey = source.slice(684271, 686160);
  expect(fillKey).toContain('filter(function(n){return 2===n.type}).map(function(n){return n.id})');
  expect(fillKey).toContain('ht.toContentString(l.styleStandardAnswer)');
  expect(fillKey).toContain('t.createAnswerContent(l.styleStandardAnswer)');
  expect(source.slice(457658, 457869)).toContain('l.answer===n.exercise.dragged[e].id');
  expect(source.slice(457658, 457869)).toContain('answerContent=n.exercise.dragged[e].content');
  expect(source.slice(732498, 732590)).toContain('n.optinsText[l.id]=l.text');
  expect(source).toContain('t.optinsText[l.context.$implicit.optionId]');
  expect(source).toContain('1===n.type?t+=');
});
