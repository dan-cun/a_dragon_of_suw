import { z } from 'zod';

export type OcsConfigJson = string | number | boolean | null | OcsConfigJson[] | { [key: string]: OcsConfigJson };
export type OcsConfigDocument = { [key: string]: OcsConfigJson };
export type OcsConfigValue = string | number | boolean;
export type OcsConfigSource = { path: string; startLine: number; endLine: number };
type FieldBase = { namespace: string; key: string; label: string; description: string; sources: readonly OcsConfigSource[] };
export type OcsConfigField = FieldBase & (
  | { kind: 'boolean'; defaultValue: boolean }
  | { kind: 'number'; defaultValue: number; min: number; max: number; step: number }
  | { kind: 'select'; defaultValue: string | number; options: readonly { value: string; label: string }[] }
);
export type OcsConfigGroup = { namespace: string; label: string; fields: readonly OcsConfigField[] };
export type OcsConfigFieldState =
  | { status: 'default' | 'saved'; value: OcsConfigValue }
  | { status: 'private' }
  | { status: 'invalid'; message: string };

export const ocsConfigPrivateMarker = '[已保存的私有值]';
const jsonSchema: z.ZodType<OcsConfigJson> = z.lazy(() => z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonSchema), z.record(z.string(), jsonSchema)]));
const documentSchema = z.record(z.string(), jsonSchema);
const projects = 'packages/scripts/src/projects/';
const utils = 'packages/scripts/src/utils/';
function source(path: string, startLine: number, endLine: number): OcsConfigSource { return { path, startLine, endLine }; }

function volumeField(namespace: string, usage: OcsConfigSource): OcsConfigField {
  return { namespace, key: 'volume', label: '音量调节', description: '上游音量比例，0 为静音、1 为最大音量。', kind: 'number', defaultValue: 0, min: 0, max: 1, step: 0.05, sources: [usage, source(utils + 'configs.ts', 19, 25)] };
}
function restudyField(namespace: string, usage: OcsConfigSource): OcsConfigField {
  return { namespace, key: 'restudy', label: '复习模式', description: '上游定义：已经完成的视频继续学习；此处仅保存设置。', kind: 'boolean', defaultValue: false, sources: [usage, source(utils + 'configs.ts', 29, 33)] };
}
function mediaFields(namespace: string, usage: OcsConfigSource): OcsConfigField[] {
  return [
    { namespace, key: 'playbackRate', label: '视频倍速', description: '严格保留上游选项；高倍速可能触发平台风控，此处保存不会控制视频。', kind: 'select', defaultValue: '1', options: [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3, 3.5, 4, 6, 8, 16].map(value => ({ value: String(value), label: `${value} x` })), sources: [usage, source(utils + 'configs.ts', 11, 16)] },
    volumeField(namespace, usage)
  ];
}

/** Only scalar metadata is adapted; no upstream renderer, handler or remote bundle is executed. */
export const ocsConfigCatalog: {
  version: string; commit: string; sourceDirectory: string; groups: readonly OcsConfigGroup[];
} = {
  version: '5.2.1',
  commit: '8b25a3f44523a0d4b7373878488056f4aa478cf6',
  sourceDirectory: 'vendor/ocs/ocsjs-5.2.1',
  groups: [
    {
      namespace: 'common.settings', label: '通用设置', fields: [
        { namespace: 'common.settings', key: 'thread', label: '线程数量（个）', description: '上游搜题线程数量。仅保存配置，不发起搜题。', kind: 'number', defaultValue: 1, min: 1, max: 3, step: 1, sources: [source(projects + 'common.ts', 857, 870)] },
        { namespace: 'common.settings', key: 'imageOptimize', label: '图片题优化', description: '上游图片题优化开关；此表单不会读取或上传图片。', kind: 'boolean', defaultValue: true, sources: [source(projects + 'common.ts', 871, 883)] },
        { namespace: 'common.settings', key: 'answerWrapperHandlerTimeout', label: '搜题最大耗时（秒）', description: '上游搜题超时设置，范围 10–180 秒。', kind: 'number', defaultValue: 120, min: 10, max: 180, step: 1, sources: [source(projects + 'common.ts', 884, 896)] },
        { namespace: 'common.settings', key: 'stopSecondWhenFinish', label: '答题结束后暂停（秒）', description: '上游答题结束后的等待设置，不是课程完成标记。', kind: 'number', defaultValue: 3, min: 3, max: 9999, step: 1, sources: [source(projects + 'common.ts', 897, 909)] },
        { namespace: 'common.settings', key: 'period', label: '搜题间隔（秒）', description: '上游每道题的搜题间隔，范围 1–60 秒。', kind: 'number', defaultValue: 3, min: 1, max: 60, step: 1, sources: [source(projects + 'common.ts', 910, 922)] },
        { namespace: 'common.settings', key: 'notification', label: '系统通知', description: '保留上游通知类型，不在此执行通知测试。', kind: 'select', defaultValue: 'only-notify', options: [{ value: 'only-notify', label: '只显示右下角通知' }, { value: 'notify-and-voice', label: '通知以及提示音（叮的一声）' }, { value: 'all', label: '通知，提示音，以及任务栏闪烁提示' }, { value: 'no-notify', label: '关闭系统通知' }], sources: [source(projects + 'common.ts', 975, 997)] },
        { namespace: 'common.settings', key: 'enableQuestionCaches', label: '题库缓存功能', description: '仅保存上游缓存偏好，不读取或管理题库缓存。', kind: 'boolean', defaultValue: true, sources: [source(projects + 'common.ts', 998, 1009)] }
      ]
    },
    {
      namespace: 'cx.new.study', label: '超星 · 课程学习', fields: [
        ...mediaFields('cx.new.study', source(projects + 'cx.ts', 210, 228)),
        { namespace: 'cx.new.study', key: 'mode', label: '跳转模式', description: '保留上游章节跳转选项，保存不会跳转页面。', kind: 'select', defaultValue: 'next', options: [{ value: 'next', label: '完成后跳转下一节' }, { value: 'job', label: '完成后跳转未完成任务点' }, { value: 'manually', label: '完成后暂停，等待手动跳转' }], sources: [source(projects + 'cx.ts', 242, 251)] },
        restudyField('cx.new.study', source(projects + 'cx.ts', 252, 256))
      ]
    },
    {
      namespace: 'icourse.study-v1', label: '中国大学 MOOC · 学习', fields: [
        ...mediaFields('icourse.study-v1', source(projects + 'icourse.ts', 92, 112)),
        { namespace: 'icourse.study-v1', key: 'readSpeed', label: 'PPT翻阅速度（秒）', description: '上游课件翻阅间隔，范围 1–10 秒。', kind: 'number', defaultValue: 1, min: 1, max: 10, step: 1, sources: [source(projects + 'icourse.ts', 113, 117)] }
      ]
    },
    { namespace: 'icve.study.center', label: '智慧职教 · 学习中心', fields: mediaFields('icve.study.center', source(projects + 'icve.ts', 84, 98)) },
    {
      namespace: 'zhs.study', label: '智慧树 · 统一学习设置', fields: [
        { namespace: 'zhs.study', key: 'playbackRate', label: '视频倍速', description: '上游限至 1.5x；原始默认值为数字 1，选项值为字符串，按源码分别保留。', kind: 'select', defaultValue: 1, options: [{ value: '1', label: '1 x' }, { value: '1.25', label: '1.25 x' }, { value: '1.5', label: '1.5 x' }], sources: [source(utils + 'zhs.configs.ts', 16, 26), source(utils + 'zhs.configs.ts', 123, 133), source(utils + 'config-migrate.ts', 23, 30)] },
        volumeField('zhs.study', source(utils + 'zhs.configs.ts', 123, 133)),
        { namespace: 'zhs.study', key: 'definition', label: '清晰度', description: '保留上游线路标识，不在此切换播放器线路。', kind: 'select', defaultValue: 'line1bq', options: [{ value: 'line1bq', label: '流畅' }, { value: 'line1gq', label: '高清' }], sources: [source(utils + 'configs.ts', 36, 44), source(utils + 'zhs.configs.ts', 123, 133)] },
        restudyField('zhs.study', source(utils + 'zhs.configs.ts', 123, 133)),
        { namespace: 'zhs.study', key: 'stopTime', label: '定时停止', description: '上游仅对共享课系列学习页面生效；此处不创建任何定时任务。', kind: 'select', defaultValue: '0', options: [{ value: '0', label: '关闭' }, { value: '0.5', label: '半小时后' }, { value: '1', label: '一小时后' }, { value: '2', label: '两小时后' }], sources: [source(utils + 'zhs.configs.ts', 75, 90), source(utils + 'zhs.configs.ts', 123, 133)] }
      ]
    },
    { namespace: 'yuketang.study.ai', label: '雨课堂 · AI 学习', fields: [volumeField('yuketang.study.ai', source(projects + 'yuketang.ts', 124, 161)), restudyField('yuketang.study.ai', source(projects + 'yuketang.ts', 124, 134))] }
  ]
};

export function ocsConfigFieldKey(field: OcsConfigField): string { return `${field.namespace}.${field.key}`; }

export function parseOcsConfigJson(text: string): OcsConfigDocument {
  if (text.length > 524288) throw new RangeError('OCS 全局配置最多 524288 个字符。');
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch (cause: unknown) { throw new SyntaxError('全局配置不是有效 JSON，请检查引号、逗号和括号。', { cause }); }
  const result = documentSchema.safeParse(parsed);
  if (!result.success) throw new TypeError('全局配置必须为仅含 JSON 值的对象，不能是数组或空值。', { cause: result.error });
  return result.data;
}

export function validateOcsConfigValue(field: OcsConfigField, value: unknown): OcsConfigValue {
  if (field.kind === 'boolean') {
    if (typeof value !== 'boolean') throw new TypeError(`${field.label}必须是布尔值。`);
    return value;
  }
  if (field.kind === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${field.label}必须是有效数字。`);
    if (value < field.min || value > field.max) throw new RangeError(`${field.label}范围为 ${field.min}–${field.max}。`);
    const steps = (value - field.min) / field.step;
    if (Math.abs(steps - Math.round(steps)) > 0.00000001) throw new RangeError(`${field.label}步长为 ${field.step}。`);
    return value;
  }
  if ((typeof value === 'string' || typeof value === 'number') && (value === field.defaultValue || field.options.some(option => option.value === value))) return value;
  throw new TypeError(`${field.label}必须使用固定源码提供的选项。`);
}

function containsPrivateMarker(value: OcsConfigJson | undefined): boolean {
  if (value === ocsConfigPrivateMarker) return true;
  if (Array.isArray(value)) return value.some(containsPrivateMarker);
  if (value !== null && typeof value === 'object') return Object.values(value).some(containsPrivateMarker);
  return false;
}

/** Private or incompatible stored values are never copied into form controls or error messages. */
export function readOcsConfigField(document: OcsConfigDocument, field: OcsConfigField): OcsConfigFieldState {
  const key = ocsConfigFieldKey(field);
  if (!Object.hasOwn(document, key)) return { status: 'default', value: field.defaultValue };
  const value = document[key];
  if (containsPrivateMarker(value)) return { status: 'private' };
  try { return { status: 'saved', value: validateOcsConfigValue(field, value) }; }
  catch (cause: unknown) { return { status: 'invalid', message: cause instanceof Error ? cause.message : '已保存配置类型不符合字段定义。' }; }
}

/** Change exactly one whitelisted key; keep every unknown value and private marker structurally intact. */
export function writeOcsConfigField(text: string, key: string, value: unknown): string {
  const field = ocsConfigCatalog.groups.flatMap(group => group.fields).find(item => ocsConfigFieldKey(item) === key);
  if (!field) throw new RangeError('此配置键不在固定源码的可编辑字段目录中。');
  const document = parseOcsConfigJson(text);
  if (containsPrivateMarker(document[key])) throw new TypeError('此配置包含已保存的私有占位值，不由普通配置表单覆盖。');
  const validated = validateOcsConfigValue(field, value);
  const result = JSON.stringify({ ...document, [key]: validated }, null, 2);
  if (result.length > 524288) throw new RangeError('编辑后的 OCS 全局配置超过 524288 个字符。');
  return result;
}
