import { useState } from 'react';
import type { OcsBrowser, OcsState } from '../shared/ocs';
import { TSINGHUA_LEGACY_HOME, type TsinghuaResult, type TsinghuaState } from '../shared/ocs-tsinghua';
import { OcsPronunciation } from './OcsPronunciation';
import { formatTime, type ConfirmOcs, type ExecuteOcs } from './OcsTypes';

type TsinghuaProps = { state: OcsState; browser: OcsBrowser; disabled: boolean; execute: ExecuteOcs; confirm: ConfirmOcs };
const phaseLabels: Record<TsinghuaState['phase'], string> = {
  idle: '尚未开始', opening: '正在打开旧版入口', 'awaiting-login': '等待本人登录', 'selecting-course': '请选择课程',
  navigating: '正在进入课程与练习', ready: '练习已就绪', running: '正在处理普通题', playing: '正在正常播放媒体',
  'awaiting-recording': '等待本人录音', 'awaiting-result': '等待平台结果', stopping: '正在停止，等待后台释放',
  stopped: '任务已停止', completed: '任务已结束，需核对平台结果', failed: '任务失败'
};
const resultSources: Record<TsinghuaResult['source'], string> = {
  'exercise-submit': '平台练习提交响应', 'exercise-record': '平台练习记录', 'course-score': '平台课程成绩', page: '平台页面'
};
const activePhases: TsinghuaState['phase'][] = ['opening', 'navigating', 'running', 'playing', 'awaiting-recording', 'awaiting-result', 'stopping'];

function PlatformResult({ result }: { result: TsinghuaResult | null }) {
  return <section className="ocs-box" data-testid="ocs-tsinghua-result">
    <h3>平台结果 · 不以 HTTP 200 判断成功</h3>
    <dl className="ocs-tsinghua-metrics">
      <div><dt>{result?.source === 'course-score' ? '课程综合成绩（非本题评分）' : result?.source === 'exercise-submit' || result?.source === 'exercise-record' ? '本题成绩' : '平台成绩（评分范围未验证）'}</dt><dd data-testid="ocs-tsinghua-grade">{result?.score == null ? '尚未验证' : `${result.score}${result.maximumScore === null ? '（满分未提供）' : ` / ${result.maximumScore}`}`}</dd></div>
      <div><dt>正确率</dt><dd data-testid="ocs-tsinghua-accuracy">{result?.accuracyPercent == null ? '尚未验证' : `${result.accuracyPercent}%`}</dd></div>
      <div><dt>正确题数 / 总题数</dt><dd>{result?.correctCount == null ? '未提供' : result.correctCount} / {result?.totalCount == null ? '未提供' : result.totalCount}</dd></div>
      <div><dt>学习进度</dt><dd>{result?.completionPercent == null ? '尚未验证' : `${result.completionPercent}%（不是成绩）`}</dd></div>
    </dl>
    {result ? <>
      <p className="ocs-help" data-testid="ocs-tsinghua-score-source">读取来源：{resultSources[result.source]} · HTTP {result.httpStatus === null ? '未提供' : result.httpStatus} · 平台接受状态：{result.accepted === null ? '尚未验证' : result.accepted ? '平台报告已接受，不等于答对或课程完成' : '平台报告未接受'}</p>
      <p className="ocs-help" data-testid="ocs-tsinghua-score-time">记录时间：{formatTime(result.observedAt)}</p>
      <p className="ocs-help">{result.message}</p>
    </> : <p className="ocs-help" data-testid="ocs-tsinghua-score-source">尚无平台结果。已打开页面、已提交请求或任务结束均不是成绩证据。</p>}
  </section>;
}

export function OcsTsinghua({ state, browser, disabled: operationDisabled, execute, confirm }: TsinghuaProps) {
  const [opening, setOpening] = useState(false);
  const [sliderError, setSliderError] = useState('');
  const disabled = operationDisabled || opening;
  const study = state.tsinghua.find(item => item.browserId === browser.id);
  const question = study?.question;
  const canResume = study !== undefined && !study.owned && ['awaiting-result', 'awaiting-recording'].includes(study.phase) && question?.answered === true && study.result !== null && study.result.score !== null && ['exercise-submit', 'exercise-record'].includes(study.result.source);
  const active = opening || (study !== undefined && (study.owned || (activePhases.includes(study.phase) && !canResume)));
  const runningBrowser = browser.owned && browser.phase === 'running';
  const awaitingRecording = study?.phase === 'awaiting-recording';
  const source = awaitingRecording && question ? { id: `${browser.id}:${question.id}`, text: question.referenceText } : null;
  const startReason = disabled ? '后台操作中或状态读取失败，请恢复状态后再开始。'
    : active ? '当前任务尚未释放，请先完成或停止。'
    : !runningBrowser ? '请先打开旧版课程入口。'
    : !study || study.courseId === null ? '请先明确选择平台课程。'
    : !study.script.installed || !study.script.enabled || study.script.adapterVersion === null ? '需要已安装、已启用并由后台确认的受控适配脚本。'
    : !['ready', 'stopped', 'completed'].includes(study.phase) && !canResume ? '请先读取当前练习，等待后台确认就绪。'
    : state.pronunciation.owned ? '本机朗读尚未释放，请先停止朗读。' : '';

  async function openLegacy(): Promise<void> {
    if (disabled || active || state.phase !== 'ready') return;
    setOpening(true);
    try {
      await execute({ command: 'tsinghua-open', id: browser.id });
    } finally {
      setOpening(false);
    }
  }

  async function verifySlider(): Promise<void> {
    if (disabled || !runningBrowser || study?.phase !== 'awaiting-login') return;
    setSliderError('');
    const accepted = await execute({ command: 'tsinghua-verify-slider', id: browser.id, confirmed: true });
    if (!accepted) setSliderError('本次滑块验证、登录与课程导航流程未完成，请查看页面顶部的具体错误，并由本人处理；课程导航失败不代表登录失败。软件不会刷新挑战、再次点击登录或自动重试，也不会提交题目。');
  }

  function selectCourse(value: string): void {
    const courseId = Number(value);
    if (disabled || active || !Number.isInteger(courseId) || !study?.courses.some(course => course.id === courseId)) return;
    void execute({ command: 'tsinghua-select-course', id: browser.id, courseId });
  }

  return <section className="ocs-box ocs-stack" data-testid="ocs-tsinghua-panel" data-browser-id={browser.id}>
    <div className="ocs-section-heading"><h3>清华社旧版 · 课程与练习</h3><span className="ocs-count">{browser.name}</span></div>
    <p className="ocs-help">从旧版首页发现课程，或进入此浏览器已保存的课程。普通题提交须独立确认；听力和视频正常播放，口语由本人在平台录音，软件不自动点击录音或上传合成语音。</p>
    <code className="ocs-path">{TSINGHUA_LEGACY_HOME}</code>
    <div className="ocs-actions">
      <button type="button" className="button secondary" data-testid="ocs-tsinghua-open-legacy" disabled={disabled || active || state.phase !== 'ready'} onClick={() => void openLegacy()}>打开旧版课程入口</button>
      <button type="button" className="button secondary" data-testid="ocs-tsinghua-refresh" disabled={disabled || !runningBrowser} onClick={() => void execute({ command: 'tsinghua-refresh', id: browser.id })}>读取当前课程与练习</button>
      <button type="button" className="button secondary" data-testid="ocs-tsinghua-stop" disabled={!active} onClick={() => void execute({ command: 'tsinghua-stop', id: browser.id })}>{study?.phase === 'stopping' ? '再次请求停止任务' : '停止本次任务'}</button>
    </div>
    <p className={study?.phase === 'failed' ? 'ocs-error' : 'ocs-help'} role="status" data-testid="ocs-tsinghua-status" data-phase={opening ? 'opening' : study?.phase ?? 'idle'} data-owned={study?.owned ?? false}>{opening ? '正在打开旧版入口；可请求停止，需等待已接受的浏览器启动与取消结算。' : study ? `${phaseLabels[study.phase]}：${study.message}` : '尚未读取此浏览器的旧版课程状态；打开入口不会自动提交练习。'}</p>
    {study?.errorCode && <p className="ocs-error" role="alert" data-testid="ocs-tsinghua-error">后台错误码：{study.errorCode}。{study.message}</p>}
    {study?.phase === 'awaiting-login' && runningBrowser && !disabled && <section className="ocs-box">
      <p className="ocs-help" data-testid="ocs-tsinghua-slider-scope">仅对本人当前清华社登录页拖动一次滑块，验证通过后使用页面现有填写内容点击登录一次；不读取或填写账号密码、不读取 Cookie、不刷新挑战、不自动重试、不提交题目。等待离开登录页且登录控件消失后才确认登录并自动发现课程；点击不代表登录成功，失败会明确提示并交由本人处理。</p>
      <div className="ocs-actions"><button type="button" className="button secondary" data-testid="ocs-tsinghua-slider-once" onClick={() => void verifySlider()}>滑块验证并登录（一次）</button></div>
    </section>}
    {sliderError && <p className="ocs-error" role="alert" data-testid="ocs-tsinghua-slider-error">{sliderError}</p>}
    {study && <p className="ocs-help" data-testid="ocs-tsinghua-updated-at">最近读取：{formatTime(study.updatedAt)} · {study.owned ? '后台仍持有任务，停止后需等待释放' : '后台未持有任务'} · 适配版本：{study.script.adapterVersion ?? '尚未确认'}</p>}
    <label className="ocs-tsinghua-course">平台课程<select data-testid="ocs-tsinghua-course-select" value={study?.courseId ?? ''} disabled={disabled || active || !runningBrowser || !study || study.courses.length === 0} onChange={event => selectCourse(event.currentTarget.value)}><option value="" disabled>请明确选择课程</option>{study?.courses.map(course => <option key={course.id} value={course.id}>{course.title} · ID {course.id}</option>)}</select></label>
    {study?.courses.length === 0 && <p className="ocs-help">尚未发现可选课程；若等待登录，请在受控浏览器由本人完成登录，再读取课程。不按名称猜测或按列表下标选课。</p>}
    <div className="ocs-actions"><button type="button" className="button primary" data-testid="ocs-tsinghua-start" disabled={startReason !== ''} title={startReason} onClick={() => confirm({ title: `确认在「${browser.name}」开始清华社练习？`, description: `课程：${study?.courseTitle ?? '平台未提供标题'}；ID：${study?.courseId ?? '未选择'}。本次任务将进入课程并自动处理普通题，可能真实提交答案、修改学习记录并影响成绩，不保证正确率。听力视频正常播放；口语停下等待本人录音，不授权软件自动录音。请核对浏览器与课程后独立确认。`, command: { command: 'tsinghua-start', id: browser.id, confirmed: true } })}>确认开始普通题与媒体任务…</button><button type="button" className="button secondary" data-testid="ocs-tsinghua-read-score" disabled={disabled || !runningBrowser} onClick={() => void execute({ command: 'tsinghua-read-score', id: browser.id })}>读取平台成绩与评分</button></div>
    <p className="ocs-help" data-testid="ocs-tsinghua-blocked-reason">{startReason || '点击开始后还需单独确认真实练习提交。停止按钮不受普通操作锁定影响；已发生的提交无法撤回，停止后仍须核对平台记录。'}</p>
    {question && <section className="ocs-box" data-testid="ocs-tsinghua-exercise" data-question-id={question.id}>
      <h3>{question.title || '当前练习'} · {question.kind}</h3>
      <p className="ocs-help">页码：{question.page ?? '未提供'} / {question.totalPages ?? '未提供'} · 作答状态：{question.answered === null ? '平台未提供' : question.answered ? '平台显示已作答，不等于已得分' : '平台显示未作答'}</p>
      <p className="ocs-help ocs-tsinghua-text" data-testid="ocs-tsinghua-question">{question.text || '平台未提供题目正文。'}</p>
      <h3>平台原文／参考文本</h3><p className="ocs-help ocs-tsinghua-text" data-testid="ocs-tsinghua-transcript">{question.referenceText || '尚未读取到原文；不会自动猜测补全。'}</p>
      <div data-testid="ocs-tsinghua-media-status" role="status">{question.media.length === 0 ? <p className="ocs-help">当前未发现媒体状态，不代表已播放。</p> : question.media.map((media, index) => <p className="ocs-help" key={`${media.kind}:${index}`}>{media.kind === 'audio' ? '音频' : '视频'}：{media.phase} · {Math.floor(media.currentTime)} / {media.duration === null ? '时长未知' : Math.floor(media.duration)} 秒 · {media.playbackRate} 倍速 · {media.muted ? '已静音，请在平台核对声音' : '未静音，不代表本人已听到'}{media.errorCode !== null && ` · 媒体错误码 ${media.errorCode}`}</p>)}</div>
    </section>}
    {awaitingRecording && <section className="ocs-box" data-testid="ocs-tsinghua-awaiting-recording">
      <h3>请本人在平台录音</h3><p className="ocs-help">题目与原文见上方。可手动载入下方本机朗读辅助；录音前先停止朗读，等待后台释放并确认声音停止，建议戴耳机。软件不会点击录音、停止录音或提交录音。</p>
      <p className="ocs-help" role="status">{state.pronunciation.owned ? '本机语音仍被持有，请先停止并等待释放后录音。' : '本机语音当前未被持有；请本人确认声音停止后再在平台录音。'}</p>
      <button type="button" className="button secondary" data-testid="ocs-tsinghua-focus-recording" disabled={disabled || !runningBrowser || state.pronunciation.owned} onClick={() => void execute({ command: 'browser-focus', id: browser.id })}>聚焦平台页面，由本人录音</button>
      <p className="ocs-help">本人在平台完成录音和提交后，点击「读取平台成绩与评分」查看已返回结果；未返回评分时保持未验证。</p>
    </section>}
    <OcsPronunciation state={state.pronunciation} disabled={disabled} execute={execute} source={source} />
    <PlatformResult result={study?.result ?? null} />
  </section>;
}
