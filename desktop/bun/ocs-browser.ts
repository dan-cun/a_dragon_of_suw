import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { lstat, readFile } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { assertNoLinks, ownedPath } from './ocs-storage';
import { loadScript } from './ocs-assets';
import { applyOcsConfigSync, revokeOcsConfigSync } from './ocs-config-sync';
import { runOcsLogin, type OcsLoginAutomation } from './ocs-login-runner';
import { ocsLoginResultSchema, type OcsLoginResult } from '../shared/ocs-login';
import { attachUserScripts, type UserScriptController } from '../ocs/userscripts';
import { ocsLifecycleMessage, type OcsLifecycleSource } from './ocs-lifecycle';
import type { OcsDocument, SavedBrowser } from './ocs-document';
import type { OcsBrowser, OcsState } from '../shared/ocs';
import type { TsinghuaState } from '../shared/ocs-tsinghua';
import { tsinghuaExternalScript } from '../shared/ocs-external';
import { adaptTsinghuaScript } from '../ocs/tsinghua-script';
import { createTsinghuaController, type TsinghuaController } from './ocs-tsinghua';

export type BrowserReporter = (id: string, level: 'info' | 'warning' | 'error', event: string, message: string) => void;
const extensionManifestSchema = z.object({ manifest_version: z.literal(3) });
interface OwnedContext {
  context: BrowserContext; browser: Browser | null; confirmed: boolean; attempted: boolean;
  ownerSequence: number; attachedAt: number; contextCloseObserved: boolean; browserDisconnectObserved: boolean;
  controller: UserScriptController | null; attachment: Promise<void> | null; attachmentSettled: boolean; attachmentError: Error | null;
  disposal: Promise<void> | null; scriptErrors: Error[]; deliveredScriptErrors: number; stopping: boolean; stopTask: Promise<void> | null;
  tsinghua: TsinghuaController | null; tsinghuaDisposal: Promise<void> | null; tsinghuaSettled: boolean;
}

/** Bound a caller's wait without assuming that browser or GM work was cancelled. */
async function awaitClose(operation: Promise<void>, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([operation, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new DOMException(`${label}等待超过 10 秒；未完成的工作仍被持有，禁止重用或删除资料。`, 'TimeoutError')), 10_000); })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

/** Own only Playwright contexts launched with explicitly configured standalone Chrome. */
export function createOcsBrowserRuntime(root: string, executable: string, report: BrowserReporter) {
  const contexts = new Map<string, OwnedContext>();
  const terminalScriptErrors = new Map<string, Error[]>();
  const phases = new Map<string, Pick<OcsBrowser, 'phase' | 'pid' | 'lastError'>>();
  let preview: OcsState['preview'] = null;
  let ownerSequence = 0;
  function current(id: string): BrowserContext {
    const owned = contexts.get(id);
    if (!owned) throw new Error('所选 OCS 浏览器没有运行，请先启动。');
    if (owned.confirmed || owned.stopping) throw new Error('所选浏览器正在收尾或已关闭；用户脚本结算完成前不能聚焦或截图。');
    return owned.context;
  }
  function pageFor(context: BrowserContext): Page {
    const page = context.pages().at(-1);
    if (!page) throw new Error('OCS 浏览器没有可用页面。');
    return page;
  }
  function lifecycle(id: string, owned: OwnedContext, source: OcsLifecycleSource): void {
    const level = source === 'page.crash' ? 'error' : !owned.attempted && source !== 'owner.attached' ? 'warning' : 'info';
    report(id, level, 'browser.lifecycle.' + source, ocsLifecycleMessage({
      source, ownerSequence: owned.ownerSequence, currentOwnerSequence: contexts.get(id)?.ownerSequence ?? null,
      ownerCurrent: contexts.get(id) === owned, attempted: owned.attempted, confirmedBefore: owned.confirmed,
      contextCloseObserved: owned.contextCloseObserved, browserDisconnectObserved: owned.browserDisconnectObserved,
      previousPhase: phases.get(id)?.phase ?? null, elapsedMs: Math.max(0, Math.round(performance.now() - owned.attachedAt)),
      browserConnected: owned.browser?.isConnected() ?? null, pageCount: owned.context.pages().length
    }));
  }
  function scriptsSettled(owned: OwnedContext): boolean {
    return owned.attachmentSettled && (owned.controller === null || owned.controller.isSettled()) && owned.tsinghuaSettled;
  }
  function currentTsinghua(id: string): TsinghuaController {
    current(id);
    const controller = contexts.get(id)?.tsinghua;
    if (!controller) throw new DOMException('所选浏览器的清华社控制器尚未就绪。', 'InvalidStateError');
    return controller;
  }
  function disposeTsinghua(id: string, owned: OwnedContext): Promise<void> {
    if (owned.tsinghuaDisposal) return owned.tsinghuaDisposal;
    if (!owned.tsinghua) return Promise.resolve();
    owned.tsinghuaDisposal = owned.tsinghua.close().then(() => {
      owned.tsinghuaSettled = true;
      releaseSettledOwner(id, owned);
    }, cause => {
      owned.scriptErrors.push(new Error('清华社运行收尾失败；受控 Chrome 仍继续正常关闭。', { cause }));
      owned.tsinghuaSettled = owned.tsinghua?.isSettled() ?? false;
      report(id, 'error', 'tsinghua.dispose.failed', JSON.stringify({ settled: owned.tsinghuaSettled, ownerSequence: owned.ownerSequence }));
      releaseSettledOwner(id, owned);
    });
    return owned.tsinghuaDisposal;
  }
  function releaseSettledOwner(id: string, owned: OwnedContext): void {
    if (contexts.get(id) !== owned || !owned.confirmed || owned.stopping || !scriptsSettled(owned)) return;
    contexts.delete(id);
    const undelivered = owned.scriptErrors.slice(owned.deliveredScriptErrors);
    if (undelivered.length) terminalScriptErrors.set(id, undelivered);
    const failed = owned.attachmentError !== null || owned.scriptErrors.length > 0;
    phases.set(id, { phase: failed ? 'failed' : 'stopped', pid: null, lastError: failed ? 'Chrome 与用户脚本工作均已结束，但收尾报告错误；请查看日志或停止操作的原始原因。' : null });
    if (preview?.browserId === id) preview = null;
    report(id, 'info', 'browser.owner.released', JSON.stringify({ nativeClosed: true, scriptsSettled: true, failed, unreportedErrors: undelivered.length }));
  }
  /** Observe disposal rejection immediately while keeping the original failure for an explicit stop. */
  function disposeScripts(id: string, owned: OwnedContext): Promise<void> {
    if (owned.disposal) return owned.disposal;
    if (!owned.controller) return Promise.resolve();
    const failed = (cause: unknown): void => {
      owned.scriptErrors.push(new Error('OCS 用户脚本收尾失败；底层 Chrome 仍按正常流程关闭。', { cause }));
      report(id, 'error', 'browser.scripts.dispose.failed', '用户脚本收尾报告错误；请检查保留的原始原因。未结算时所有权继续保留。');
      if (contexts.get(id) === owned && owned.confirmed && !owned.stopping) phases.set(id, { phase: 'failed', pid: null, lastError: 'Chrome 已关闭，但用户脚本收尾失败；未结算时所有权仍保留，请重试停止查看原因。' });
      releaseSettledOwner(id, owned);
    };
    report(id, 'info', 'browser.scripts.dispose.requested', '正在停止接受用户脚本调用并结算已接受工作；不是仅刷新存储。');
    try {
      owned.disposal = owned.controller.dispose().then(() => {
        report(id, 'info', 'browser.scripts.dispose.completed', JSON.stringify({ settled: owned.controller?.isSettled() ?? false }));
        releaseSettledOwner(id, owned);
      }, failed);
    } catch (cause) { failed(cause); owned.disposal = Promise.resolve(); }
    return owned.disposal;
  }
  function release(id: string, owned: OwnedContext, source: 'context.close' | 'browser.disconnected' | 'browser.disconnected-state'): void {
    if (source === 'context.close') owned.contextCloseObserved = true;
    else owned.browserDisconnectObserved = true;
    lifecycle(id, owned, source);
    const firstConfirmation = !owned.confirmed;
    owned.confirmed = true;
    // Events from a previous owner may be observed, but must never mutate its replacement.
    if (contexts.get(id) !== owned) return;
    if (firstConfirmation) {
      const previousPhase = phases.get(id)?.phase ?? null;
      phases.set(id, { phase: 'stopping', pid: null, lastError: null });
      if (preview?.browserId === id) preview = null;
      report(id, owned.attempted ? 'info' : 'warning', 'browser.closed', JSON.stringify({
        version: 1, source, requested: owned.attempted, previousPhase, observedAt: new Date().toISOString()
      }));
    }
    void disposeTsinghua(id, owned);
    void disposeScripts(id, owned);
    releaseSettledOwner(id, owned);
  }
  function own(id: string, context: BrowserContext): OwnedContext {
    ownerSequence += 1;
    const owned: OwnedContext = {
      context, browser: context.browser(), confirmed: false, attempted: false,
      ownerSequence, attachedAt: performance.now(), contextCloseObserved: false, browserDisconnectObserved: false,
      controller: null, attachment: null, attachmentSettled: false, attachmentError: null,
      disposal: null, scriptErrors: [], deliveredScriptErrors: 0, stopping: false, stopTask: null,
      tsinghua: null, tsinghuaDisposal: null, tsinghuaSettled: true
    };
    contexts.set(id, owned);
    context.once('close', () => release(id, owned, 'context.close'));
    owned.browser?.once('disconnected', () => release(id, owned, 'browser.disconnected'));
    lifecycle(id, owned, 'owner.attached');
    if (owned.browser && !owned.browser.isConnected()) release(id, owned, 'browser.disconnected-state');
    return owned;
  }
  async function stopOwned(id: string, owned: OwnedContext): Promise<void> {
    phases.set(id, { phase: 'stopping', pid: null, lastError: null });
    const errors: Error[] = [];
    const closeContext = !owned.attempted && !owned.confirmed;
    if (closeContext) owned.attempted = true;
    const attempt = async (operation: Promise<void>, label: string): Promise<void> => {
      try { await awaitClose(operation, label); }
      catch (cause) { errors.push(new Error(`${label}失败或未及时确认。`, { cause })); }
    };
    if (owned.attachment) await attempt(owned.attachment, 'OCS 用户脚本注册');
    if (owned.attachmentError) errors.push(owned.attachmentError);
    await attempt(disposeTsinghua(id, owned), '清华社运行收尾');
    await attempt(disposeScripts(id, owned), 'OCS 用户脚本收尾');
    // GM failures must not skip the independent native close/confirmation path.
    if (closeContext && !owned.confirmed) {
      lifecycle(id, owned, 'context.close.requested');
      await attempt(owned.context.close({ reason: 'The owner requested a normal OCS browser stop.' }), 'OCS Chrome 正常关闭');
    }
    // A second context.close() may be a no-op; only the retained Browser can retry shutdown.
    if (!owned.confirmed && owned.browser) {
      if (owned.browser.isConnected()) {
        lifecycle(id, owned, 'browser.close.requested');
        await attempt(owned.browser.close({ reason: 'Confirm normal shutdown of the owned OCS browser.' }), 'OCS Chrome 关闭确认');
      }
      if (!owned.browser.isConnected() && !owned.confirmed) release(id, owned, 'browser.disconnected-state');
    }
    errors.push(...owned.scriptErrors);
    if (!owned.confirmed) errors.push(new Error('未收到上下文关闭事件，底层浏览器也未确认断连；受控所有权已保留。'));
    if (!scriptsSettled(owned)) errors.push(new Error('用户脚本工作尚未结算；即使 Chrome 已关闭，仍禁止重启或删除资料，请稍后重试停止。'));
    if (!owned.confirmed || !scriptsSettled(owned)) {
      phases.set(id, { phase: 'failed', pid: null, lastError: owned.confirmed ? 'Chrome 已确认关闭，但用户脚本尚未结算；所有权保留，请稍后重试停止。' : '未确认浏览器真实关闭；所有权保留，请重试停止，禁止重启或删除资料。' });
    }
    owned.deliveredScriptErrors = owned.scriptErrors.length;
    if (errors.length) throw new AggregateError(errors, 'OCS 浏览器或用户脚本正常收尾报告错误；未结算的所有权已保留。');
    report(id, 'info', 'browser.stopped', '受控浏览器已正常关闭，用户脚本工作已结算，资料保留。');
  }
  function stop(id: string): Promise<void> {
    const owned = contexts.get(id);
    if (!owned) {
      const errors = terminalScriptErrors.get(id);
      if (errors) {
        terminalScriptErrors.delete(id);
        return Promise.reject(new AggregateError(errors, 'Chrome 已关闭且用户脚本已结算，但意外退出收尾曾失败；原始原因已保留。'));
      }
      phases.set(id, { phase: 'stopped', pid: null, lastError: null });
      return Promise.resolve();
    }
    if (owned.stopTask) return owned.stopTask;
    owned.stopping = true;
    owned.stopTask = stopOwned(id, owned).finally(() => {
      owned.stopping = false;
      owned.stopTask = null;
      releaseSettledOwner(id, owned);
    });
    return owned.stopTask;
  }
  return {
    hasRunning: (): boolean => contexts.size > 0,
    hasContext: (id: string): boolean => contexts.has(id),
    browserState: (browser: SavedBrowser): OcsBrowser => ({ ...browser, ...(phases.get(browser.id) ?? { phase: 'stopped' as const, pid: null, lastError: null }), owned: contexts.has(browser.id) }),
    preview: (): OcsState['preview'] => preview ? { ...preview } : null,
    tsinghuaStates: (): TsinghuaState[] => [...contexts.values()].flatMap(owned => owned.tsinghua ? [owned.tsinghua.snapshot()] : []),
    tsinghuaResumeUrl: (id: string): string | null => contexts.get(id)?.tsinghua?.resumeUrl() ?? null,
    openTsinghua: (id: string): Promise<void> => currentTsinghua(id).open(),
    verifyTsinghuaSlider: (id: string): Promise<void> => currentTsinghua(id).verifySlider(),
    selectTsinghuaCourse: (id: string, courseId: number): Promise<void> => currentTsinghua(id).selectCourse(courseId),
    startTsinghua: (id: string): Promise<void> => currentTsinghua(id).start(),
    stopTsinghua(id: string): Promise<void> {
      const controller = contexts.get(id)?.tsinghua;
      if (!controller) return Promise.reject(new DOMException('所选浏览器没有可停止的清华社控制器。', 'InvalidStateError'));
      return controller.stop();
    },
    refreshTsinghua: (id: string): Promise<void> => currentTsinghua(id).refresh(),
    readTsinghuaScore: (id: string): Promise<void> => currentTsinghua(id).readScore(),
    stop,
    async stopAll(): Promise<void> {
      const results = await Promise.allSettled([...new Set([...contexts.keys(), ...terminalScriptErrors.keys()])].map(stop));
      const errors = results.filter((value): value is PromiseRejectedResult => value.status === 'rejected').map(value => value.reason instanceof Error ? value.reason : new Error('OCS 浏览器关闭失败。'));
      if (errors.length) throw new AggregateError(errors, '部分 OCS 浏览器正常关闭发生错误，未终止其他程序。');
    },
    async start(browser: SavedBrowser, document: OcsDocument): Promise<void> {
      if (contexts.has(browser.id)) throw new Error('此浏览器仍被持有，请先确认停止再重新启动。');
      const previousErrors = terminalScriptErrors.get(browser.id);
      if (previousErrors) {
        terminalScriptErrors.delete(browser.id);
        throw new AggregateError(previousErrors, '上次用户脚本收尾已结算但报告错误；本次未启动新实例，原始原因已交付，请检查后再启动。');
      }
      if (!executable || !isAbsolute(executable) || basename(executable).toLowerCase() !== 'chrome.exe') throw new Error('SWU_OCS_BROWSER 必须指向固定独立 Chrome 的绝对 chrome.exe 路径；不会回退系统 Edge。');
      if (!(await lstat(executable)).isFile()) throw new Error('独立 Chrome 可执行文件不存在。');
      const automation = document.automations.find(value => value.browserId === browser.id);
      if (automation && automation.name !== '通用-新建页面') report(browser.id, 'info', 'automation.awaiting-confirmation', '已保存登录配置；启动不读取或提交参数，须单独确认执行一次。');
      const profile = ownedPath(root, 'profiles', browser.id);
      await assertNoLinks(profile);
      const extensions: string[] = [];
      for (const item of document.extensions.filter(value => value.enabled)) {
        const folder = ownedPath(root, 'extensions', item.id);
        await assertNoLinks(folder); await assertNoLinks(join(folder, 'manifest.json'));
        extensionManifestSchema.parse(JSON.parse(await readFile(join(folder, 'manifest.json'), 'utf8')));
        extensions.push(folder);
      }
      const programs = await Promise.all(document.userScripts.filter(value => value.enabled).map(item => loadScript(root, item)));
      if (programs.some(program => !program.supported)) throw new Error('启用的用户脚本声明了超出已适配 GM 存储子集的权限，无法安全启动。');
      const tsinghuaInstalled = document.userScripts.some(item => item.digest === tsinghuaExternalScript.digest);
      const tsinghuaProgram = programs.find(program => program.digest === tsinghuaExternalScript.digest);
      const tsinghuaAdaptation = tsinghuaProgram ? adaptTsinghuaScript(tsinghuaProgram.content, tsinghuaProgram.digest) : null;
      // Complete private-store reconciliation before launching Chrome or registering any GM runtime.
      for (const item of document.userScripts) {
        const program = programs.find(value => value.id === item.id);
        if (program && document.settings.syncEnabled && item.configSyncDigest === program.digest) {
          const stats = await applyOcsConfigSync(root, browser.id, program, item.configSyncDigest, document.settings.globalConfigJson);
          report(browser.id, 'info', 'config-sync.applied', JSON.stringify({ status: 'applied', ...stats }));
        } else {
          for (const digest of new Set([item.digest, ...(item.configSyncDigest ? [item.configSyncDigest] : [])])) {
            const stats = await revokeOcsConfigSync(root, browser.id, item.id, digest);
            report(browser.id, 'info', 'config-sync.reconciled', JSON.stringify({ status: 'revoked', ...stats }));
          }
        }
      }
      report(browser.id, 'warning', 'script.runtime.scope', 'grant-none 是非可信页面世界脚本；隔离 GM 支持信息、持久存储、值监听、Tab 数据和样式共 11 项。无网络请求、unsafeWindow、@require/@resource/@connect 或完整 OCSJS 课程能力。');
      phases.set(browser.id, { phase: 'starting', pid: null, lastError: null });
      report(browser.id, 'info', 'browser.starting', '正在启动独立 Chrome 和隔离浏览器资料。');
      try {
        const context = await chromium.launchPersistentContext(profile, {
          executablePath: executable, headless: false, viewport: { width: 1280, height: 800 },
          ignoreHTTPSErrors: false, acceptDownloads: false, serviceWorkers: 'allow',
          timeout: 30_000, ignoreDefaultArgs: ['--disable-extensions'],
          args: ['--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps', '--disable-features=Translate', ...(extensions.length ? [`--load-extension=${extensions.join(',')}`, `--disable-extensions-except=${extensions.join(',')}`] : [])]
        });
        const owned = own(browser.id, context);
        owned.tsinghua = createTsinghuaController(browser.id, context, {
          installed: tsinghuaInstalled, enabled: tsinghuaProgram !== undefined,
          adapterVersion: tsinghuaAdaptation?.adapterVersion ?? null,
          sourceDigest: tsinghuaInstalled ? tsinghuaExternalScript.digest : null,
          executionDigest: tsinghuaAdaptation?.executionDigest ?? null
        }, report);
        owned.tsinghuaSettled = false;
        context.setDefaultTimeout(15_000); context.setDefaultNavigationTimeout(30_000);
        const attachPage = (page: Page): void => {
          page.on('pageerror', () => report(browser.id, 'error', 'page.error', '页面脚本发生错误；未记录页面内容或账号参数。'));
          page.once('close', () => lifecycle(browser.id, owned, 'page.close'));
          page.on('crash', () => { lifecycle(browser.id, owned, 'page.crash'); report(browser.id, 'error', 'page.crashed', '受控浏览器页面崩溃，请停止后重启。'); });
          page.on('dialog', dialog => {
            if (!document.settings.enableDialogs) void dialog.dismiss().catch(() => report(browser.id, 'warning', 'dialog.dismiss.failed', '页面对话框关闭失败。'));
          });
        };
        context.pages().forEach(attachPage); context.on('page', attachPage);
        const extensionWorker = (url: string): void => { if (url.startsWith('chrome-extension://')) report(browser.id, 'info', 'extension.worker.started', '受控浏览器已启动 MV3 扩展后台。'); };
        context.serviceWorkers().forEach(worker => extensionWorker(worker.url()));
        context.on('serviceworker', worker => extensionWorker(worker.url()));
        owned.attachment = attachUserScripts(context, programs, (id, outcome) => report(browser.id, outcome === 'failed' ? 'error' : 'info', `script.${outcome}`, `用户脚本 ${id} ${outcome === 'failed' ? '执行失败；可能受到页面 CSP 限制' : '已执行'}。`), { root, profileId: browser.id }).then(controller => {
          owned.controller = controller;
          owned.attachmentSettled = true;
          if (owned.confirmed || owned.attempted) void disposeScripts(browser.id, owned);
          releaseSettledOwner(browser.id, owned);
        }, cause => {
          owned.attachmentSettled = true;
          owned.attachmentError = new Error('OCS 用户脚本注册失败。', { cause });
          releaseSettledOwner(browser.id, owned);
        });
        await owned.attachment;
        if (owned.attachmentError) throw owned.attachmentError;
        if (owned.confirmed || owned.attempted) throw new Error('浏览器在用户脚本注册完成前已关闭或请求停止。');
        // No private configuration, anonymous tokens or actions cross into untrusted pages.
        await context.route(/^http:\/\/(localhost|127\.0\.0\.1):15319\//, route => route.fulfill({
          status: 403, headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
          contentType: 'application/json', body: JSON.stringify({ error: 'A trusted private script channel is not implemented.' })
        }));
        const page = context.pages()[0] ?? await context.newPage();
        await page.goto(browser.startUrl, { waitUntil: 'domcontentloaded' });
        if (automation?.name === '通用-新建页面') {
          const { runNavigation } = await import('../ocs/upstream.js');
          await runNavigation(page, automation.name, automation.values);
          report(browser.id, 'info', 'automation.navigation.completed', '上游通用页面导航自动化已执行；不代表课程完成。');
        }
        if (contexts.get(browser.id) !== owned || owned.confirmed || owned.attempted) throw new Error('浏览器在启动完成前已关闭或请求停止。');
        phases.set(browser.id, { phase: 'running', pid: null, lastError: null });
        report(browser.id, 'info', 'browser.running', '浏览器已运行；此状态不表示课程或登录任务完成。');
      } catch (cause) {
        const retained = contexts.get(browser.id);
        if (retained && retained.attachment === null) retained.attachmentSettled = true;
        if (contexts.has(browser.id)) {
          try { await stop(browser.id); }
          catch (cleanupCause) {
            phases.set(browser.id, { phase: 'failed', pid: null, lastError: contexts.has(browser.id) ? '浏览器启动及清理失败；仍持有所有权，请重试停止。' : '浏览器启动失败；资源已确认关闭，但清理调用报告错误。' });
            report(browser.id, 'error', 'browser.cleanup.failed', '启动失败后的正常清理报告错误，请检查所有权状态。');
            throw new AggregateError([cause, cleanupCause], 'OCS 浏览器启动及正常清理均报告错误。', { cause });
          }
        }
        phases.set(browser.id, { phase: 'failed', pid: null, lastError: '浏览器启动失败，请查看脱敏运行日志。' });
        throw cause;
      }
    },
    async runAutomation(id: string, automation: OcsLoginAutomation, confirmation: { confirmed: true }): Promise<OcsLoginResult> {
      const owned = contexts.get(id);
      const context = current(id);
      if (!owned || contexts.get(id) !== owned || phases.get(id)?.phase !== 'running') throw new DOMException('OCS 单次登录仅允许当前持有且运行中的原生浏览器。', 'InvalidStateError');
      const page = pageFor(context);
      if (page.isClosed() || page.context() !== owned.context) throw new DOMException('OCS 登录页面已关闭或不属于当前受控浏览器。', 'InvalidStateError');
      const result = ocsLoginResultSchema.parse(await runOcsLogin(page, automation, confirmation));
      if (contexts.get(id) !== owned || owned.confirmed || owned.stopping || page.isClosed()) throw new DOMException('OCS 浏览器在单次登录执行中关闭或所有权改变；提交结果未验证，请人工核对且勿盲目重试。', 'InvalidStateError');
      return result;
    },
    async focus(id: string): Promise<void> { await pageFor(current(id)).bringToFront(); report(id, 'info', 'browser.focused', '已请求显示受控浏览器。'); },
    async capture(id: string): Promise<void> {
      const image = await pageFor(current(id)).screenshot({ type: 'png', fullPage: false, timeout: 15_000 });
      if (image.length > 6_000_000) throw new Error('浏览器截图超过 6 MB，未返回页面图像。');
      preview = { browserId: id, image: 'data:image/png;base64,' + image.toString('base64'), at: new Date().toISOString() };
      report(id, 'info', 'browser.preview', '已获取当前页面截图；不是实时窗口视频。');
    }
  };
}
