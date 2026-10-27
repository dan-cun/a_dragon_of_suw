import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import ts from 'typescript';
import { adaptTsinghuaScript } from '../desktop/ocs/tsinghua-script';
import { parseTsinghuaCourseScore, parseTsinghuaDetailUrl } from '../desktop/bun/ocs-tsinghua-page';
import { ocsCommandSchema } from '../desktop/shared/ocs';
import { tsinghuaExternalScript } from '../desktop/shared/ocs-external';
import {
  TSINGHUA_LEGACY_HOME, tsinghuaMediaSchema, tsinghuaQuestionKindSchema,
  tsinghuaResultSchema, tsinghuaStateSchema
} from '../desktop/shared/ocs-tsinghua';

/** Schema checks are boundary inputs, not fabricated platform responses or business evidence. */
test('Tsinghua commands require a saved browser, explicit course and fresh start consent', () => {
  const id = randomUUID();
  for (const command of ['tsinghua-open', 'tsinghua-stop', 'tsinghua-refresh', 'tsinghua-read-score']) {
    expect(ocsCommandSchema.safeParse({ command, id }).success).toBe(true);
    expect(ocsCommandSchema.safeParse({ command, id: 'not-a-browser' }).success).toBe(false);
    expect(ocsCommandSchema.safeParse({ command, id, token: 'not-permitted' }).success).toBe(false);
  }
  expect(ocsCommandSchema.safeParse({ command: 'tsinghua-start', id, confirmed: true }).success).toBe(true);
  for (const confirmed of [false, null, 'true']) {
    expect(ocsCommandSchema.safeParse({ command: 'tsinghua-start', id, confirmed }).success).toBe(false);
  }
  expect(ocsCommandSchema.safeParse({ command: 'tsinghua-start', id }).success).toBe(false);
  expect(ocsCommandSchema.safeParse({ command: 'tsinghua-start', id, confirmed: true, autoRecord: true }).success).toBe(false);
  expect(ocsCommandSchema.safeParse({ command: 'tsinghua-select-course', id, courseId: 1 }).success).toBe(true);
  for (const courseId of [0, -1, 1.5, '1', null]) {
    expect(ocsCommandSchema.safeParse({ command: 'tsinghua-select-course', id, courseId }).success).toBe(false);
  }
});

test('Tsinghua entry is the reviewed legacy home rather than the ambiguous site root', () => {
  expect(TSINGHUA_LEGACY_HOME).toBe('https://www.tsinghuaelt.com/legacy/home');
  expect(tsinghuaExternalScript.platformUrl).toBe(TSINGHUA_LEGACY_HOME);
});

test('Tsinghua DTO separates transport, acceptance, accuracy, completion and human recording', () => {
  const fields = tsinghuaResultSchema.shape;
  for (const field of [fields.accepted, fields.score, fields.correctCount, fields.totalCount, fields.accuracyPercent, fields.completionPercent]) {
    expect(field.safeParse(null).success).toBe(true);
    expect(field.safeParse(undefined).success).toBe(false);
  }
  expect(fields.accepted.safeParse(200).success).toBe(false);
  expect(fields.httpStatus.safeParse(200).success).toBe(true);
  expect(fields.totalCount.safeParse(0).success).toBe(false);
  expect(fields.correctCount.safeParse(-1).success).toBe(false);
  for (const accuracy of [-1, 101, Number.NaN, Infinity]) expect(fields.accuracyPercent.safeParse(accuracy).success).toBe(false);
  expect(fields.source.options).toEqual(['exercise-submit', 'exercise-record', 'course-score', 'page']);
  expect(tsinghuaStateSchema.shape.phase.safeParse('awaiting-recording').success).toBe(true);
  expect(tsinghuaStateSchema.shape.phase.safeParse('recording-complete-assumed').success).toBe(false);
  for (const kind of ['listen_repeat', 'oral', 'roleplay']) expect(tsinghuaQuestionKindSchema.safeParse(kind).success).toBe(true);
  expect(tsinghuaQuestionKindSchema.safeParse('exam').success).toBe(false);
});

test('Media DTO requires real finite timing and exposes playback speed and mute state', () => {
  const fields = tsinghuaMediaSchema.shape;
  expect(fields.currentTime.safeParse(undefined).success).toBe(false);
  for (const time of [-1, Infinity, Number.NaN]) expect(fields.currentTime.safeParse(time).success).toBe(false);
  expect(fields.duration.safeParse(null).success).toBe(true);
  expect(fields.playbackRate.safeParse(0).success).toBe(false);
  expect(fields.playbackRate.safeParse(1).success).toBe(true);
  expect(fields.muted.safeParse(undefined).success).toBe(false);
});

test('Saved course parsing rejects alternate origins, credentials, query material and unsafe identifiers', () => {
  expect(parseTsinghuaDetailUrl('https://www.tsinghuaelt.com/legacy/course-student/1/study')?.courseId).toBe(1);
  for (const value of [
    TSINGHUA_LEGACY_HOME, 'https://example.invalid/legacy/course-student/1/study',
    'http://www.tsinghuaelt.com/legacy/course-student/1/study',
    'https://user:secret@www.tsinghuaelt.com/legacy/course-student/1/study',
    'https://www.tsinghuaelt.com/legacy/course-student/1/study?token=forbidden',
    'https://www.tsinghuaelt.com/legacy/course-student/1/study#fragment',
    'https://www.tsinghuaelt.com/legacy/course-student/0/study',
    'https://www.tsinghuaelt.com/legacy/course-student/9007199254740992/study'
  ]) expect(parseTsinghuaDetailUrl(value)).toBeNull();
  expect(() => parseTsinghuaCourseScore({})).toThrow(TypeError);
});

function namedFunction(source: ts.Node, name: string): ts.FunctionDeclaration {
  const matches: ts.FunctionDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (matches.length !== 1 || !matches[0]?.body) throw new Error('Expected exactly one complete transformed function: ' + name);
  return matches[0];
}

const sourceTest = process.env['SWU_TSINGHUA_REVIEWED_SOURCE'] ? test : test.skip;

/** Read the actual previously downloaded GPL source; never execute or rewrite its contents. */
sourceTest('Reviewed external GPL input retains its fixed digest, license and original speech risk anchors', async () => {
  const path = process.env['SWU_TSINGHUA_REVIEWED_SOURCE'];
  if (!path || !isAbsolute(path) || !(await lstat(path)).isFile()) throw new TypeError('SWU_TSINGHUA_REVIEWED_SOURCE must identify the existing reviewed GPL script file.');
  const bytes = await readFile(path);
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(tsinghuaExternalScript.digest);
  const source = bytes.toString('utf8');
  expect(source).toContain('// @license      GPL-3.0-only');
  expect(source).toContain('// @version      2.3.0');
  expect(source).toContain('async function solveOral()');
  expect(source).toContain('async function solveListenRepeat()');
  expect(source).toContain('async function solveRoleplay()');
  expect(source).toContain('async function loop()');
  const adapted = adaptTsinghuaScript(source, tsinghuaExternalScript.digest);
  expect(adapted.sourceDigest).toBe(tsinghuaExternalScript.digest);
  expect(adapted.adapterVersion).toBe('swu-legacy-1');
  expect(adapted.executionDigest).toBe(createHash('sha256').update(adapted.content).digest('hex'));
  expect(adapted.executionDigest).not.toBe(adapted.sourceDigest);
  expect(adapted.content).toContain('// @license      GPL-3.0-only');
  const syntax = ts.transpileModule(adapted.content, { compilerOptions: { target: ts.ScriptTarget.ES2023, allowJs: true }, fileName: 'reviewed-execution.js', reportDiagnostics: true });
  expect(syntax.diagnostics?.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)).toEqual([]);
  const tree = ts.createSourceFile('reviewed-execution.js', adapted.content, ts.ScriptTarget.ES2023, true, ts.ScriptKind.JS);
  const engine = namedFunction(tree, '__TSH_OLD_ENGINE__');
  const entryStatements = engine.body!.statements.filter(ts.isExpressionStatement).map(statement => statement.getText(tree));
  expect(entryStatements.some(statement => /(?:setTimeout\(mkUI|\bmkUI\(|\bloop\(|\bstartStudyFarm\()/.test(statement))).toBe(false);
  expect(entryStatements.some(statement => statement.includes('globalThis.__SWU_TSH_LEGACY__'))).toBe(true);
  for (const name of ['solveOral', 'solveListenRepeat', 'solveRoleplay', 'solveVideo']) {
    const body = namedFunction(engine, name).body!.getText(tree);
    expect(body).toContain('TSH_MANUAL_ONLY');
    expect(body).not.toMatch(/(?:\.click\(|clickSubmit\(|submitSmart\(|recBtn|getUserMedia|MediaRecorder)/);
  }
  for (const name of ['click', 'clickSeq', 'fill']) expect(namedFunction(engine, name).body!.getText(tree)).toContain('swuLegacy.assertTarget(el)');
  const run = namedFunction(engine, 'runOrdinary').body!.getText(tree);
  expect(run).toContain('TSH_MANUAL_RECORDING');
  expect(run).toContain('TSH_NOT_ORDINARY');
  expect(namedFunction(engine, 'stop').body!.getText(tree)).toContain('controller.abort()');
  expect(namedFunction(engine, 'sleep').body!.getText(tree)).toContain('clearTimeout(timer)');
  expect(namedFunction(engine, 'clickRetry').body!.getText(tree)).toContain('TSH_RETRY_DISABLED');
  expect(adapted.content).toContain('const sleep = ms => swuLegacy.sleep(ms);');
  expect(() => adaptTsinghuaScript(source + '\n', tsinghuaExternalScript.digest)).toThrow('TSH_ADAPTER_DIGEST');
  expect(() => adaptTsinghuaScript(source, '0'.repeat(64))).toThrow('TSH_ADAPTER_DIGEST');
});
