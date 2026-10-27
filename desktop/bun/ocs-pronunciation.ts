import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import pronunciationScript from '../native/pronunciation.ps1' with { type: 'file' };
import { powershellPath } from './native';
import { ocsPronunciationSpeakSchema, ocsPronunciationStateSchema, ocsPronunciationVoiceSchema, type OcsPronunciationSpeak, type OcsPronunciationState, type OcsPronunciationVoice } from '../shared/ocs-pronunciation';

type Reporter = (level: 'info' | 'warning' | 'error', event: string, message: string) => void;
const nativeCodeSchema = z.enum(['INVALID_REQUEST', 'VOICE_UNAVAILABLE', 'VOICE_MISMATCH', 'NATIVE_INITIALIZATION_FAILED', 'NATIVE_SPEECH_ERROR', 'NATIVE_CANCEL_FAILED', 'NATIVE_DISPOSE_FAILED']);
const eventSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('catalogue'), voices: z.array(ocsPronunciationVoiceSchema).max(100) }).strict(),
  z.object({ event: z.literal('accepted') }).strict(), z.object({ event: z.literal('speaking') }).strict(),
  z.object({ event: z.literal('completed'), cancelled: z.boolean(), errorCode: z.literal('NATIVE_SPEECH_ERROR').nullable() }).strict(),
  z.object({ event: z.literal('failed'), code: nativeCodeSchema }).strict(), z.object({ event: z.literal('closed') }).strict()
]);
type NativeEvent = z.infer<typeof eventSchema>;
interface Deferred { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void }
interface Owner {
  kind: 'prepare' | 'speak'; child: ChildProcessWithoutNullStreams; accepted: Deferred; closed: Deferred;
  closedEvent: boolean; processClosed: boolean; catalogue: OcsPronunciationVoice[] | null; acknowledged: boolean;
  completion: Extract<NativeEvent, { event: 'completed' }> | null; cancelled: boolean; failure: Error | null;
}

function deferred(): Deferred {
  let resolve: () => void = () => { throw new Error('TTS promise was not initialized.'); };
  let reject: (error: Error) => void = () => { throw new Error('TTS promise was not initialized.'); };
  const promise = new Promise<void>((accept, decline) => { resolve = accept; reject = decline; });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

async function bounded(operation: Promise<void>, milliseconds: number, message: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([operation, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new DOMException(message, 'TimeoutError')), milliseconds); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

/** Own one local Windows speech connector; neither text nor native stderr enters public state or logs. */
export function createOcsPronunciationService(report: Reporter) {
  let state: OcsPronunciationState = { engine: 'windows-system-speech', catalogue: 'unprepared', voices: [], phase: 'idle', owned: false, message: '尚未准备 Windows 本机英语音色；仅在本人点击准备后枚举。', errorCode: null };
  let owner: Owner | null = null;
  function change(next: OcsPronunciationState): void {
    state = ocsPronunciationStateSchema.parse(next);
    report(state.phase === 'failed' ? 'error' : 'info', 'pronunciation.state', JSON.stringify({ engine: state.engine, phase: state.phase, catalogue: state.catalogue, owned: state.owned, errorCode: state.errorCode }));
  }
  function fail(current: Owner, code: string, message: string): Error {
    if (current.failure !== null) return current.failure;
    const error = new Error(message);
    current.failure = error;
    current.accepted.reject(error);
    if (owner === current) change({ ...state, catalogue: current.kind === 'prepare' ? 'unavailable' : state.catalogue, phase: 'failed', owned: true, message, errorCode: code });
    return error;
  }
  function cancel(current: Owner): void {
    if (current.cancelled || current.closedEvent || current.processClosed) return;
    current.cancelled = true;
    if (current.child.stdin.writableEnded) return;
    try { current.child.stdin.end(JSON.stringify({ command: 'cancel' }) + '\n', 'utf8'); }
    catch { fail(current, 'NATIVE_CANCEL_FAILED', '无法发送 Windows 语音取消请求；进程未被强杀，所有权保留。'); }
  }
  function event(current: Owner, value: NativeEvent): void {
    if (current.closedEvent) throw new TypeError('Windows TTS 在 closed 之后仍输出事件。');
    switch (value.event) {
      case 'catalogue':
        if (current.kind !== 'prepare' || current.catalogue !== null || value.voices.some(voice => !/^en(?:-|$)/i.test(voice.language)) || new Set(value.voices.map(voice => voice.id)).size !== value.voices.length) throw new TypeError('Windows TTS 音色目录协议无效。');
        current.catalogue = value.voices;
        current.accepted.resolve();
        return;
      case 'accepted':
        if (current.kind !== 'speak' || current.acknowledged) throw new TypeError('Windows TTS 接受事件重复或顺序无效。');
        current.acknowledged = true;
        current.accepted.resolve();
        return;
      case 'speaking':
        if (!current.acknowledged || current.completion !== null) throw new TypeError('Windows TTS 开始事件顺序无效。');
        if (owner === current && !current.cancelled && !current.failure) change({ ...state, phase: 'speaking', message: 'Windows 正在本机朗读；未录音、导出或向课程平台提交。' });
        return;
      case 'completed':
        if (!current.acknowledged || current.completion !== null) throw new TypeError('Windows TTS 完成事件顺序无效。');
        current.completion = value;
        if (value.errorCode) fail(current, value.errorCode, 'Windows 语音合成完成回调报告错误；原生错误正文未回显，请检查本机音色和音频设备。');
        return;
      case 'failed':
        report('error', 'pronunciation.native.failed', JSON.stringify({ code: value.code }));
        fail(current, value.code, 'Windows 本机语音连接器失败（' + value.code + '）；未回显朗读文本或原生错误正文。');
        return;
      case 'closed': current.closedEvent = true; return;
    }
  }
  function launch(kind: Owner['kind']): Owner {
    if (owner) throw new DOMException('仍持有上一次 Windows 语音连接器；请先停止并确认正常关闭，不能发起第二次朗读。', 'InvalidStateError');
    let child: ChildProcessWithoutNullStreams;
    try {
      const encoded = Buffer.from(readFileSync(pronunciationScript, 'utf8'), 'utf16le').toString('base64');
      child = spawn(powershellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded], { windowsHide: true, stdio: 'pipe' });
    } catch {
      const message = 'Windows 本机语音运行环境不可用，请检查系统 Windows PowerShell 5.1 和固定语音脚本资源；未尝试浏览器或云端语音。';
      change({ ...state, catalogue: kind === 'prepare' ? 'unavailable' : state.catalogue, phase: 'failed', owned: false, message, errorCode: 'NATIVE_RUNTIME_UNAVAILABLE' });
      throw new Error(message);
    }
    const current: Owner = { kind, child, accepted: deferred(), closed: deferred(), closedEvent: false, processClosed: false, catalogue: null, acknowledged: false, completion: null, cancelled: false, failure: null };
    owner = current;
    change({ ...state, phase: kind === 'speak' ? 'requested' : 'idle', owned: true, message: kind === 'speak' ? '已请求 Windows 本机朗读，正在等待语音连接器确认。' : '正在枚举 Windows 已启用的本机英语音色。', errorCode: null });
    let output = '';
    let outputBytes = 0;
    let errorBytes = 0;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk, 'utf8');
      if (outputBytes > 262_144) { fail(current, 'NATIVE_PROTOCOL_LIMIT', 'Windows 语音输出超过有界协议限制；所有权保留，请停止。'); cancel(current); return; }
      output += chunk;
      if (output.length > 131_072) { fail(current, 'NATIVE_PROTOCOL_LIMIT', 'Windows 语音单行输出超过限制；所有权保留，请停止。'); cancel(current); return; }
      let newline = output.indexOf('\n');
      while (newline >= 0) {
        const line = output.slice(0, newline).trim();
        output = output.slice(newline + 1);
        try {
          if (!line) throw new TypeError('Empty native event.');
          const decoded: unknown = JSON.parse(line);
          event(current, eventSchema.parse(decoded));
        } catch { fail(current, 'NATIVE_PROTOCOL_INVALID', 'Windows 语音连接器返回无效事件；没有回显原始输出，所有权保留。'); cancel(current); }
        newline = output.indexOf('\n');
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      errorBytes += chunk.length;
      fail(current, 'NATIVE_STDERR', 'Windows 语音连接器报告诊断错误；为保护朗读文本，不回显 stderr。');
      cancel(current);
    });
    child.stdin.on('error', () => { fail(current, 'NATIVE_INPUT_FAILED', 'Windows 语音控制通道失败；未确认关闭前所有权保留。'); });
    child.once('error', () => { fail(current, 'NATIVE_PROCESS_FAILED', '无法正常启动或控制 Windows PowerShell 5.1 语音进程；未回显进程参数。'); });
    child.once('close', (code: number | null) => {
      current.processClosed = true;
      if (output.trim() || errorBytes > 0 || !current.closedEvent || code !== 0 || (kind === 'prepare' ? current.catalogue === null : current.completion === null)) fail(current, 'NATIVE_CLOSE_UNCONFIRMED', 'Windows 语音进程已退出，但完整事件或正常清理未确认；本次任务失败。');
      if (owner === current) {
        owner = null;
        if (current.failure) {
          change({ ...state, phase: 'failed', owned: false, message: '本次 Windows 语音任务失败，但子进程已真实退出并释放所有权；原始安全错误码保留，可重新准备或关闭。' });
        } else if (kind === 'prepare' && current.catalogue !== null) {
          const voices = current.catalogue;
          change({ ...state, catalogue: voices.length ? 'ready' : 'unavailable', voices, phase: 'idle', owned: false, message: voices.length ? '本机英语音色已准备；请显式选择音色后朗读，不会使用云端或默认音色。' : 'Windows 未发现已启用的英语音色，请在系统语音设置安装并启用英语音色后重新准备。', errorCode: voices.length ? null : 'NO_ENGLISH_VOICE' });
        } else {
          const stopped = current.completion?.cancelled === true;
          change({ ...state, phase: stopped ? 'stopped' : 'ended', owned: false, message: stopped ? 'Windows 已确认取消并正常关闭本次语音连接器。' : 'Windows 完成回调无错误，语音连接器已正常关闭；不代表本人已听见或课程完成。', errorCode: null });
        }
      }
      if (current.failure) current.closed.reject(current.failure);
      else current.closed.resolve();
    });
    return current;
  }
  function send(current: Owner, command: { command: 'prepare' } | { command: 'speak'; voiceId: string; text: string; rate: number }): void {
    try { current.child.stdin.write(JSON.stringify(command) + '\n', 'utf8'); }
    catch { throw fail(current, 'NATIVE_INPUT_FAILED', '无法向 Windows 语音连接器发送请求；未回显文本，所有权保留。'); }
  }
  async function stop(): Promise<void> {
    const current = owner;
    if (!current) return;
    if (!current.failure) change({ ...state, phase: 'stopping', message: '正在取消本次语音，并等待 Windows 连接器完成清理和真实关闭。', errorCode: null });
    cancel(current);
    try { await bounded(current.closed.promise, 15_000, '等待 Windows 语音取消或真实关闭超过 15 秒；进程未被强杀，所有权保留。'); }
    catch { throw fail(current, 'NATIVE_STOP_FAILED', 'Windows 语音停止未被完整确认；所有权保留，禁止新朗读，请检查音频设备和保留的连接器。'); }
  }
  return {
    snapshot: (): OcsPronunciationState => ocsPronunciationStateSchema.parse(state),
    async prepare(): Promise<void> {
      const current = launch('prepare');
      send(current, { command: 'prepare' });
      current.child.stdin.end();
      try { await bounded(current.closed.promise, 15_000, 'Windows 英语音色枚举超过 15 秒；所有权保留。'); }
      catch { cancel(current); throw fail(current, 'NATIVE_PREPARE_FAILED', 'Windows 英语音色准备失败或超时；所有权保留，不使用默认或云端音色。'); }
    },
    async speak(input: OcsPronunciationSpeak): Promise<void> {
      const parsed = ocsPronunciationSpeakSchema.safeParse(input);
      if (!parsed.success) throw new TypeError('本机朗读参数无效：必须明确选择音色，提供 1–2000 字符纯文本及 -5 至 5 的整数语速；未回显输入。');
      if (state.catalogue !== 'ready') throw new DOMException('请先显式准备 Windows 本机英语音色；当前没有可用目录，不自动选择或请求云端。', 'InvalidStateError');
      if (!state.voices.some(voice => voice.id === parsed.data.voiceId)) throw new RangeError('所选音色不在已准备的本机英语音色目录中，请重新准备并选择。');
      const current = launch('speak');
      send(current, { command: 'speak', voiceId: parsed.data.voiceId, text: parsed.data.text, rate: parsed.data.rate });
      try { await bounded(current.accepted.promise, 15_000, 'Windows 语音请求确认超过 15 秒；所有权保留。'); }
      catch { cancel(current); throw fail(current, 'NATIVE_ACK_FAILED', 'Windows 未确认接受本次朗读，或语音初始化失败；已请求正常取消，所有权保留至完整清理。'); }
    },
    stop,
    close: stop
  };
}
