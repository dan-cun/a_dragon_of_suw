import { z } from 'zod';

const envelopeSchema = z.object({
  id: z.number().optional(), method: z.string().optional(), params: z.unknown().optional(),
  result: z.unknown().optional(), error: z.object({ code: z.number(), message: z.string() }).optional(),
  sessionId: z.string().optional(),
});

export interface CdpConnection {
  send(method: string, params: Record<string, unknown>, sessionId: string | undefined): Promise<unknown>;
  onEvent(listener: (method: string, params: unknown, sessionId: string | undefined) => void): () => void;
  requestBrowserClose(): Promise<void>;
  close(): void;
}

export async function connectCdp(url: string, signal: AbortSignal, onFailure: (error: Error) => void): Promise<CdpConnection> {
  const target = new URL(url);
  if (target.protocol !== 'ws:' || target.hostname !== '127.0.0.1') throw new Error('Edge 调试服务地址不是本机地址。');
  const socket = new WebSocket(url);
  let sequence = 0;
  let closing = false;
  let closeReply: { id: number; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const listeners = new Set<(method: string, params: unknown, sessionId: string | undefined) => void>();
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); socket.removeEventListener('open', open); socket.removeEventListener('error', error); };
    const open = () => { cleanup(); resolve(); };
    const error = () => { cleanup(); reject(new Error('无法连接本机 Edge 认证窗口。')); };
    const abort = () => { cleanup(); socket.close(); reject(new Error('校园认证已取消。')); };
    const timer = setTimeout(() => { cleanup(); socket.close(); reject(new Error('连接 Edge 认证窗口超过 15 秒。')); }, 15_000);
    socket.addEventListener('open', open, { once: true });
    socket.addEventListener('error', error, { once: true });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  const rejectPending = (message: string) => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error(message)); }
    pending.clear();
  };
  socket.addEventListener('message', event => {
    if (typeof event.data !== 'string') { onFailure(new Error('Edge 认证调试返回了无效消息。')); return; }
    let raw: unknown;
    try { raw = JSON.parse(event.data) as unknown; }
    catch (cause) { onFailure(new Error('Edge 认证调试消息不是有效 JSON。', { cause })); return; }
    const parsed = envelopeSchema.safeParse(raw);
    if (!parsed.success) { onFailure(new Error('Edge 认证调试消息结构无效。')); return; }
    const message = parsed.data;
    if (message.id !== undefined) {
      if (closeReply?.id === message.id) {
        const reply = closeReply;
        closeReply = null;
        clearTimeout(reply.timer);
        if (message.error) reply.reject(new Error(`Edge 认证窗口关闭失败（CDP ${message.error.code}）。`));
        else reply.resolve();
        return;
      }
      const request = pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer);
      pending.delete(message.id);
      if (message.error) request.reject(new Error(`Edge 认证操作失败（CDP ${message.error.code}）。`));
      else request.resolve(message.result);
    } else if (message.method) {
      for (const listener of listeners) listener(message.method, message.params, message.sessionId);
    }
  });
  socket.addEventListener('close', () => {
    if (closeReply) { clearTimeout(closeReply.timer); closeReply.resolve(); closeReply = null; }
    rejectPending('Edge 认证连接已关闭。');
    if (!closing) onFailure(new Error('Edge 认证窗口提前关闭，请重新登录。'));
  });
  socket.addEventListener('error', () => { if (!closing) onFailure(new Error('Edge 认证连接发生错误。')); });
  return {
    send(method, params, sessionId) {
      if (socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Edge 认证连接不可用。'));
      const id = ++sequence;
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Edge ${method} 操作超过 30 秒。`)); }, 30_000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async requestBrowserClose() {
      closing = true;
      if (socket.readyState !== WebSocket.OPEN) return;
      await new Promise<void>((resolveClose, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { closeReply = null; reject(new Error('Edge 未响应认证窗口关闭请求。')); }, 5_000);
        closeReply = { id, timer, resolve: resolveClose, reject };
        socket.send(JSON.stringify({ id, method: 'Browser.close', params: {} }));
      });
    },
    close() {
      closing = true;
      rejectPending('校园认证会话已结束。');
      listeners.clear();
      socket.close();
    },
  };
}
