import { z } from 'zod';
import type { Profile, RequestMetrics, Task } from '../shared/contracts';
import { DakaError, redact, sanitizedCause } from './errors';
import { isDate, isTime } from './time';

const ROOT = 'https://of.swu.edu.cn/gateway/';
const BAIDA = 'fighter-baida/api/';
const MAX_BYTES = 2 * 1024 * 1024;
// Preserve the request headers observed in the official mobile form protocol.
const MOBILE_USER_AGENT = 'Mozilla/5.0 (Linux; U; Android 12; zh-CN; ALN-AL80 Build/HUAWEIALN-AL80) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/100.0.4896.58 UWS/5.12.11.0 Mobile Safari/537.36 AliApp(DingTalk/7.8.5.1) com.alibaba.android.rimet.diswu/PIS756181878951764992 Channel/exclusive_dingtalk_263387052 language/zh-CN 2ndType/exclusive abi/64 Hmos/4.2.0 xpn/huawei UT4Aplus/0.2.25 colorScheme/light';
const text = z.string().trim().min(1).max(500);
const date = text.refine(isDate, 'Invalid calendar date');
const time = text.refine(isTime, 'Expected HH:mm');
const id = z.union([text, z.number().int().nonnegative()]).transform(String);
const result = z.union([z.literal('0'), z.literal('1'), z.literal(0), z.literal(1)]).transform(String);
const profileSchema = z.object({
  subject: z.object({ username: text.optional(), loginName: text.optional(), realname: text })
    .refine((subject) => subject.username !== undefined || subject.loginName !== undefined, 'Missing account name')
    .transform((subject): Profile => ({ username: subject.username ?? subject.loginName!, displayName: subject.realname })),
}).transform((data) => data.subject);
const recordSchema = z.object({
  id, formId: text, tsrq: date, qdzt: text,
  cqzmc: text.optional(), title: text.optional(), name: text.optional(),
  qdkssj: time.optional(), qdjssj: time.optional(),
}).refine((record) => record.cqzmc !== undefined || record.title !== undefined || record.name !== undefined, 'Missing task title');
const pageSchema = z.object({ records: z.array(recordSchema).max(100), total: z.number().int().nonnegative().max(1000).optional() });
const selectedSchema = z.object({
  // The school returns an empty dormitory formId before the first submission.
  // Preserve it for getDormitory; save uses the non-empty formId from the task list.
  id: id.optional(), formId: z.string().trim().max(500), cqfbid: text, xh: text, tsrq: date, qdjg: result,
  qdsj: z.tuple([time, time]), qsqddd: z.string().max(500), qdbj: z.union([z.string().max(100), z.number().nonnegative()]).transform(String),
  isArchive: z.string().max(100).optional(), ycdksfcl: z.string().max(100).optional(),
});
const selectedResponseSchema = selectedSchema.partial({ qdsj: true });
const dormitorySchema = z.object({ columnList: z.array(z.object({
  prop: z.string().max(100).optional(),
  value: z.union([z.string().max(500), z.number()]).optional(),
  address: z.string().max(500).optional(),
  qdbj: z.union([z.string().max(100), z.number().nonnegative()]).optional(),
})).max(500) });
const verificationSchema = z.object({ isArea: z.boolean(), tip: z.string().max(500) });
const envelope = z.object({ code: z.number().int(), msg: z.string().max(2000).optional(), message: z.string().max(2000).optional(), data: z.unknown() });

export type TaskRecord = z.infer<typeof recordSchema>;
export type SelectedForm = z.infer<typeof selectedSchema>;
export type Dormitory = z.infer<typeof dormitorySchema>;
export type Verification = z.infer<typeof verificationSchema>;

export interface MapData {
  latitude: number;
  longitude: number;
  accuracy: number;
  time: number;
  address: string;
  isOffset: true;
}

export interface DormitoryPayload {
  formId: string;
  isArchive: string;
  qdjg: string;
  tsrq: string;
  qsqddd: string;
  qdbj: string;
  xh: string;
  dksj: string;
  selectMap: string;
  ycdksfcl: string;
  id: string;
  cqfbid: string;
  qdtj: string;
  qddz: MapData | string;
  qdsj: [string, string];
}

export interface SavePayload {
  id: string;
  qdjg: '0';
  $qdjg: '未签到';
  cqfbid: string;
  formId: string;
  qdtj: '1';
  tsrq: string;
  ycdksfcl: string;
  isArchive: string;
  xh: string;
  dksj: string;
  qdsj: [string, string];
  qsqddd: string;
  qdbj: string;
  qddz: MapData & Verification;
  businessKey: string;
}

export interface ReportEntry {
  level: 'info' | 'warning' | 'error';
  event: string;
  message: string;
  request?: RequestMetrics;
}

export interface SwuClient {
  profile(token: string): Promise<Profile>;
  tasksPage(token: string, page: number): Promise<z.infer<typeof pageSchema>>;
  select(token: string, task: TaskReference): Promise<SelectedForm>;
  dormitory(token: string, payload: DormitoryPayload): Promise<Dormitory>;
  verify(token: string, taskId: string, map: MapData): Promise<Verification>;
  save(token: string, payload: SavePayload): Promise<void>;
}

export interface TaskReference extends Pick<Task, 'id' | 'formId'> {
  qdkssj?: string;
  qdjssj?: string;
  window?: [string, string];
}

interface RequestOptions {
  method: 'GET' | 'POST';
  query: URLSearchParams;
  body: FormData | string | undefined;
  contentType: string | undefined;
  readOnly: boolean;
}

async function readBody(response: Response): Promise<string> {
  const advertised = Number(response.headers.get('content-length'));
  if (advertised > MAX_BYTES) throw new DakaError('RESPONSE_TOO_LARGE', '服务端响应超过 2 MB 上限。', undefined);
  if (response.body === null) throw new DakaError('INVALID_RESPONSE', '服务端返回了空响应。', undefined);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel();
        throw new DakaError('RESPONSE_TOO_LARGE', '服务端响应超过 2 MB 上限。', undefined);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new DakaError('INVALID_RESPONSE', '服务端响应不是有效的 UTF-8 文本。', error instanceof Error ? error : undefined);
  }
}

export function createClient(fetchImpl: typeof fetch, report: (entry: ReportEntry) => void): SwuClient {
  async function request<T>(token: string, path: string, options: RequestOptions, schema: z.ZodType<T>): Promise<T> {
    if (token.trim().length === 0 || /[\r\n]/.test(token)) throw new DakaError('AUTH_REQUIRED', '请先完成校园统一身份认证。', undefined);
    const url = new URL(path, ROOT);
    url.search = options.query.toString();
    const maxAttempts = options.readOnly ? 3 : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20_000);
      let transient = false;
      const startedAt = performance.now();
      let httpStatus: number | null = null;
      let businessCode: number | null = null;
      let responseBytes: number | null = null;
      try {
        const headers: Record<string, string> = {
          Accept: 'application/json', 'fighter-auth-token': token,
          Origin: 'https://of.swu.edu.cn', Referer: 'https://of.swu.edu.cn/baidaForm/',
          Cookie: `access_token=${token}`, 'X-Requested-With': 'com.alibaba.android.rimet.diswu',
          'User-Agent': MOBILE_USER_AGENT,
        };
        if (options.contentType !== undefined) headers['Content-Type'] = options.contentType;
        const response = await fetchImpl(url, {
          method: options.method, headers, body: options.body, signal: controller.signal, redirect: 'error',
        });
        httpStatus = response.status;
        if (!response.ok) {
          transient = response.status === 408 || response.status === 429 || response.status >= 500;
          throw new DakaError(response.status === 401 || response.status === 403 ? 'AUTH_REQUIRED' : 'HTTP_ERROR',
            `${url.pathname} 请求失败，HTTP ${response.status}。${response.status === 401 || response.status === 403 ? '请重新登录。' : ''}`, undefined);
        }
        const body = await readBody(response);
        responseBytes = new TextEncoder().encode(body).byteLength;
        let decoded: unknown;
        try { decoded = JSON.parse(body); }
        catch (error) { throw new DakaError('INVALID_RESPONSE', `${url.pathname} 返回了无效 JSON，请检查校园服务状态。`, error instanceof Error ? sanitizedCause(error, [token]) : undefined); }
        const parsedEnvelope = envelope.safeParse(decoded);
        if (!parsedEnvelope.success) throw new DakaError('INVALID_RESPONSE', `${url.pathname} 响应缺少有效业务状态。`, undefined);
        const data = parsedEnvelope.data;
        businessCode = data.code;
        if (data.code !== 200) {
          throw new DakaError(data.code === 401 || data.code === 403 ? 'AUTH_REQUIRED' : 'BUSINESS_ERROR',
            `${url.pathname} 业务操作失败（${data.code}）：${redact(data.msg ?? data.message ?? '服务端未提供错误说明', [token])}`, undefined);
        }
        const parsed = schema.safeParse(data.data);
        if (!parsed.success) {
          const fields = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
          throw new DakaError('INVALID_RESPONSE', `${url.pathname} 响应字段无效：${fields || 'data'}。请使用官方页面检查任务。`, undefined);
        }
        return parsed.data;
      } catch (error) {
        let failure: DakaError;
        if (controller.signal.aborted) {
          transient = true;
          failure = new DakaError('TIMEOUT', `${url.pathname} 请求超过 20 秒。`, error instanceof Error ? sanitizedCause(error, [token]) : undefined);
        } else if (error instanceof DakaError) {
          failure = error;
        } else if (error instanceof TypeError) {
          transient = true;
          failure = new DakaError('NETWORK_ERROR', `${url.pathname} 网络连接失败：${redact(error.message, [token])}`, sanitizedCause(error, [token]));
        } else {
          failure = new DakaError('INVALID_RESPONSE', `${url.pathname} 无法读取响应：${error instanceof Error ? redact(error.message, [token]) : '未知读取错误'}。`, error instanceof Error ? sanitizedCause(error, [token]) : undefined);
        }
        if (!transient) throw failure;
        if (attempt === maxAttempts) {
          if (options.readOnly) throw new DakaError('RETRY_EXHAUSTED', failure.message, failure);
          throw failure;
        }
        report({ level: 'warning', event: 'request.retry', message: `${failure.message} 正在进行第 ${attempt + 1}/${maxAttempts} 次只读请求。` });
      } finally {
        clearTimeout(timeout);
        report({ level: 'info', event: 'request.completed', message: '学校接口请求结束。', request: {
          host: url.hostname, path: url.pathname, method: options.method, httpStatus, businessCode, responseBytes,
          elapsedMs: Math.round(performance.now() - startedAt), attempt,
        } });
      }
      await new Promise<void>((resolve) => setTimeout(resolve, attempt * 300));
    }
    throw new DakaError('NETWORK_ERROR', '请求重试次数耗尽。', undefined);
  }

  return {
    profile(token) {
      return request(token, 'fighter-middle/api/auth/user', { method: 'GET', query: new URLSearchParams({ appType: 'fighter-portal' }), body: undefined, contentType: undefined, readOnly: true }, profileSchema);
    },
    tasksPage(token, page) {
      const body = new FormData();
      body.set('pageNum', String(page)); body.set('pageSize', '20');
      return request(token, `${BAIDA}cqtj/getTransitionByToday`, { method: 'POST', query: new URLSearchParams(), body, contentType: undefined, readOnly: true }, pageSchema);
    },
    async select(token, task) {
      const selected = await request(token, `${BAIDA}form-instance/select`, { method: 'GET', query: new URLSearchParams({ dataId: task.id, formId: task.formId, procDefId: '' }), body: undefined, contentType: undefined, readOnly: true }, selectedResponseSchema);
      const window = selected.qdsj ?? (task.qdkssj !== undefined && task.qdjssj !== undefined ? [task.qdkssj, task.qdjssj] : task.window);
      const validated = selectedSchema.safeParse({ ...selected, qdsj: window });
      if (!validated.success) throw new DakaError('INVALID_RESPONSE', '表单与同一任务都未提供有效签到时段，请使用官方页面。', undefined);
      return validated.data;
    },
    dormitory(token, payload) {
      return request(token, `${BAIDA}cqlc/getDormitory`, { method: 'POST', query: new URLSearchParams(), body: JSON.stringify(payload), contentType: 'application/json;charset=UTF-8', readOnly: true }, dormitorySchema);
    },
    verify(token, taskId, map) {
      return request(token, `${BAIDA}cqlc/verify`, { method: 'POST', query: new URLSearchParams({ businessKey: taskId }), body: JSON.stringify({ mapData: map }), contentType: 'application/json;charset=UTF-8', readOnly: true }, verificationSchema);
    },
    async save(token, payload) {
      await request(token, `${BAIDA}form-instance/save`, { method: 'POST', query: new URLSearchParams({ formId: payload.formId, isSubmitProcess: 'false' }), body: JSON.stringify(payload), contentType: 'application/json;charset=UTF-8', readOnly: false }, z.unknown());
    },
  };
}
