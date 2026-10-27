import { useCallback, useEffect, useRef, useState } from 'react';
import type { OcsCommand, OcsState } from '../shared/ocs';

export function useOcsController() {
  const [state, setState] = useState<OcsState | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [updatedAt, setUpdatedAt] = useState('');
  const mounted = useRef(false);
  const generation = useRef(0);
  const issued = useRef(0);
  const applied = useRef(0);
  const courseEpochs = useRef(new Map<string, number>());
  const pending = useRef(0);
  const mutations = useRef(0);
  const reads = useRef(0);
  const polling = useRef(true);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const execute = useCallback(function enqueue(command: OcsCommand): Promise<boolean> {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    const current = generation.current;
    const request = ++issued.current;
    const courseId = command.command.startsWith('tsinghua-') && 'id' in command ? command.id : null;
    if (command.command === 'tsinghua-stop') courseEpochs.current.set(command.id, (courseEpochs.current.get(command.id) ?? 0) + 1);
    const courseEpoch = courseId === null ? null : courseEpochs.current.get(courseId) ?? 0;
    pending.current += 1;
    if (command.command === 'state') reads.current += 1;
    else mutations.current += 1;
    if (mounted.current) {
      setBusy(mutations.current > 0);
      setRefreshing(reads.current > 0);
    }
    const perform = async (): Promise<boolean> => {
      try {
        if (!mounted.current || current !== generation.current) return false;
        if (courseId !== null && courseEpoch !== (courseEpochs.current.get(courseId) ?? 0)) return false;
        if (!polling.current && command.command !== 'state' && command.command !== 'pronunciation-stop' && command.command !== 'tsinghua-stop') return false;
        const result = await window.ocs.execute(command);
        if (!mounted.current || current !== generation.current) return false;
        if (request < applied.current) return result.ok;
        applied.current = request;
        if (!result.ok) {
          polling.current = false;
          setError(`${result.error.message}（${result.error.code}）`);
          return false;
        }
        setState(result.value);
        setUpdatedAt(new Date().toISOString());
        setError('');
        return true;
      } catch (cause: unknown) {
        if (mounted.current && current === generation.current && request >= applied.current) {
          applied.current = request;
          polling.current = false;
          setError(cause instanceof Error ? cause.message : 'OCS 本机接口请求失败，请手动重新读取状态。');
        }
        return false;
      } finally {
        pending.current -= 1;
        if (command.command === 'state') reads.current -= 1;
        else mutations.current -= 1;
        if (mounted.current && current === generation.current) {
          setBusy(mutations.current > 0);
          setRefreshing(reads.current > 0);
          if (pending.current === 0 && polling.current) {
            timer.current = setTimeout(() => { void enqueue({ command: 'state' }); }, 2000);
          }
        }
      }
    };
    // Keep cancellation independent of a pending navigation and reject stale snapshots.
    const operation = command.command === 'tsinghua-stop' ? perform() : queue.current.then(perform);
    if (command.command !== 'tsinghua-stop') queue.current = operation.then(() => undefined);
    return operation;
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    polling.current = true;
    await execute({ command: 'state' });
  }, [execute]);

  useEffect(() => {
    mounted.current = true;
    generation.current += 1;
    polling.current = true;
    void execute({ command: 'state' });
    return () => {
      mounted.current = false;
      generation.current += 1;
      polling.current = false;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [execute]);

  return { state, busy, refreshing, error, updatedAt, execute, refresh };
}
