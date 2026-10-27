import { useEffect, useRef, useState } from 'react';
import type { OcsCommand, OcsState } from '../shared/ocs';
import type { ExecuteOcs } from './OcsTypes';

type PronunciationProps = { state: OcsState['pronunciation']; disabled: boolean; execute: ExecuteOcs; source: { id: string; text: string } | null };
type PronunciationCommand = Extract<OcsCommand, { command: 'pronunciation-prepare' | 'pronunciation-speak' | 'pronunciation-stop' }>;
const phaseLabels: Record<OcsState['pronunciation']['phase'], string> = {
  idle: '尚未请求朗读', requested: '已请求朗读', speaking: '播放开始', stopping: '正在停止，等待后台释放', ended: '已结束', stopped: '已停止', failed: '本机朗读失败'
};

async function stopPronunciationOnUnmount(): Promise<void> {
  try {
    const result = await window.ocs.execute({ command: 'pronunciation-stop' });
    if (!result.ok) console.error('Windows pronunciation cleanup stop rejected', { command: 'pronunciation-stop', code: result.error.code, message: result.error.message });
  } catch (cause) {
    console.error('Windows pronunciation cleanup stop request failed', { command: 'pronunciation-stop', error: cause instanceof Error ? cause.name : 'NonErrorRejection', message: cause instanceof Error ? cause.message : 'The local stop request rejected without an Error object.' });
  }
}

export function OcsPronunciation({ state, disabled, execute, source }: PronunciationProps) {
  const [voiceId, setVoiceId] = useState('');
  const [text, setText] = useState('');
  const [rate, setRate] = useState('0');
  const [pending, setPending] = useState<PronunciationCommand['command'] | null>(null);
  const [cancelQueued, setCancelQueued] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef<PronunciationCommand['command'] | null>(null);
  const canceledAfterSpeak = useRef(false);
  const stopInFlight = useRef<Promise<boolean> | null>(null);
  const mounted = useRef(false);
  const generation = useRef(0);
  const sequence = useRef(0);
  const owned = useRef(state.owned);
  const voices = state.voices.filter(voice => /^en(?:[-_]|$)/i.test(voice.language));
  const selectedVoice = voices.find(voice => voice.id === voiceId);
  const locked = disabled || pending !== null || cancelQueued || state.owned;

  useEffect(() => {
    if (submitting.current !== 'pronunciation-speak') owned.current = state.owned;
    if (!state.owned && submitting.current === null) { stopInFlight.current = null; setCancelQueued(false); }
  }, [state, pending]);
  useEffect(() => {
    mounted.current = true;
    generation.current += 1;
    return () => {
      mounted.current = false;
      generation.current += 1;
      canceledAfterSpeak.current = false;
      const stopping = stopInFlight.current;
      if (stopping) void stopping.then(accepted => { if (!accepted) void stopPronunciationOnUnmount(); });
      else if (owned.current || submitting.current === 'pronunciation-speak') void stopPronunciationOnUnmount();
    };
  }, []);

  async function dispatch(command: PronunciationCommand): Promise<boolean> {
    if (submitting.current !== null) return false;
    const currentGeneration = generation.current;
    const request = ++sequence.current;
    const isCurrent = (): boolean => mounted.current && generation.current === currentGeneration && sequence.current === request;
    submitting.current = command.command;
    setPending(command.command);
    setError('');
    let accepted = false;
    try {
      accepted = await execute(command);
      if (isCurrent() && !accepted) setError('本次本机语音请求未确认成功，请查看页面顶部具体错误并刷新状态；在后台确认释放前不要开始新朗读或课程录音。');
    } catch (cause) {
      if (isCurrent()) setError(`本机语音接口请求失败：${cause instanceof Error ? cause.message : String(cause)}。请刷新后台状态后再操作，勿将请求失败视为已停止。`);
    } finally {
      if (isCurrent()) {
        submitting.current = null;
        setPending(null);
        if (command.command === 'pronunciation-speak' && canceledAfterSpeak.current) {
          canceledAfterSpeak.current = false;
          requestStop();
        }
      }
    }
    return accepted;
  }

  function requestStop(): void {
    if (stopInFlight.current || submitting.current === 'pronunciation-stop') return;
    if (submitting.current === 'pronunciation-speak') {
      canceledAfterSpeak.current = true;
      setCancelQueued(true);
      return;
    }
    if (!owned.current || submitting.current !== null) return;
    setCancelQueued(true);
    const currentGeneration = generation.current;
    const operation = dispatch({ command: 'pronunciation-stop' });
    stopInFlight.current = operation;
    void operation.then(accepted => {
      if (!accepted && mounted.current && generation.current === currentGeneration && stopInFlight.current === operation) {
        stopInFlight.current = null;
        setCancelQueued(false);
      }
    });
  }

  function loadSource(): void {
    if (locked || source === null) return;
    if (!source.text.trim()) { setError('当前平台原文为空，未载入或请求朗读；请先读取当前题目。'); return; }
    if (source.text.length > 2000) { setError('当前平台原文超过 2000 字符，未载入、未截断、未请求朗读。请本人从上方原文选择不超过 2000 字符的一段，手动填入练习文本。'); return; }
    setText(source.text);
    setError('');
  }

  function prepare(): void {
    if (locked || submitting.current !== null) return;
    setVoiceId('');
    void dispatch({ command: 'pronunciation-prepare' });
  }

  function speak(): void {
    if (locked || submitting.current !== null) return;
    if (state.catalogue !== 'ready' || !selectedVoice) { setError('请先检测本机英文声音，并明确选择一个 Windows 英文语音；未请求朗读。'); return; }
    if (!text.trim() || text.length > 2000) { setError('请输入 1–2000 个字符的英文练习文本；未请求朗读。'); return; }
    const speed = Number(rate);
    if (!rate.trim() || !Number.isInteger(speed) || speed < -5 || speed > 5) { setError('语速必须为 -5 至 5 的整数，0 为正常语速；未请求朗读。'); return; }
    canceledAfterSpeak.current = false;
    owned.current = true;
    void dispatch({ command: 'pronunciation-speak', voiceId: selectedVoice.id, text: text.trim(), rate: speed });
  }

  return <details className="ocs-box ocs-config-advanced" data-testid="ocs-pronunciation" onToggle={event => { if (!event.currentTarget.open) requestStop(); }}>
    <summary data-testid="ocs-pronunciation-toggle">Windows 本机英语发音练习 · 手动朗读</summary>
    <p className="ocs-help" data-testid="ocs-pronunciation-engine">使用 Windows System.Speech 本机英语语音，不使用浏览器语音或远程后备服务，无需插件。仅朗读本人手动输入或点击载入的当前平台原文；不自动播放、不申请麦克风、不上传或保存文本、不导出音频。</p>
    {source && <div><div className="ocs-actions"><button type="button" className="button secondary" data-testid="ocs-tsinghua-load-transcript" data-question-id={source.id} disabled={locked} onClick={loadSource}>载入当前原文 · 不自动朗读</button></div><p className="ocs-help" data-testid="ocs-pronunciation-source-status">当前原文 {source.text.length} 字符。{source.text.length > 2000 ? '超过 2000 字符，不能整体载入；请本人选择一段手动输入，不会自动截断。' : '点击后替换练习文本；题目刷新不会自动覆盖已输入的文本。'}仍须本人选择音色并点击朗读。</p></div>}
    <div className="ocs-actions"><button type="button" className="button secondary" data-testid="ocs-pronunciation-prepare" disabled={locked} onClick={prepare}>{pending === 'pronunciation-prepare' ? '正在检测…' : '检测本机英文声音'}</button></div>
    <p className="ocs-help" role="status" data-testid="ocs-pronunciation-voices-status" data-status={pending === 'pronunciation-prepare' ? 'loading' : state.catalogue}>{pending === 'pronunciation-prepare' ? '正在检测 Windows 本机英文语音…' : state.catalogue === 'unprepared' ? '尚未检测，请点击上方按钮；不会自动选择语音。' : state.catalogue === 'ready' && voices.length > 0 ? `已检测到 ${voices.length} 个本机英文语音，请手动选择。` : 'Windows 本机语音服务尚未提供可用英文声音，请核对下方后台说明和错误码；不会切换其他语言或远程服务。'}</p>
    <div className="ocs-form-grid">
      <label className="ocs-wide">Windows 本机英文声音<select data-testid="ocs-pronunciation-voice" value={selectedVoice?.id ?? ''} disabled={locked || state.catalogue !== 'ready'} onChange={event => setVoiceId(event.currentTarget.value)}><option value="">请手动选择语音</option>{voices.map(voice => <option key={voice.id} value={voice.id}>{voice.name} · {voice.language}</option>)}</select></label>
      <label className="ocs-wide">英文练习文本（最多 2000 字符）<textarea data-testid="ocs-pronunciation-text" maxLength={2000} rows={3} value={text} disabled={locked} onChange={event => setText(event.currentTarget.value)} placeholder="手动输入要练习的英文，不要填写账号或密钥" /></label>
      <label>语速（-5 至 5，0 正常）<input data-testid="ocs-pronunciation-rate" type="number" min="-5" max="5" step="1" value={rate} disabled={locked} onChange={event => setRate(event.currentTarget.value)} /></label>
    </div>
    <div className="ocs-actions"><button type="button" className="button secondary" data-testid="ocs-pronunciation-speak" disabled={locked || state.catalogue !== 'ready' || !selectedVoice || !text.trim()} onClick={speak}>朗读练习文本</button><button type="button" className="button secondary" data-testid="ocs-pronunciation-stop" disabled={(!state.owned && pending !== 'pronunciation-speak') || cancelQueued || pending === 'pronunciation-stop' || state.phase === 'stopping'} onClick={requestStop}>{cancelQueued || state.phase === 'stopping' ? '已请求停止，等待后台释放…' : '停止本次朗读'}</button></div>
    <p className={state.phase === 'failed' ? 'ocs-error' : 'ocs-help'} role="status" data-testid="ocs-pronunciation-status" data-status={state.phase} data-owned={state.owned}>{phaseLabels[state.phase]}：{state.message}{state.errorCode && `（${state.errorCode}）`}。状态来自后台；请求回执、播放开始或结束事件均不保证本人已听到声音。</p>
    {error && <p className="ocs-error" role="alert" data-testid="ocs-pronunciation-error">{error}</p>}
    <p className="ocs-help" data-testid="ocs-pronunciation-recording-warning">练习不代答、不提交课程，也不能代替语音题的本人录音。录音前先停止朗读，等待后台释放并本人确认声音停止；建议戴耳机，避免声音被误采集。收起朗读区或离开 OCS 页面会请求后台正常取消；仅切换 OCS 标签不会卸载朗读区，请先主动停止。停止确认前不要录音；应用正常退出时后台也会取消本应用持有的朗读。</p>
  </details>;
}
