import { useEffect, useRef, useState } from 'react';
import { BookOpen, ClipboardList, GraduationCap, Link2, RefreshCw, Unplug } from 'lucide-react';
import type { AcademicCommand, AcademicSection, AcademicState } from '../shared/academic';
import './campus.css';

const sections = [
  { id: 'timetable', label: '课表', icon: BookOpen, description: '查看课程、上课周次、节次与教室。' },
  { id: 'grades', label: '成绩', icon: GraduationCap, description: '查看教务公布的课程成绩、学分与成绩性质。' },
  { id: 'exams', label: '考试', icon: ClipboardList, description: '查看考试安排、时间、地点与备注。' },
] as const;
const weekdays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
function timestamp(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium', hour12: false }).format(new Date(value));
}

export default function CampusServices({ account, locked }: { account: string | null; locked: boolean }) {
  const [state, setState] = useState<AcademicState | null>(null);
  const [section, setSection] = useState<AcademicSection>('timetable');
  const [semesterKey, setSemesterKey] = useState('');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    setState(null); setError(''); setSemesterKey(''); setSearch(''); setBusy(false);
    window.academic.execute({ command: 'state' }).then(result => {
      if (current !== generation.current) return;
      if (result.ok) { setState(result.value); const selected = result.value.selected; if (selected) setSemesterKey(`${selected.year}:${selected.term}`); }
      else setError(result.error.message);
    }).catch((cause: unknown) => { if (current === generation.current) setError(cause instanceof Error ? cause.message : '读取校园服务状态失败。'); });
    return () => { generation.current += 1; };
  }, [account]);
  async function execute(command: AcademicCommand): Promise<void> {
    const current = generation.current;
    setBusy(true); setError('');
    try {
      const result = await window.academic.execute(command);
      if (current !== generation.current) return;
      if (result.ok) {
        setState(result.value);
        if (result.value.selected) setSemesterKey(`${result.value.selected.year}:${result.value.selected.term}`);
      } else {
        setError(result.error.message);
        const snapshot = await window.academic.execute({ command: 'state' });
        if (snapshot.ok && current === generation.current) setState(snapshot.value);
      }
    } catch (cause) { if (current === generation.current) setError(cause instanceof Error ? cause.message : '校园服务请求失败，请重新打开应用。'); }
    finally { if (current === generation.current) setBusy(false); }
  }
  const semester = state?.semesters.find(item => `${item.year}:${item.term}` === semesterKey);
  const dataset = state?.datasets.find(item => item.section === section && `${item.semester.year}:${item.semester.term}` === semesterKey);
  const query = search.trim().toLocaleLowerCase();
  const records = dataset?.records.filter(item => [item.course, item.code, item.teacher, item.location].some(value => value.toLocaleLowerCase().includes(query))) ?? [];
  const disabled = locked || busy || !state;
  const connected = state?.status === 'ready';
  const selectedSection = sections.find(item => item.id === section)!;
  return <div className="campus-services" data-testid="campus-services">
    <section className="panel academic-connection">
      <div className="academic-heading"><div className="academic-icon"><GraduationCap size={24} /></div><div><h2>学校教务</h2><p>本机连接 · 课表、成绩与考试</p></div><span data-testid="academic-status" className={`academic-status ${connected ? 'connected' : ''}`}>{connected ? '学号已核验' : state?.status === 'login-required' ? '等待学校登录' : '尚未连接'}</span></div>
      <p className="academic-message" data-testid="academic-message">{!account ? '请先在“今日任务”登录本人账号，再连接教务。教务会话需要单独核验。' : state?.message ?? '正在读取本机状态…'}</p>
      <div className="academic-actions">
        <button className="button primary" data-testid="academic-connect" disabled={disabled || !account || state?.status !== 'disconnected'} onClick={() => void execute({ command: 'connect' })}><Link2 size={16} />{busy ? '正在处理…' : '连接教务'}</button>
        {state && state.status !== 'disconnected' && <>
          <button className="button secondary" data-testid="academic-portal" disabled={disabled} onClick={() => void execute({ command: 'portal' })}>学校统一登录</button>
          <button className="button secondary" data-testid="academic-check" disabled={disabled} onClick={() => void execute({ command: 'check' })}><RefreshCw size={16} />重新检测</button>
          <button className="button secondary" data-testid="academic-disconnect" disabled={disabled} onClick={() => void execute({ command: 'disconnect' })}><Unplug size={16} />断开连接</button>
        </>}
      </div>
      <details className="academic-help"><summary data-testid="academic-guide">首次连接怎么操作？</summary><ol><li>点击连接教务，应用会打开独立的学校窗口，尝试使用本机保存的同账号学校会话，并通过门户入口继续教务 SSO。</li><li>学校会话失效时，应用会使用本机保存的同账号密码和内置 OCR 自动认证一次。未保存密码或认证失败时，在学校窗口完成登录后重新检测；需要再次自动认证可断开后重新连接。</li><li>学号核验通过后，选择学期，点击查询；页面与查询步骤之间会随机等待 1–3 秒。门户登录成功和教务学号核验分别显示，只有核验通过才能读取数据。</li></ol><p>仅查询本人数据。连接不会更改系统代理；校外网络无法访问时，请先按学校要求连接校园网。断开或退出后会清除本次教务窗口和内存中的查询结果。</p></details>
      {error && <div className="academic-error" role="alert" data-testid="academic-error">{error}</div>}
    </section>
    <section className="panel academic-content">
      <div className="academic-tabs" role="tablist" aria-label="校园服务">
        {sections.map(({ id, label, icon: Icon }) => <button key={id} id={`academic-tab-${id}`} data-testid={`academic-tab-${id}`} role="tab" aria-selected={section === id} aria-controls="academic-results" className={section === id ? 'selected' : ''} onClick={() => { setSection(id); setSearch(''); }}><Icon size={17} />{label}</button>)}
      </div>
      <div className="academic-toolbar"><div><h2>{selectedSection.label}</h2><p>{selectedSection.description}</p></div><div className="academic-filters"><select data-testid="academic-semester" aria-label="学期" value={semesterKey} disabled={disabled || !connected} onChange={event => { setSemesterKey(event.target.value); setSearch(''); }}><option value="">连接后选择学期</option>{state?.semesters.map(item => <option key={`${item.year}:${item.term}`} value={`${item.year}:${item.term}`}>{item.label}</option>)}</select><button data-testid="academic-refresh" className="button primary" disabled={disabled || !connected || !semester} onClick={() => { if (semester) void execute({ command: 'refresh', section, semester }); }}><RefreshCw size={16} />{dataset ? '重新查询' : '查询'}</button></div></div>
      <div role="tabpanel" id="academic-results" aria-labelledby={`academic-tab-${section}`}>
        {!dataset ? <div className="academic-empty" data-testid="academic-empty"><selectedSection.icon size={30} /><h3>{connected ? '还没有查询本学期数据' : '连接教务后查看' + selectedSection.label}</h3><p>{connected ? '选择学期并点击查询，结果以学校教务返回为准。' : '学校登录与学号核验通过后，这里会显示本人的数据。'}</p></div> : <>
          <div className="academic-result-meta"><span data-testid="academic-updated">最近读取 {timestamp(dataset.updatedAt)} · 共 {dataset.records.length} 条{!connected ? ' · 会话未验证，结果仅供参考' : ''}</span><input data-testid="academic-search" type="search" aria-label="搜索课程" placeholder="搜索课程、教师或地点" value={search} onChange={event => setSearch(event.target.value)} /></div>
          {dataset.records.length === 0 ? <div className="academic-empty" data-testid="academic-no-records"><h3>学校暂未返回本学期的{selectedSection.label}记录</h3><p>可核对所选学期，或到学校教务页面确认是否已公布。</p></div> : <div className="academic-table-scroll"><table className="academic-table" data-testid="academic-table"><thead><tr><th>课程</th>{section === 'timetable' ? <><th>上课时间</th><th>周次</th><th>地点</th><th>教师</th></> : section === 'grades' ? <><th>成绩</th><th>学分</th><th>性质</th><th>备注</th></> : <><th>考试时间</th><th>地点</th><th>方式</th><th>备注</th></>}</tr></thead><tbody>{records.map(item => <tr key={item.id}><td><strong>{item.course}</strong><small>{item.code || '学校未提供课程代码'}</small></td>{section === 'timetable' ? <><td>{item.weekday ? weekdays[item.weekday - 1] : '时间待定'}<small>{item.timing ? `${item.timing} 节` : '未公布节次'}</small></td><td>{item.weeks || '—'}</td><td>{item.location || '—'}{item.note && <small>{item.note}</small>}</td><td>{item.teacher || '—'}</td></> : section === 'grades' ? <><td className="academic-score">{item.score || '未公布'}</td><td>{item.credits || '—'}</td><td>{item.nature || '—'}</td><td>{item.note || '—'}</td></> : <><td>{item.timing || '尚未公布'}</td><td>{item.location || '—'}</td><td>{item.nature || '—'}</td><td>{item.note || '—'}</td></>}</tr>)}</tbody></table>{records.length === 0 && <p className="academic-no-match" data-testid="academic-no-match">没有匹配的课程，请修改搜索词。</p>}</div>}
        </>}
      </div>
      <p className="academic-source">数据来源：西南大学教学管理信息服务平台 · 北京时间 · 查询结果仅在本次运行中保存</p>
    </section>
  </div>;
}
