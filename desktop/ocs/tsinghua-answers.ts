import { z } from 'zod';
import type { TsinghuaQuestionKind } from '../shared/ocs-tsinghua';

export interface TsinghuaAnswerPlan {
  exerciseId: string;
  kind: TsinghuaQuestionKind;
  answers: string[];
}

/**
 * Consume the exercise itself: content_detail.object.item.object or record.object.exercise.
 * Reviewed /legacy/main.4c93dc9c6da8077cd693.js, SHA-256
 * 8c9e6cb80c6cc1eaf21851a9ca48475dcf01648903e8e9a7729ceb0c9872d1a6.
 * toExercise: 385620..394924; choice pipes: 548897..549106, 613744..613854;
 * fill Key: 684271..686160; dropdown transform: 457658..457869;
 * judge labels: 732498..732590, Key template: 4887415.
 * Only complete, unambiguous plans are published. ifDigi and doRecord are not answer sources.
 */
const identifier = z.string().min(1).max(200).refine(value => value.trim() === value);
const identitySchema = z.object({ id: identifier, type: z.number().int() });
const choiceSchema = z.object({ id: identifier });
const singleSchema = identitySchema.extend({
  choices: z.array(choiceSchema).min(1).max(10), answer: identifier.or(z.literal('')).nullish()
});
const multipleSchema = identitySchema.extend({
  choices: z.array(choiceSchema).min(1).max(10), answer: z.array(identifier).nullish()
});
const judgeSchema = identitySchema.extend({
  options: z.array(z.object({ id: identifier, text: z.string() })).min(1),
  sentItems: z.array(z.object({ id: identifier, optionId: z.string().nullish() })).min(1)
});
const dropdownSchema = identitySchema.extend({
  dragged: z.array(z.object({ id: identifier, content: z.string() })).min(1),
  drag: z.array(z.object({ id: identifier, answer: z.string().nullish() })).min(1)
});
const contentItemSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal(1), text: z.string() }),
  z.object({ type: z.literal(2), id: identifier }),
  z.object({ type: z.literal(3), text: z.string() }),
  z.object({ type: z.literal(4), id: identifier }),
  z.object({ type: z.literal(5), id: identifier })
]);
const contentSchema = z.object({
  paragraphs: z.array(z.object({ contentItems: z.array(contentItemSchema) }))
});
type Content = z.infer<typeof contentSchema>;
const fillSchema = identitySchema.extend({
  content: contentSchema,
  fillBlanks: z.array(z.object({ id: identifier, styleStandardAnswer: contentSchema.nullish() })).min(1)
});
const dragSchema = identitySchema.extend({
  drag: z.array(z.object({ id: identifier, answer: z.string().nullish() })).min(1),
  dragged: z.array(z.object({ id: identifier, styleContent: contentSchema })).min(1)
});
const textSchema = identitySchema.extend({ answer: z.string().nullish() });

function validate<T>(schema: z.ZodType<T>, value: object): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const fields = parsed.error.issues.map(issue => issue.path.join('.')).join(', ');
    throw new TypeError('TSH_ANSWER_SHAPE: Invalid or missing exercise fields: ' + fields + '. No answer plan was published.');
  }
  return parsed.data;
}

function assertUnique(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) {
    throw new TypeError('TSH_ANSWER_DUPLICATE: ' + field + ' must identify each item unambiguously.');
  }
}

function assertIdentifiers(values: readonly { id: string }[], field: string): void {
  assertUnique(values.map(value => value.id), field);
}

/** Never convert hidden markup or an empty value into an invented answer. */
function plainText(value: string | null | undefined): string | null {
  if (value === null || value === undefined || !value.trim()) return null;
  if (/<\/?[a-z!][^>]*>|&(?:#\d+|#x[\da-f]+|[a-z]+);/i.test(value)) return null;
  return value;
}

/** Match the official Key's text items; reject nontext content instead of dropping it. */
function contentText(content: Content | null | undefined): string | null {
  if (!content) return null;
  const items = content.paragraphs.flatMap(paragraph => paragraph.contentItems);
  if (items.some(item => item.type !== 1 && item.type !== 3)) return null;
  return plainText(items.map(item => 'text' in item ? item.text : '').join(''));
}

function completePlan(id: string, kind: TsinghuaQuestionKind, answers: readonly (string | null)[]): TsinghuaAnswerPlan | null {
  if (answers.length === 0 || answers.some(answer => answer === null)) return null;
  return { exerciseId: id, kind, answers: answers.map(answer => {
    if (answer === null) throw new TypeError('TSH_ANSWER_INCOMPLETE: A required platform answer is missing.');
    return answer;
  }) };
}

function choiceLetter(choices: readonly { id: string }[], answer: string): string {
  const index = choices.findIndex(choice => choice.id === answer);
  if (index < 0) throw new TypeError('TSH_ANSWER_REFERENCE: answer references no item in choices.');
  return String.fromCharCode(65 + index);
}

function singlePlan(value: object): TsinghuaAnswerPlan | null {
  const exercise = validate(singleSchema, value);
  assertIdentifiers(exercise.choices, 'choices.id');
  if (!exercise.answer) return null;
  return completePlan(exercise.id, 'single', [choiceLetter(exercise.choices, exercise.answer)]);
}

function multiplePlan(value: object): TsinghuaAnswerPlan | null {
  const exercise = validate(multipleSchema, value);
  assertIdentifiers(exercise.choices, 'choices.id');
  const answers = exercise.answer;
  if (!answers || answers.length === 0) return null;
  assertUnique(answers, 'answer');
  for (const answer of answers) choiceLetter(exercise.choices, answer);
  const letters = exercise.choices.flatMap((choice, index) => answers.includes(choice.id) ? [String.fromCharCode(65 + index)] : []).join('');
  return completePlan(exercise.id, 'multiple', [letters]);
}

function judgePlan(value: object): TsinghuaAnswerPlan | null {
  const exercise = validate(judgeSchema, value);
  assertIdentifiers(exercise.options, 'options.id');
  assertIdentifiers(exercise.sentItems, 'sentItems.id');
  const labels = exercise.options.map(option => option.text.trim());
  assertUnique(labels, 'options.text');
  if (labels.some(label => !label)) throw new TypeError('TSH_ANSWER_LABEL: A judge option has an empty label.');
  const answers = exercise.sentItems.map(item => {
    if (!item.optionId) return null;
    const option = exercise.options.find(option => option.id === item.optionId);
    if (!option) throw new TypeError('TSH_ANSWER_REFERENCE: sentItems.optionId references no item in options.');
    return plainText(option.text.trim());
  });
  return completePlan(exercise.id, 'judge', answers);
}

function dropdownPlan(value: object): TsinghuaAnswerPlan | null {
  const exercise = validate(dropdownSchema, value);
  assertIdentifiers(exercise.drag, 'drag.id');
  assertIdentifiers(exercise.dragged, 'dragged.id');
  assertUnique(exercise.dragged.map(choice => choice.content.trim()), 'dragged.content');
  const answers = exercise.drag.map(item => {
    if (!item.answer) return null;
    const choice = exercise.dragged.find(choice => choice.id === item.answer);
    if (!choice) throw new TypeError('TSH_ANSWER_REFERENCE: drag.answer references no item in dragged.');
    return plainText(choice.content.trim());
  });
  return completePlan(exercise.id, 'dropdown', answers);
}

function fillPlan(value: object): TsinghuaAnswerPlan | null {
  const exercise = validate(fillSchema, value);
  assertIdentifiers(exercise.fillBlanks, 'fillBlanks.id');
  const blankIds = exercise.content.paragraphs.flatMap(paragraph => paragraph.contentItems)
    .flatMap(item => item.type === 2 ? [item.id] : []);
  assertUnique(blankIds, 'content blank IDs');
  if (blankIds.length !== exercise.fillBlanks.length || exercise.fillBlanks.some(blank => !blankIds.includes(blank.id))) {
    throw new TypeError('TSH_ANSWER_BLANKS: content blank IDs must match every fillBlanks.id exactly once.');
  }
  const answers = blankIds.map(id => {
    const blank = exercise.fillBlanks.find(blank => blank.id === id);
    if (!blank) throw new TypeError('TSH_ANSWER_REFERENCE: content references no item in fillBlanks.');
    return contentText(blank.styleStandardAnswer);
  });
  return completePlan(exercise.id, 'fill', answers);
}

function dragPlan(value: object): TsinghuaAnswerPlan | null {
  const exercise = validate(dragSchema, value);
  assertIdentifiers(exercise.drag, 'drag.id');
  assertIdentifiers(exercise.dragged, 'dragged.id');
  const choices = exercise.dragged.map(choice => ({ id: choice.id, text: contentText(choice.styleContent)?.trim() ?? null }));
  const labels = choices.flatMap(choice => choice.text === null ? [] : [choice.text]);
  assertUnique(labels, 'dragged.styleContent text');
  const answerIds = exercise.drag.flatMap(item => item.answer ? [item.answer] : []);
  assertUnique(answerIds, 'drag.answer');
  const answers = exercise.drag.map(item => {
    if (!item.answer) return null;
    const choice = choices.find(choice => choice.id === item.answer);
    if (!choice) throw new TypeError('TSH_ANSWER_REFERENCE: drag.answer references no item in dragged.');
    return choice.text;
  });
  if (choices.some(choice => choice.text === null)) return null;
  return completePlan(exercise.id, 'drag', answers);
}

/**
 * Return null for absent standards, speech/media and unsupported layouts, never a partial plan.
 * Supported numeric types: 1/2 choice, 3 fill, 10 one-to-one drag, 12 dropdown,
 * 6/7/20 plain textarea, 22 judge. Complex/grouped layouts need separately reviewed ordering.
 * Explicit open-answer markers are preserved verbatim, not interpreted or synthesized here.
 */
export function parseTsinghuaAnswerPlan(value: object): TsinghuaAnswerPlan | null {
  const { type } = validate(z.object({ type: z.number().int() }), value);
  switch (type) {
    case 1: return singlePlan(value);
    case 2: return multiplePlan(value);
    case 3: return fillPlan(value);
    case 10: return dragPlan(value);
    case 12: return dropdownPlan(value);
    case 22: return judgePlan(value);
    case 6:
    case 7:
    case 20: {
      const exercise = validate(textSchema, value);
      return completePlan(exercise.id, 'listen_fill', [plainText(exercise.answer)]);
    }
    default: return null;
  }
}
