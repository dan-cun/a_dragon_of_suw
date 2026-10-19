import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { z } from 'zod';
import packageMetadata from '../../package.json';
import { releaseEdition, releaseEditionSchema } from '../shared/edition';
import index from '../renderer/index.html';
import authIndex from '../auth/index.html';
import licensePath from '../../LICENSE' with { type: 'file' };
import iconPath from '../../assets/icon.png' with { type: 'file' };
import { createApplication } from './application';
import { resolveEdge, launchWindow, setLaunchAtLogin } from './native';
import { authenticationSubmissionSchema } from './login-memory';
import { instancePipeName } from './instance';
import { assertCanShutdown } from '../core/shutdown';
import { createLepaoService } from './lepao';
import { createAcademicService } from './academic';
import { createOcsService } from './ocs';
import { createModelService } from './models';
import { createPiService } from './pi-service';
import { piServiceCommandSchema } from '../shared/pi';
import { ocsCommandSchema } from '../shared/ocs';
import { modelsCommandSchema } from '../shared/models';
import { academicCommandSchema } from '../shared/academic';
import { lepaoCommandSchema } from '../shared/lepao';
import { DakaError } from '../core/errors';
import { createStateStream } from './state-stream';
import { createNotifications } from './notifications';

if (process.platform !== 'win32') throw new Error('此程序仅支持 Windows 10/11。');
const appData = process.env['APPDATA'];
if (appData === undefined) throw new Error('未找到 Windows 用户数据目录。');
const dataDirectory = process.env['SWU_USER_DATA_DIR'] ?? join(appData, 'swu-daka-desktop');
if (!isAbsolute(dataDirectory)) throw new Error('应用数据目录必须是绝对路径。');
mkdirSync(dataDirectory, { recursive: true });
const instancePath = join(dataDirectory, 'instance.json');
const instanceSchema = z.object({ pid: z.number().int().positive(), port: z.number().int().min(1).max(65535), launchKey: z.string().regex(/^[a-f0-9]{64}$/) });
const edgePath = resolveEdge();
const noWindow = process.argv.includes('--no-window');
let reused = false;
const pipeName = instancePipeName(dataDirectory);
const guard = createServer((socket) => socket.end());
const ownsInstance = await new Promise<boolean>((resolve, reject) => {
  guard.once('error', (error) => {
    if ('code' in error && error.code === 'EADDRINUSE') resolve(false);
    else reject(error);
  });
  guard.listen(pipeName, () => resolve(true));
});

if (!ownsInstance) {
  const deadline = Date.now() + 10_000;
  while (!existsSync(instancePath) && Date.now() < deadline) await Bun.sleep(100);
  if (!existsSync(instancePath)) throw new Error('已有应用正在启动，但未在 10 秒内就绪。请稍后重新打开。');
  const existing = instanceSchema.parse(JSON.parse(readFileSync(instancePath, 'utf8')));
    const response = await fetch(`http://127.0.0.1:${existing.port}/api/instance`, {
      headers: { 'X-SWU-Instance': existing.launchKey }, signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) {
      throw new Error('已有进程占用本应用数据目录，但无法确认其状态。请关闭原程序后重试。');
    }
    const running = z.object({ application: z.literal('swu-daka-desktop'), version: z.string().optional(), edition: releaseEditionSchema.optional() }).safeParse(await response.json());
    if (!running.success) throw new Error('已有进程占用本应用数据目录，但无法确认其状态。请关闭原程序后重试。');
    if (running.data.version !== packageMetadata.version) throw new Error(`已有其他版本的打卡助手正在运行。请在旧版「偏好设置 → 退出程序」中退出，然后重新打开 ${packageMetadata.version} 版。`);
    if (running.data.edition !== releaseEdition) throw new Error('正在运行的程序属于其他分支或旧构建。请先从原程序“偏好设置 → 退出程序”退出，再打开所选分支。');
    if (!noWindow) await launchWindow(edgePath, join(dataDirectory, 'app-window-profile'), `http://127.0.0.1:${existing.port}/launch/${existing.launchKey}`);
    reused = true;
} else if (existsSync(instancePath)) {
  unlinkSync(instancePath);
}

if (!reused) {
  const lepao = createLepaoService(dataDirectory);
  let academic: ReturnType<typeof createAcademicService> | null = null;
  const application = await createApplication(dataDirectory, edgePath, () => lepao.isBusy() || academic?.isBusy() === true);
  academic = createAcademicService(dataDirectory, edgePath, () => application.getState().profile?.username ?? null);
  const campus = academic;
  const ocs = createOcsService(dataDirectory);
  const models = createModelService(dataDirectory);
  const pi = createPiService(dataDirectory, models.privateConfiguration, ocs);
  if (application.getState().settings.launchAtLogin) await setLaunchAtLogin(true);
  const launchKey = randomBytes(32).toString('hex');
  const sessionKey = randomBytes(32).toString('hex');
  let closing = false;
  let origin = '';
  let notifications: Awaited<ReturnType<typeof createNotifications>> | null = null;
  let stopNotifications: (() => void) | null = null;
  const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";

  function json(value: object, status: number): Response {
    return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': csp } });
  }
  function hasSession(request: Request): boolean {
    return request.headers.get('cookie')?.split(';').some((item) => item.trim() === `swu-session=${sessionKey}`) === true;
  }
  async function shutdown(): Promise<void> {
    if (closing) return;
    assertCanShutdown(application.getState().phase);
    lepao.assertCanClose();
    campus.assertCanClose();
    if (models.isBusy()) throw new Error('模型配置正在读写，请等待完成后退出。');
    if (pi.isBusy()) throw new Error('Pi 诊断会话正在运行，请先停止会话或等待请求结束后退出。');
    await ocs.assertCanClose();
    closing = true;
    try { await ocs.close(); await pi.close(); await campus.close(); stopNotifications?.(); await application.close(); await lepao.close(); await notifications?.close(); }
    catch (error) { closing = false; throw error; }
    setTimeout(() => {
      server.stop(true);
      guard.close();
      if (existsSync(instancePath)) {
        const saved = instanceSchema.parse(JSON.parse(readFileSync(instancePath, 'utf8')));
        if (saved.pid === process.pid) unlinkSync(instancePath);
      }
      process.exit(0);
    }, 300);
  }

  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0, idleTimeout: 255,
    development: false,
    routes: {
      '/': index,
      '/auth/': authIndex,
      '/LICENSE.txt': new Response(Bun.file(licensePath), { headers: { 'Content-Type': 'text/plain;charset=utf-8' } }),
      '/brand-icon.png': new Response(Bun.file(iconPath), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' } }),
      '/favicon.ico': new Response(Bun.file(iconPath), { headers: { 'Content-Type': 'image/png' } })
    },
    async fetch(request): Promise<Response> {
      const url = new URL(request.url);
      if (request.headers.get('host') !== new URL(origin).host) return json({ error: 'Invalid host.' }, 403);
      if (url.pathname === `/launch/${launchKey}` && request.method === 'GET') {
        return new Response(null, { status: 302, headers: {
          Location: '/', 'Set-Cookie': `swu-session=${sessionKey}; HttpOnly; SameSite=Strict; Path=/`,
          'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer'
        } });
      }
      if (url.pathname === '/api/instance' && request.headers.get('X-SWU-Instance') === launchKey) return json({ application: 'swu-daka-desktop', version: packageMetadata.version, edition: releaseEdition }, 200);
      if (!hasSession(request)) return json({ error: 'Local application session required.' }, 401);
      if (closing) return json({ ok: false, error: { code: 'OPERATION_BUSY', message: '程序正在退出，请稍后重新打开。' } }, 200);
      if (url.pathname === '/api/events' && request.method === 'GET') {
        const stream = createStateStream(application, request.signal);
        return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' } });
      }
      if (request.method !== 'POST' || request.headers.get('Origin') !== origin || request.headers.get('X-SWU-Request') !== '1'
        || request.headers.get('Content-Type') !== 'application/json') return json({ error: 'Invalid local application request.' }, 403);
      const maximumBody = url.pathname === '/api/ocs' ? 2_097_152 : url.pathname === '/api/pi' ? 65_536 : 16_384;
      if (Number(request.headers.get('Content-Length') ?? '0') > maximumBody) return json({ error: 'Request too large.' }, 413);
      try {
        const text = await request.text();
        if (Buffer.byteLength(text) > maximumBody) return json({ error: 'Request too large.' }, 413);
        const payload: unknown = JSON.parse(text);
        let value: object | null = null;
        switch (url.pathname) {
          case '/api/state': value = application.getState(); break;
          case '/api/ocs': value = await ocs.execute(ocsCommandSchema.parse(payload)); break;
          case '/api/models': value = await models.execute(modelsCommandSchema.parse(payload)); break;
          case '/api/pi': value = await pi.execute(piServiceCommandSchema.parse(payload)); break;
          case '/api/academic': {
            const command = academicCommandSchema.parse(payload);
            if (command.command !== 'state' && (application.getState().phase !== 'idle' || lepao.isBusy())) throw new Error('其他学校操作正在进行，请等待结束后再操作校园服务。');
            value = await campus.execute(command); break;
          }
          case '/api/lepao': {
            const command = lepaoCommandSchema.parse(payload);
            if (!['state', 'stop'].includes(command.command) && (application.getState().phase !== 'idle' || campus.isBusy())) {
              throw new DakaError('OPERATION_BUSY', '查寝操作正在进行，请等待结束后再操作乐跑。', undefined);
            }
            value = await lepao.execute(command); break;
          }
          case '/api/login': value = await application.login(); break;
          case '/api/logout': await campus.close(); value = await application.logout(); break;
          case '/api/forget-login': value = await application.forgetLogin(); break;
          case '/api/sync': value = await application.sync(); break;
          case '/api/location': value = await application.saveLocation(payload); break;
          case '/api/checkin': value = await application.checkin(z.object({ taskId: z.string().min(1).max(128) }).strict().parse(payload).taskId); break;
          case '/api/settings': value = await application.saveSettings(payload); break;
          case '/api/data': await application.openDataFolder(); break;
          case '/api/official': await launchWindow(edgePath, join(dataDirectory, 'official-profile'), 'https://of.swu.edu.cn/baidaForm/#/index'); break;
          case '/api/notifications/test':
            if (notifications === null) throw new Error('Windows 后台提醒尚未就绪。');
            await notifications.notify('西大日常 · 提醒测试', '后台提醒已交给 Windows。点击通知或双击托盘图标可打开程序。'); break;
          case '/api/auth/view': value = application.getAuthView(); break;
          case '/api/auth/submit':
            if (application.getAuthView().stage !== 'ready') throw new Error('当前认证会话尚未准备好，请等待验证码加载后再提交。');
            void application.submitAuth(authenticationSubmissionSchema.parse(payload)).catch((error: unknown) => application.reportFailure(error));
            break;
          case '/api/auth/refresh': await application.refreshAuth(); break;
          case '/api/auth/cancel': await application.cancelAuth(); break;
          case '/api/quit': await shutdown(); break;
          default: return json({ error: 'Route not found.' }, 404);
        }
        return json({ ok: true, value }, 200);
      } catch (error) { return json({ ok: false, error: application.reportFailure(error) }, 200); }
    },
    error(error): Response {
      return json({ ok: false, error: application.reportFailure(error) }, 500);
    }
  });
  origin = `http://127.0.0.1:${server.port}`;
  const pendingInstance = `${instancePath}.pending`;
  writeFileSync(pendingInstance, JSON.stringify({ pid: process.pid, port: server.port, launchKey }), { encoding: 'utf8', mode: 0o600 });
  renameSync(pendingInstance, instancePath);
  notifications = await createNotifications(dataDirectory, async action => {
    if (action === 'open') await launchWindow(edgePath, join(dataDirectory, 'app-window-profile'), `${origin}/launch/${launchKey}`);
    else {
      try { await shutdown(); }
      catch (error) {
        application.reportFailure(error);
        await notifications?.notify('当前不能退出', '任务仍在执行。请打开程序，停止或等待当前操作完成后再退出。');
      }
    }
  }, error => { application.reportFailure(error); });
  notifications.prime(application.getState());
  stopNotifications = application.subscribe(notifications.observe);
  if (!noWindow) await launchWindow(edgePath, join(dataDirectory, 'app-window-profile'), `${origin}/launch/${launchKey}`);
  process.on('SIGINT', () => { void shutdown().catch(error => application.reportFailure(error)); });
  process.on('SIGTERM', () => { void shutdown().catch(error => application.reportFailure(error)); });
  console.log(JSON.stringify({ event: 'application.ready', port: server.port, version: packageMetadata.version }));
}
