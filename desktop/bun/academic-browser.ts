import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { randomInt } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { connectCdp, type CdpConnection } from './cdp';
import type { BrowserCookie } from './auth-http';
import { academicEndpoints } from '../core/academic-data';
import { semesterSchema, type AcademicSection, type Semester } from '../shared/academic';
import { teachingEntry } from './academic-portal';
import { readAcademicResponse } from './academic-transport';

const origin = 'https://jw.swu.edu.cn';
const portal = 'https://ywtb.swu.edu.cn/center-auth-server/officeHallApplicationCode/cas/login?service=https%3A%2F%2Fywtb.swu.edu.cn%2Fbusiness-center-front%2FcasPlusClient%2Fauth';
const targetSchema = z.object({ targetId: z.string(), type: z.string(), url: z.string() });
const targetsSchema = z.object({ targetInfos: z.array(targetSchema) });
const runtimeSchema = z.object({ result: z.object({ value: z.unknown().optional() }), exceptionDetails: z.unknown().optional() });
const metadataSchema = z.object({ url: z.string(), account: z.string(), years: z.array(z.object({ value: z.string(), label: z.string() })), terms: z.array(z.object({ value: z.string(), label: z.string() })), year: z.string(), term: z.string() });
export interface AcademicConnection { account: string; semesters: Semester[]; selected: Semester }
export interface AcademicBrowser {
  inspect(): Promise<AcademicConnection | null>;
  hasPortal(): Promise<boolean>;
  openPortal(): Promise<void>;
  fillSavedLogin(username: string, password: string): Promise<boolean>;
  read(section: AcademicSection, semester: Semester): Promise<unknown[]>;
  close(): Promise<void>;
}

async function reservePort(): Promise<number> {
  const server = createServer();
  return await new Promise<number>((resolvePort, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { server.close(); reject(new Error('无法分配教务窗口的本机端口。')); return; }
      server.close(error => error ? reject(error) : resolvePort(address.port));
    });
  });
}

async function waitForBrowser(port: number, process: ChildProcess): Promise<string> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error('教务窗口启动后提前退出，请检查 Microsoft Edge。');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(700) });
      if (response.ok) return z.object({ webSocketDebuggerUrl: z.string().url() }).parse(await response.json()).webSocketDebuggerUrl;
    } catch (error) {
      if (!(error instanceof TypeError || error instanceof DOMException)) throw error;
    }
    await Bun.sleep(150);
  }
  throw new Error('Microsoft Edge 教务窗口在 15 秒内未就绪。');
}

export async function openAcademicBrowser(directory: string, edge: string, cookies: BrowserCookie[]): Promise<AcademicBrowser> {
  const root = resolve(directory, 'academic-sessions');
  await mkdir(root, { recursive: true });
  const profile = await mkdtemp(join(root, 'session-'));
  const port = await reservePort();
  const child = spawn(edge, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--disable-default-apps', '--new-window', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  let launchError: Error | null = null;
  child.once('error', error => { launchError = error; });
  let cdp: CdpConnection | null = null;
  let session = '';
  let failure: Error | null = null;
  const controller = new AbortController();
  let attachedTarget = '';

  async function waitForNextStep(): Promise<void> {
    await delay(randomInt(1000, 3001), undefined, { signal: controller.signal });
  }

  async function close(): Promise<void> {
    let closeFailure: Error | null = null;
    try { if (cdp) await cdp.requestBrowserClose(); }
    catch (cause) { closeFailure = cause instanceof Error ? cause : new Error('教务窗口关闭请求失败。'); }
    finally { cdp?.close(); controller.abort(); }
    const deadline = Date.now() + 4000;
    while (child.exitCode === null && child.signalCode === null && !launchError && Date.now() < deadline) await Bun.sleep(100);
    if (child.exitCode === null && child.signalCode === null && !launchError) {
      console.warn(JSON.stringify({ event: 'academic.browser.terminate', message: '教务专用窗口未及时退出，正在结束本次启动的独立进程。' }));
      if (!child.kill()) throw new Error('教务专用进程结束失败，请关闭该窗口后重试。', { cause: closeFailure });
      const stopped = Date.now() + 4000;
      while (child.exitCode === null && child.signalCode === null && Date.now() < stopped) await Bun.sleep(100);
    }
    if (child.exitCode === null && child.signalCode === null && !launchError) throw new Error('教务专用窗口未完成关闭。临时会话暂未删除，请关闭该窗口后重试。', { cause: closeFailure });
    if (closeFailure) console.warn(JSON.stringify({ event: 'academic.browser.close-request.failed', message: closeFailure.message }));
    const target = resolve(profile);
    if (!target.startsWith(root + sep)) throw new Error('教务临时会话路径不在预期目录，已停止清理。');
    await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  async function send(method: string, params: Record<string, unknown>, attached: boolean): Promise<unknown> {
    if (launchError) throw new Error('无法启动 Microsoft Edge 教务窗口。', { cause: launchError });
    if (failure) throw new Error('教务窗口连接已断开，请断开后重新连接。', { cause: failure });
    if (!cdp) throw new Error('教务窗口尚未连接。');
    return await cdp.send(method, params, attached ? session : undefined);
  }
  async function attach(targetId: string): Promise<void> {
    if (attachedTarget === targetId) return;
    if (session) await send('Target.detachFromTarget', { sessionId: session }, false);
    session = z.object({ sessionId: z.string() }).parse(await send('Target.attachToTarget', { targetId, flatten: true }, false)).sessionId;
    attachedTarget = targetId;
    await send('Page.enable', {}, true);
    await send('Network.setCacheDisabled', { cacheDisabled: true }, true);
  }
  async function evaluate(expression: string): Promise<unknown> {
    const response = runtimeSchema.parse(await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, true));
    if (response.exceptionDetails !== undefined) throw new Error('学校页面读取失败，请确认页面已加载完成并重新检测。');
    return response.result.value;
  }
  async function navigate(url: string): Promise<void> {
    const frameSchema = z.object({ frameTree: z.object({ frame: z.object({ loaderId: z.string() }) }) });
    const previous = frameSchema.parse(await send('Page.getFrameTree', {}, true)).frameTree.frame.loaderId;
    const result = z.object({ errorText: z.string().optional(), loaderId: z.string().optional() }).parse(await send('Page.navigate', { url }, true));
    if (result.errorText) throw new Error(`学校教务页面加载失败（${result.errorText.replace(/[^a-zA-Z0-9_:.-]/g, '')}）。请检查当前校园网络或原有代理。`);
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const tree = frameSchema.parse(await send('Page.getFrameTree', {}, true));
      if ((result.loaderId === undefined || previous !== tree.frameTree.frame.loaderId) && await evaluate('document.readyState !== "loading"') === true) {
        await waitForNextStep();
        return;
      }
      await Bun.sleep(200);
    }
    throw new Error('学校教务页面加载超过 15 秒，请等待窗口加载完成后重新检测。');
  }
  async function inspect(): Promise<AcademicConnection | null> {
    const targets = targetsSchema.parse(await send('Target.getTargets', {}, false));
    function isTeachingPage(target: z.infer<typeof targetSchema>): boolean {
      if (target.type !== 'page' || !/^https?:\/\//.test(target.url)) return false;
      const url = new URL(target.url);
      return url.hostname === 'jw.swu.edu.cn' && !url.port && !url.username && !url.password && url.pathname.startsWith('/jwglxt/') && !url.pathname.includes('/login_');
    }
    let page = targets.targetInfos.find(isTeachingPage);
    if (!page) {
      const portalPage = targets.targetInfos.find(target => target.type === 'page' && target.url.startsWith('https://ywtb.swu.edu.cn/new-office-hall-pc/'));
      if (!portalPage) return null;
      await attach(portalPage.targetId);
      const cookies = z.object({ cookies: z.array(z.object({ name: z.string(), value: z.string() })) }).parse(await send('Network.getCookies', { urls: ['https://ywtb.swu.edu.cn/'] }, true));
      const token = cookies.cookies.find(cookie => cookie.name === 'business_center_token')?.value;
      if (!token) return null;
      await waitForNextStep();
      await navigate(await teachingEntry(evaluate, token));
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        page = targetsSchema.parse(await send('Target.getTargets', {}, false)).targetInfos.find(isTeachingPage);
        if (page) break;
        await Bun.sleep(200);
      }
    }
    if (!page) return null;
    await attach(page.targetId);
    if (page.url.startsWith('http:')) {
      const url = new URL(page.url);
      await navigate(origin + url.pathname + url.search);
    }
    const identity = z.string().parse(await evaluate(`String(document.querySelector('#sessionUserKey')?.value || document.querySelector('input[name="xh"]')?.value || document.querySelector('#xh')?.value || '')`));
    await navigate(origin + academicEndpoints.timetable.page);
    const metadata = metadataSchema.parse(await evaluate(`(() => {
      const options = id => [...(document.querySelector(id)?.options || [])].map(o => ({value:o.value,label:o.textContent.trim()}));
      return {url:location.href,account:String(document.querySelector('#sessionUserKey')?.value || document.querySelector('input[name="xh"]')?.value || document.querySelector('#xh')?.value || ''),years:options('#xnm'),terms:options('#xqm'),year:document.querySelector('#xnm')?.value || '',term:document.querySelector('#xqm')?.value || ''};
    })()`));
    if (!metadata.url.startsWith(origin + '/jwglxt/') || metadata.url.includes('/login_')) return null;
    const semesters: Semester[] = [];
    for (const year of metadata.years.filter(option => /^\d{4}$/.test(option.value))) {
      for (const term of metadata.terms.filter(option => ['3', '12', '16'].includes(option.value))) {
        semesters.push(semesterSchema.parse({ year: year.value, term: term.value, label: `${year.label} · ${term.label}` }));
      }
    }
    const selected = semesters.find(item => item.year === metadata.year && item.term === metadata.term);
    if (!selected) throw new Error('学校课表页面未返回可用学期，无法开始查询。请确认当前账号有本科教务权限。');
    const account = (metadata.account || identity).trim();
    if (!account) throw new Error('教务页面未返回可核验的学号，已停止读取。请在教务首页重新进入学生课表后检测。');
    return { account, semesters, selected };
  }
  async function query(section: AcademicSection, semester: Semester, page: number): Promise<unknown> {
    const body = new URLSearchParams({ xnm: semester.year, xqm: semester.term,
      ...(section === 'timetable' ? { kzlx: 'ck', xsdm: '', kclbdm: '', kclxdm: '' } : {
        _search: 'false', nd: String(Date.now()), 'queryModel.showCount': '100', 'queryModel.currentPage': String(page), 'queryModel.sortName': ' ', 'queryModel.sortOrder': 'asc', time: '0',
        ...(section === 'grades' ? { sfzgcj: '', kcbj: '', pkey: '' } : { ksmcdmb_id: '', kch: '', kc: '', ksrq: '', kkbm_id: '' }),
      }),
    }).toString();
    const envelope = await readAcademicResponse(async () => {
      await waitForNextStep();
      return z.object({ status: z.number(), json: z.unknown(), login: z.boolean() }).parse(await evaluate(`(async () => {
      if (location.origin !== ${JSON.stringify(origin)}) throw new Error('Wrong origin');
      const response = await fetch(${JSON.stringify(academicEndpoints[section].query)}, {method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8','X-Requested-With':'XMLHttpRequest'},body:${JSON.stringify(body)},signal:AbortSignal.timeout(20000)});
      const text = await response.text();
      if(text.length > 8000000) throw new Error('Response too large');
      let json = null; try {json = JSON.parse(text)} catch { }
      return {status:response.status,json,login:new URL(response.url).origin !== ${JSON.stringify(origin)} || response.url.includes('/login_') || /<html|<!doctype/i.test(text.slice(0,1000))};
    })()`));
    }, section);
    if (envelope.login || envelope.status === 401 || envelope.status === 403) throw new Error('教务会话已失效，请打开学校登录并重新检测；上次结果仅供参考。');
    if (envelope.status !== 200) throw new Error(`学校${section}查询失败（HTTP ${envelope.status}），未覆盖上次结果。`);
    if (envelope.json === null) throw new Error('学校返回的查询结果不是 JSON，可能需要重新登录或完成校园网络认证。');
    return envelope.json;
  }
  async function read(section: AcademicSection, semester: Semester): Promise<unknown[]> {
    await navigate(origin + academicEndpoints[section].page);
    if (section === 'timetable') {
      const data = z.object({ kbList: z.array(z.unknown()).max(10000), sjkList: z.array(z.unknown()).optional(), jxhjkcList: z.array(z.unknown()).optional() }).parse(await query(section, semester, 1));
      const extras = [...(data.sjkList ?? []), ...(data.jxhjkcList ?? [])].map((value, index) => {
        const raw = z.object({ sjkcgs: z.string().optional(), qtkcgs: z.string().optional(), kcmc: z.string().optional(), mc: z.string().optional(), bz: z.string().optional() }).parse(value);
        const name = raw.kcmc || raw.mc || raw.sjkcgs || raw.qtkcgs;
        if (!name) throw new Error('实践教学条目缺少课程名称，未覆盖上次课表。');
        return { kcmc: name, bz: raw.bz ?? '', jxb_id: `practice-${index}` };
      });
      return [...data.kbList, ...extras];
    }
    const records: unknown[] = [];
    let total: number | null = null;
    for (let page = 1; page <= 100; page += 1) {
      const data = z.object({ items: z.array(z.unknown()).max(100), totalResult: z.coerce.number().int().min(0).max(10000).optional(), totalCount: z.coerce.number().int().min(0).max(10000).optional() }).parse(await query(section, semester, page));
      total = data.totalResult ?? data.totalCount ?? total;
      if (page > 1 && JSON.stringify(data.items) === JSON.stringify(records.slice(-data.items.length)) && data.items.length > 0) throw new Error('教务分页返回了重复页，已停止查询，未覆盖上次结果。');
      records.push(...data.items);
      if (total !== null && records.length >= total) {
        if (records.length !== total) throw new Error('教务分页总数与实际记录不一致，请重新查询。');
        return records;
      }
      if (data.items.length < 100) {
        if (total !== null && records.length !== total) throw new Error('教务分页未返回全部记录，请重新查询。');
        return records;
      }
    }
    throw new Error('教务查询超过 100 页，已停止查询，未覆盖上次结果。');
  }
  try {
    cdp = await connectCdp(await waitForBrowser(port, child), controller.signal, error => { failure = error; });
    const target = z.object({ targetId: z.string() }).parse(await send('Target.createTarget', { url: 'about:blank' }, false));
    await attach(target.targetId);
    const valid = cookies.filter(cookie => ['swu.edu.cn', '.swu.edu.cn', 'idm.swu.edu.cn', 'uaaap.swu.edu.cn', 'of.swu.edu.cn', 'jw.swu.edu.cn', 'ywtb.swu.edu.cn'].includes(cookie.domain) && (cookie.expires === -1 || cookie.expires > Date.now() / 1000));
    if (valid.length) await send('Network.setCookies', { cookies: valid.map(cookie => ({ ...cookie, ...(cookie.expires === -1 ? { expires: undefined } : {}) })) }, true);
    await navigate(origin + academicEndpoints.timetable.page);
    return { inspect, read, openPortal: () => navigate(portal), close, async fillSavedLogin(username, password) {
      let login: z.infer<typeof targetSchema> | undefined;
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const targets = targetsSchema.parse(await send('Target.getTargets', {}, false));
        login = targets.targetInfos.find(target => target.type === 'page' && (target.url.startsWith('https://idm.swu.edu.cn/') || target.url.startsWith('https://uaaap.swu.edu.cn/cas/login')));
        if (login) {
          await attach(login.targetId);
          if (await evaluate(`(() => {const ids={'https://idm.swu.edu.cn':'loginName','https://uaaap.swu.edu.cn':'username'};return document.getElementById(ids[location.origin]) instanceof HTMLInputElement && document.getElementById('password') instanceof HTMLInputElement})()`) === true) break;
          login = undefined;
        }
        await Bun.sleep(200);
      }
      if (!login) return false;
      await attach(login.targetId);
      return z.boolean().parse(await evaluate(`(() => {
        const ids={'https://idm.swu.edu.cn':'loginName','https://uaaap.swu.edu.cn':'username'};
        if(!ids[location.origin]) throw new Error('Wrong school login origin');
        const user = document.getElementById(ids[location.origin]), pass = document.getElementById('password');
        if(!(user instanceof HTMLInputElement) || !(pass instanceof HTMLInputElement) || pass.type !== 'password') throw new Error('School login form changed');
        if((user.value && user.value !== ${JSON.stringify(username)}) || pass.value) return false;
        user.value = ${JSON.stringify(username)}; pass.value = ${JSON.stringify(password)};
        for(const field of [user,pass]) {field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}));}
        return true;
      })()`));
    }, async hasPortal() {
      const targets = targetsSchema.parse(await send('Target.getTargets', {}, false));
      return targets.targetInfos.some(target => target.type === 'page' && target.url.startsWith('https://ywtb.swu.edu.cn/new-office-hall-pc/'));
    } };
  } catch (cause) {
    try { await close(); } catch (cleanupError) { console.error(JSON.stringify({ event: 'academic.cleanup.failed', message: cleanupError instanceof Error ? cleanupError.message : 'Cleanup failed' })); }
    throw new Error('教务专用窗口建立失败，请检查 Edge 和学校网络。', { cause });
  }
}
