import { readLoginMemory, writeLoginMemory } from './login-memory';
import { authenticateAcademicSession } from './academic-login';
import { openAcademicBrowser, type AcademicBrowser } from './academic-browser';
import { parseAcademicRecords } from '../core/academic-data';
import type { AcademicCommand, AcademicState } from '../shared/academic';

export function createAcademicService(directory: string, edge: string, currentAccount: () => string | null) {
  let browser: AcademicBrowser | null = null;
  let busy = false;
  let automaticLoginAttempted = false;
  let state: AcademicState = emptyState(currentAccount());
  function emptyState(account: string | null): AcademicState {
    return { status: 'disconnected', account, message: '连接学校教务后，可查询本人的课表、成绩和考试。', connectedAt: null, semesters: [], selected: null, datasets: [] };
  }
  function assertCanClose(): void { if (busy) throw new Error('校园服务正在读取学校数据，请等待操作完成后退出或切换账号。'); }
  async function disconnect(): Promise<void> {
    if (browser) await browser.close();
    browser = null;
    automaticLoginAttempted = false;
    state = emptyState(currentAccount());
  }
  async function verify(): Promise<void> {
    if (!browser) throw new Error('尚未连接教务，请先点击“连接教务”。');
    const connection = await browser.inspect();
    if (connection === null) {
      const message = await browser.hasPortal()
        ? '已检测到学校办事大厅页面。请先完成官方学校登录，然后点击重新检测，助手会查询教务入口并继续 SSO。也可在门户下方“旧版门户 → 教务系统”进入教学管理页面。'
        : '尚未进入学生教务。请在学校窗口完成登录；若出现教务独立登录页，点击“学校统一登录”，从办事大厅进入“教务系统”，再回到这里重新检测。';
      state = { ...state, status: 'login-required', connectedAt: null, message };
      return;
    }
    if (connection.account !== state.account || currentAccount() !== state.account) {
      await disconnect();
      throw new Error('教务学号与应用当前账号不一致，已清除本次连接及查询数据。请使用同一账号重新连接。');
    }
    state = { ...state, status: 'ready', connectedAt: new Date().toISOString(), semesters: connection.semesters,
      selected: state.selected && connection.semesters.some(value => value.year === state.selected?.year && value.term === state.selected.term) ? state.selected : connection.selected,
      message: '教务学号已核验。选择学期后，分别查询课表、成绩或考试；所有查询均在本机执行。' };
  }
  return {
    isBusy: () => busy,
    assertCanClose,
    async close(): Promise<void> { assertCanClose(); await disconnect(); },
    async execute(command: AcademicCommand): Promise<AcademicState> {
      if (command.command === 'state') {
        if (state.account !== currentAccount()) {
          assertCanClose();
          await disconnect();
        }
        return structuredClone(state);
      }
      assertCanClose();
      busy = true;
      try {
        if (state.account !== currentAccount()) await disconnect();
        if (command.command === 'disconnect') { await disconnect(); return structuredClone(state); }
        if (!currentAccount()) throw new Error('请先在“今日任务”登录本人账号，校园服务会核验教务学号是否一致。');
        if (command.command === 'connect') {
          if (browser) throw new Error('教务窗口已打开，请使用重新检测或先断开连接。');
          const memory = await readLoginMemory(directory);
          browser = await openAcademicBrowser(directory, edge, memory?.username === currentAccount() ? memory.cookies : []);
          state = { ...state, status: 'login-required', message: '学校窗口已打开，正在核验教务学号。' };
          await verify();
          if (state.status === 'login-required' && browser) { await browser.openPortal(); await verify(); }
        } else if (command.command === 'portal') {
          if (!browser) throw new Error('请先连接教务，再打开学校统一登录。');
          await browser.openPortal();
          state = { ...state, status: 'login-required', connectedAt: null, message: '已打开学校统一登录。完成官方登录后点击重新检测，助手会查询教务入口并继续 SSO。' };
          await verify();
        } else if (command.command === 'check') {
          await verify();
        } else {
          await verify();
          if (state.status !== 'ready' || !browser) throw new Error(state.message);
          const semester = state.semesters.find(item => item.year === command.semester.year && item.term === command.semester.term);
          if (!semester) throw new Error('所选学期不在学校返回的列表中，请重新检测教务连接。');
          const account = state.account;
          const records = parseAcademicRecords(await browser.read(command.section, semester), command.section);
          await verify();
          if (state.status !== 'ready' || state.account !== account) throw new Error('读取过程中教务会话发生变化，本次结果未保存。请重新连接并查询。');
          state = { ...state, selected: semester, datasets: [
            ...state.datasets.filter(item => item.section !== command.section),
            { section: command.section, semester, updatedAt: new Date().toISOString(), records },
          ], message: `已从学校教务读取 ${records.length} 条记录。数据仅保存在本次应用运行内存中。` };
        }
        if (state.status === 'login-required' && browser) {
          const memory = await readLoginMemory(directory);
          if (memory?.username === currentAccount() && !automaticLoginAttempted) {
            automaticLoginAttempted = true;
            state = { ...state, message: '正在复用保存的同账号信息与内置 OCR 完成学校认证…' };
            const cookies = await authenticateAcademicSession(directory, edge, memory);
            await browser.close();
            browser = null;
            browser = await openAcademicBrowser(directory, edge, cookies);
            await verify();
            if (state.status === 'login-required') { await browser.openPortal(); await verify(); }
            if (state.status !== 'ready') throw new Error('学校认证已通过，但教务 SSO 尚未完成。请在学校窗口进入教务系统后重新检测。');
            await writeLoginMemory(directory, { ...memory, cookies });
          } else if (memory?.username === currentAccount() && await browser.fillSavedLogin(memory.username, memory.password)) {
            state = { ...state, message: '本次连接已尝试自动认证。已填入同账号信息，请在学校窗口完成登录后重新检测；断开后连接可重新尝试自动登录。' };
          }
        }
        return structuredClone(state);
      } catch (error) {
        state = { ...state, message: error instanceof Error ? error.message : '校园服务操作失败，请重新连接教务。' };
        if (state.message.includes('会话已失效') || state.message.includes('连接已断开')) state = { ...state, status: 'login-required', connectedAt: null };
        throw error;
      } finally { busy = false; }
    },
  };
}
