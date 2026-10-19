import type { AppState } from '../shared/contracts';

interface StateSource {
  getState(): AppState;
  subscribe(listener: (state: AppState) => void): () => void;
}

export function createStateStream(source: StateSource, signal: AbortSignal): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let onAbort: (() => void) | null = null;
  function cleanup(): void {
    stopped = true;
    unsubscribe?.();
    if (heartbeat !== null) clearInterval(heartbeat);
    if (onAbort !== null) signal.removeEventListener('abort', onAbort);
  }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (signal.aborted) { cleanup(); controller.close(); return; }
      function write(value: string): void {
        if (stopped) return;
        try { controller.enqueue(encoder.encode(value)); }
        catch (cause) {
          cleanup();
          console.warn(JSON.stringify({ event: 'state-stream.write-failed', message: 'Local state client disconnected; subscription removed.' }));
          controller.error(cause);
        }
      }
      onAbort = () => { if (!stopped) { cleanup(); controller.close(); } };
      signal.addEventListener('abort', onAbort, { once: true });
      unsubscribe = source.subscribe(state => write(`event: state\ndata: ${JSON.stringify(state)}\n\n`));
      heartbeat = setInterval(() => write(': heartbeat\n\n'), 15_000);
      write(`event: state\ndata: ${JSON.stringify(source.getState())}\n\n`);
    },
    cancel() { cleanup(); }
  });
}
