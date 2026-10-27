import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { ocsCommandSchema, ocsStateSchema, type OcsCommand, type OcsState } from '../shared/ocs';
import { tsinghuaExternalScript } from '../shared/ocs-external';
import { openDataFolder } from './native';
import { createOcsRepository, assertNoLinks, ownedPath } from './ocs-storage';
import { emptyOcsDocument, ocsDocumentSchema, type OcsDocument, type SavedScript } from './ocs-document';
import { downloadScript, importExtension, importScript, loadScript, scriptDigest } from './ocs-assets';
import { createOcsBrowserRuntime } from './ocs-browser';
import { createOcsPronunciationService } from './ocs-pronunciation';
import { revokeOcsConfigSync, updateOcsConfigSyncAuthorization } from './ocs-config-sync';
import { mergeConfig, privateStrings, publicConfig, sanitizeOcsMessage } from './ocs-privacy';

const catalogSchema = ocsStateSchema.shape.automationCatalog;

/** Source-owned backend: no Electron process, original store migration, or system browser fallback. */
export function createOcsService(directory: string) {
  const repository = createOcsRepository(directory);
  const configuredBrowser = process.env['SWU_OCS_BROWSER'];
  const legacyDistribution = process.env['SWU_OCS_DIST'];
  const candidates = [
    ...(legacyDistribution && isAbsolute(legacyDistribution) ? [join(legacyDistribution, 'resources', 'bin', 'chrome', 'chrome', 'chrome.exe')] : []),
    join(dirname(process.execPath), 'modules', 'ocs', 'browser', 'chrome.exe')
  ];
  const executable = configuredBrowser !== undefined
    ? isAbsolute(configuredBrowser) ? configuredBrowser : ''
    : candidates.find(existsSync) ?? '';
  let document: OcsDocument = emptyOcsDocument();
  let initialized = false;
  let closed = false;
  let closing = false;
  let pending = 0;
  let sequence = 0;
  let queue: Promise<void> = Promise.resolve();
  const courseEpochs = new Map<string, number>();
  const courseLaunches = new Map<string, Promise<void>>();
  let catalog: OcsState['automationCatalog'] = [];
  let automationRun: OcsState['automationRun'] = null;
  const logs: OcsState['logs'] = [];
  function log(browserId: string | null, level: 'info' | 'warning' | 'error', event: string, message: string): void {
    sequence += 1;
    logs.push({ sequence, at: new Date().toISOString(), browserId, level, event, message: sanitizeOcsMessage(message, privateStrings(document)) });
    if (logs.length > 300) logs.splice(0, logs.length - 300);
  }
  const runtime = createOcsBrowserRuntime(repository.root, executable, log);
  const pronunciation = createOcsPronunciationService((level, event, message) => log(null, level, event, message));
  async function initialize(): Promise<void> {
    if (initialized) return;
    document = await repository.read();
    const { automationCatalog } = await import('../ocs/upstream.js');
    catalog = catalogSchema.parse(automationCatalog());
    initialized = true;
    log(null, 'info', 'source.initialized', '已加载源码集成独立配置；未读取或迁移旧 Electron 密文。');
  }
  let configurationRevision = 0;
  async function save(next: OcsDocument): Promise<void> {
    const parsed = ocsDocumentSchema.parse(next);
    await repository.save(parsed);
    document = parsed;
    configurationRevision += 1;
  }
  function requireStopped(): void {
    if (runtime.hasRunning()) throw new Error('请先停止全部 OCS 浏览器，再修改设置、脚本或扩展，避免显示状态与实际加载内容不一致。');
  }
  function browser(id: string) {
    const item = document.browsers.find(value => value.id === id);
    if (!item) throw new Error('所选浏览器不存在，请刷新列表。');
    return item;
  }
  function snapshot(): OcsState {
    const available = executable.length > 0 && existsSync(executable);
    const speech = pronunciation.snapshot();
    return ocsStateSchema.parse({
      version: '2.12.0', integration: 'source', phase: available ? 'ready' : 'unavailable',
      message: available ? '源码集成后台已就绪。浏览器运行不代表登录或课程完成；旧 Electron 数据不自动迁移。' : '尚未配置可用独立 Chrome（SWU_OCS_BROWSER）。配置管理仍可使用，不会回退系统 Edge。',
      dataDirectory: repository.root, browserExecutable: executable, configurationRevision,
      browsers: document.browsers.map(runtime.browserState), userScripts: document.userScripts.map(item => ({ id: item.id, name: item.name, version: item.version, source: item.source, enabled: item.enabled, digest: item.digest, configSyncAuthorized: item.configSyncDigest === item.digest })),
      extensions: document.extensions, settings: { ...document.settings, globalConfigJson: publicConfig(document.settings.globalConfigJson) },
      pronunciation: speech, tsinghua: runtime.tsinghuaStates().filter(value => document.browsers.some(item => item.id === value.browserId)),
      automationCatalog: catalog, automationRun, logs, preview: runtime.preview(),
      capabilities: [
        { id: 'source-browser', label: '独立浏览器与资料管理', available, detail: 'Bun 直接持有 Playwright 上下文；独立 Chrome、隔离资料、正常关闭，不启动 OCS Desktop.exe。' },
        { id: 'pronunciation', label: 'Windows 本机英语发音练习', available: speech.catalogue === 'ready', detail: 'System.Speech 是本机朗读主路径；仅显式准备并选择已启用英语音色后朗读，不用浏览器或云端音色，不录音或导出，不向课程提交或判定完成。' },
        { id: 'settings', label: '配置与私有自动化参数', available: true, detail: '独立 schema，Windows CurrentUser DPAPI 加密；自动化值不回显，已保存私有配置使用占位值保留。' },
        { id: 'userscripts', label: '用户脚本导入与执行', available: true, detail: '支持 HTTPS 下载、本地源码、页面匹配、grant-none、11 项基础 GM、两种网络声明及两项资源 API。GM 写入返回 Promise；修改后需重启受控浏览器。' },
        { id: 'tsinghua-external-script', label: '清华社英语在线外部脚本接入（实验性）', available: true, detail: '逐次确认后从固定上游版本下载并校验 SHA-256，安装后禁用，需本人审阅再启用；不授权私有配置同步，不自动登录或提交，不代表课程完成。GPL-3.0-only 脚本不内置于源码或安装包。' },
        { id: 'force-script-update', label: '强制安装或更新脚本管理器内的脚本', available: false, detail: '仅保存 forceUpdateScripts 偏好；不自动点击安装页、不把页面关闭当作安装完成。' },
        { id: 'gm-runtime', label: '完整 GM 用户脚本运行时', available: false, detail: '已提供基础信息、存储、值监听、Tab、样式，加显式 @connect 的受限 HTTPS 请求及固定内置/文本 data 资源子集；仍不支持 unsafeWindow、GM_notification、@require 和本机连接，完整 OCSJS 与课程运行仍不支持。' },
        { id: 'extensions', label: 'MV3 扩展导入与加载', available: true, detail: '真实复制 MV3 普通文件目录，拒绝联接和越界；只向指定独立 Chrome 加载。' },
        { id: 'upstream-navigation', label: '上游通用导航自动化', available: true, detail: '直接复用固定官方源码 NewPageScript；保存的登录配置不会在启动时执行。' },
        { id: 'automatic-login', label: '显式单次平台登录子集', available: true, detail: '超星手机密码和智慧职教需逐次确认，仅使用所选浏览器已存参数，最多一次提交，无重试。其余四种登录明确不支持；验证码及结果由本人核对，不声称登录成功。' },
        { id: 'script-actions', label: '脚本辅助动作', available: false, detail: '匿名兼容配置、令牌及动作接口全部返回 403，不开启公共辅助监听；私有配置子集仅通过单独授权的隔离 GM 存储提供。' },
        { id: 'config-sync', label: '精确脚本授权的配置同步子集', available: true, detail: '总开关与精确摘要授权同时开启时，在启动前同步 23 个 flat scalar 和 common.settings.answererWrappers 至隔离 GM；撤销、禁用和关闭总开关清除注入并恢复原值。普通页面无权；已披露秘密无法召回。' },
        { id: 'ocr', label: 'OCS 图片与滑块 OCR', available: false, detail: '未移植外部 OCR CLI，不将宿主四位数字 OCR 冒充兼容。' },
        { id: 'preview', label: '页面截图预览', available: true, detail: '按需 PNG 截图，无音视频采集；页面可能包含账号内容，仅本机当前内存保留。' },
        { id: 'live-video', label: '原版实时窗口视频', available: false, detail: '未复制 Electron desktopCapturer，不以截图冒充实时窗口视频。' },
        { id: 'course-results', label: '清华社旧版课程辅助（实验性）', available, detail: '仅所选受控清华社旧版课程：自动导航、普通练习辅助、正常媒体播放和平台结果读取。语音题等待本人录音；无结果明确显示未验证，不以 HTTP 成功或翻页认定全课完成；其他平台不提供课程执行。' }
      ]
    });
  }
  async function removeOwned(...segments: string[]): Promise<void> {
    const path = ownedPath(repository.root, ...segments);
    await assertNoLinks(path);
    await rm(path, { recursive: true, force: true });
  }
  async function revokeScriptSync(item: SavedScript): Promise<void> {
    let restoredKeys = 0;
    let removedKeys = 0;
    for (const profile of document.browsers) {
      for (const digest of new Set([item.digest, ...(item.configSyncDigest ? [item.configSyncDigest] : [])])) {
        const stats = await revokeOcsConfigSync(repository.root, profile.id, item.id, digest);
        restoredKeys += stats.restoredKeys;
        removedKeys += stats.removedKeys;
      }
    }
    log(null, 'info', 'config-sync.revoked', JSON.stringify({ status: 'revoked', profiles: document.browsers.length, restoredKeys, removedKeys }));
  }
  async function rememberTsinghuaResume(id: string): Promise<void> {
    const url = runtime.tsinghuaResumeUrl(id);
    if (url === null || browser(id).startUrl === url) return;
    const parsed = new URL(url);
    if (parsed.origin !== 'https://www.tsinghuaelt.com' || !/^\/legacy\/course-student\/\d+\/study$/.test(parsed.pathname) || parsed.search || parsed.hash || parsed.username || parsed.password) throw new TypeError('清华社续学入口不是已核对的旧版课程详情地址，未保存。');
    await save({ ...document, browsers: document.browsers.map(value => value.id === id ? { ...value, startUrl: url, updatedAt: new Date().toISOString() } : value) });
  }
  async function perform(command: OcsCommand): Promise<void> {
    switch (command.command) {
      case 'state': return;
      case 'data': await openDataFolder(repository.root); return;
      case 'pronunciation-prepare': await pronunciation.prepare(); return;
      case 'pronunciation-speak': await pronunciation.speak(command); return;
      case 'pronunciation-stop': await pronunciation.stop(); return;
      case 'tsinghua-open': {
        const item = browser(command.id);
        const epoch = courseEpochs.get(command.id) ?? 0;
        if (!runtime.hasContext(command.id)) {
          const launch = runtime.start(item, document);
          courseLaunches.set(command.id, launch);
          try { await launch; }
          finally { courseLaunches.delete(command.id); }
        }
        if (epoch !== (courseEpochs.get(command.id) ?? 0)) throw new DOMException('打开课程已被停止请求取消；浏览器已启动，但未继续课程导航。', 'AbortError');
        await runtime.openTsinghua(command.id);
        if (epoch !== (courseEpochs.get(command.id) ?? 0)) throw new DOMException('课程导航已取消，未保存本次续学入口。', 'AbortError');
        await rememberTsinghuaResume(command.id);
        return;
      }
      case 'tsinghua-select-course':
        browser(command.id);
        await runtime.selectTsinghuaCourse(command.id, command.courseId);
        await rememberTsinghuaResume(command.id);
        return;
      case 'tsinghua-start':
        browser(command.id);
        if (pronunciation.snapshot().owned) throw new DOMException('本机朗读尚未确认释放，请先停止朗读并确认声音停止，再开始课程或本人录音。', 'InvalidStateError');
        if (!document.userScripts.some(item => item.digest === tsinghuaExternalScript.digest && item.enabled)) throw new DOMException('请先安装并明确启用已核对的清华社外部脚本，再启动课程辅助。', 'InvalidStateError');
        await runtime.startTsinghua(command.id);
        return;
      case 'tsinghua-stop': {
        browser(command.id);
        const launch = courseLaunches.get(command.id);
        if (launch) await launch;
        await runtime.stopTsinghua(command.id);
        return;
      }
      case 'tsinghua-refresh': browser(command.id); await runtime.refreshTsinghua(command.id); return;
      case 'tsinghua-read-score': browser(command.id); await runtime.readTsinghuaScore(command.id); return;
      case 'tsinghua-verify-slider': browser(command.id); await runtime.verifyTsinghuaSlider(command.id); return;
      case 'browser-create': {
        const now = new Date().toISOString();
        await save({ ...document, browsers: [...document.browsers, { ...command.browser, id: randomUUID(), automationName: null, createdAt: now, updatedAt: now }] });
        log(null, 'info', 'browser.created', '已创建独立浏览器资料元数据。'); return;
      }
      case 'browser-update': {
        const previous = browser(command.id);
        if (runtime.hasContext(command.id) || (runtime.browserState(previous).phase !== 'stopped' && runtime.browserState(previous).phase !== 'failed')) throw new Error('请先停止所选浏览器再编辑资料。');
        await save({ ...document, browsers: document.browsers.map(value => value.id === command.id ? { ...value, ...command.browser, updatedAt: new Date().toISOString() } : value) });
        log(command.id, 'info', 'browser.updated', '浏览器资料元数据已保存。'); return;
      }
      case 'browser-delete': {
        const previous = browser(command.id);
        if (runtime.hasContext(command.id) || ['running', 'starting', 'stopping'].includes(runtime.browserState(previous).phase)) throw new Error('请先停止所选浏览器再删除资料。');
        await removeOwned('profiles', command.id);
        await removeOwned('gm-values', command.id);
        await removeOwned('config-sync-journal', 'gm-values', command.id);
        if (automationRun?.browserId === command.id) automationRun = null;
        await save({ ...document, browsers: document.browsers.filter(value => value.id !== command.id), automations: document.automations.filter(value => value.browserId !== command.id) });
        log(null, 'info', 'browser.deleted', '所选浏览器资料及其私有自动化参数已删除；旧 OCS 数据不变。'); return;
      }
      case 'browser-start': {
        const item = browser(command.id);
        if (automationRun?.browserId === command.id) automationRun = null;
        await runtime.start(item, document); return;
      }
      case 'browser-stop': browser(command.id); await runtime.stop(command.id); return;
      case 'browser-focus': browser(command.id); await runtime.focus(command.id); return;
      case 'browser-preview': browser(command.id); await runtime.capture(command.id); return;
      case 'browsers-stop': await runtime.stopAll(); return;
      case 'automation-save': {
        browser(command.id);
        const definition = catalog.find(value => value.name === command.name);
        if (!definition) throw new Error('自动化名称不在固定上游源码目录中。');
        if (new Set(command.values.map(value => value.key)).size !== command.values.length || command.values.some(value => !definition.fields.some(field => field.key === value.key))) throw new Error('自动化参数包含重复或未知字段。');
        const previous = document.automations.find(value => value.browserId === command.id && value.name === command.name);
        const values = definition.fields.map(field => {
          const input = command.values.find(value => value.key === field.key)?.value;
          const prior = previous?.values.find(value => value.key === field.key)?.value;
          return { key: field.key, value: input === undefined || (field.secret && input === '') ? prior ?? field.initialValue : input };
        });
        await save({ ...document, automations: [...document.automations.filter(value => value.browserId !== command.id), { browserId: command.id, name: command.name, values }], browsers: document.browsers.map(value => value.id === command.id ? { ...value, automationName: command.name, updatedAt: new Date().toISOString() } : value) });
        if (automationRun?.browserId === command.id) automationRun = null;
        log(command.id, 'info', 'automation.saved', '自动化私有参数已加密保存，不会回显或自动提交。'); return;
      }
      case 'automation-clear': {
        browser(command.id);
        await save({ ...document, automations: document.automations.filter(value => value.browserId !== command.id), browsers: document.browsers.map(value => value.id === command.id ? { ...value, automationName: null, updatedAt: new Date().toISOString() } : value) });
        if (automationRun?.browserId === command.id) automationRun = null;
        log(command.id, 'info', 'automation.cleared', '所选浏览器私有自动化参数已清除。'); return;
      }
      case 'automation-run': {
        const item = browser(command.id);
        const automation = document.automations.find(value => value.browserId === command.id);
        if (!automation || item.automationName === null) throw new DOMException('所选浏览器尚未配置登录自动化；本次未操作页面。', 'InvalidStateError');
        if (automation.name !== command.name || item.automationName !== command.name) throw new TypeError('OCS 登录确认名称与已保存配置不一致，请刷新并重新确认，未操作页面。');
        automationRun = null;
        const result = await runtime.runAutomation(command.id, automation, { confirmed: command.confirmed });
        automationRun = { browserId: command.id, at: new Date().toISOString(), result };
        log(command.id, result.status === 'unsupported' ? 'warning' : 'info', 'automation.run.result', JSON.stringify({ status: result.status, submitAttempts: result.submitAttempts, loginVerified: result.loginVerified, requiresManualVerification: result.requiresManualVerification }));
        return;
      }
      case 'script-config-sync': {
        requireStopped();
        const item = document.userScripts.find(value => value.id === command.id);
        if (!item) throw new RangeError('用户脚本不存在，无法修改私有配置授权。');
        const program = await loadScript(repository.root, item);
        const next = updateOcsConfigSyncAuthorization(item, program, { id: command.id, digest: command.digest, authorized: command.authorized });
        if (!command.authorized) await revokeScriptSync(item);
        await save({ ...document, userScripts: document.userScripts.map(value => value.id === item.id ? next : value) });
        log(null, 'info', 'config-sync.authorization.changed', JSON.stringify({ status: command.authorized ? 'authorized-exact-digest' : 'revoked' }));
        return;
      }
      case 'script-install-tsinghua': {
        requireStopped();
        if (document.userScripts.some(item => item.digest === tsinghuaExternalScript.digest)) throw new DOMException('已安装此固定版本的清华社外部脚本，请在用户脚本列表检查；本次未下载或创建副本。', 'InvalidStateError');
        const download = await downloadScript(tsinghuaExternalScript.url, (level, event, message) => log(null, level, event, message));
        const digest = scriptDigest(download.content);
        if (digest !== tsinghuaExternalScript.digest) throw new TypeError(`清华社外部脚本 SHA-256 校验失败；地址：${tsinghuaExternalScript.url}；预期：${tsinghuaExternalScript.digest}；实际：${digest}。未安装，请核对上游固定版本。`);
        const item = await importScript(repository.root, download.content, download.source);
        try { await save({ ...document, userScripts: [...document.userScripts, { ...item, enabled: false }] }); }
        catch (cause) { await removeOwned('scripts', item.id + '.user.js'); throw cause; }
        log(null, 'info', 'script.external.tsinghua.installed', JSON.stringify({ name: tsinghuaExternalScript.name, revision: tsinghuaExternalScript.revision, digest, enabled: false, configSyncAuthorized: false }));
        return;
      }
      case 'script-import':
      case 'script-download': {
        requireStopped();
        const download = command.command === 'script-download' ? await downloadScript(command.url, (level, event, message) => log(null, level, event, message)) : { content: command.content, source: '本地源码导入' };
        const fixedTsinghua = scriptDigest(download.content) === tsinghuaExternalScript.digest;
        if (fixedTsinghua && document.userScripts.some(item => item.digest === tsinghuaExternalScript.digest)) throw new DOMException('已安装此固定版本的清华社外部脚本，请在用户脚本列表检查；本次未创建副本。', 'InvalidStateError');
        const imported = await importScript(repository.root, download.content, download.source);
        const item = fixedTsinghua ? { ...imported, enabled: false } : imported;
        if (command.command === 'script-import') item.name = command.name;
        try { await save({ ...document, userScripts: [...document.userScripts, item] }); }
        catch (cause) { await removeOwned('scripts', item.id + '.user.js'); throw cause; }
        log(null, item.enabled ? 'info' : 'warning', 'script.imported', fixedTsinghua ? '清华社外部脚本已导入并出于安全考虑默认禁用，请本人审阅后再启用；未授权私有配置同步，不代表课程完成。' : item.enabled ? '用户脚本已导入并启用，将按其页面范围执行。' : '用户脚本已导入但禁用：GM/require/resource 运行能力尚未适配。'); return;
      }
      case 'script-enable': {
        requireStopped();
        const item = document.userScripts.find(value => value.id === command.id);
        if (!item) throw new Error('用户脚本不存在。');
        if (command.enabled && !(await loadScript(repository.root, item)).supported) throw new Error('此脚本依赖尚未适配的 GM 权限、@require 或 @resource，不能启用。');
        if (!command.enabled) await revokeScriptSync(item);
        await save({ ...document, userScripts: document.userScripts.map(value => value.id === command.id ? { ...value, enabled: command.enabled } : value) });
        log(null, 'info', 'script.enabled.changed', '用户脚本启用状态已保存；禁用时已恢复或移除同步值，精确版本授权保留。'); return;
      }
      case 'script-delete': {
        requireStopped();
        const item = document.userScripts.find(value => value.id === command.id);
        if (!item) throw new Error('用户脚本不存在。');
        await revokeScriptSync(item);
        await removeOwned('scripts', command.id + '.user.js');
        await save({ ...document, userScripts: document.userScripts.filter(value => value.id !== command.id) });
        log(null, 'info', 'script.deleted', '用户脚本源码与记录已删除。'); return;
      }
      case 'extension-import': {
        requireStopped();
        const item = await importExtension(repository.root, command.directory);
        try { await save({ ...document, extensions: [...document.extensions, item] }); }
        catch (cause) { await removeOwned('extensions', item.id); throw cause; }
        log(null, 'info', 'extension.imported', 'MV3 扩展已复制到独立目录，启动受控浏览器时加载。'); return;
      }
      case 'extension-enable': {
        requireStopped();
        if (!document.extensions.some(value => value.id === command.id)) throw new Error('扩展不存在。');
        await save({ ...document, extensions: document.extensions.map(value => value.id === command.id ? { ...value, enabled: command.enabled } : value) });
        log(null, 'info', 'extension.enabled.changed', '扩展启用状态已保存。'); return;
      }
      case 'extension-delete': {
        requireStopped();
        if (!document.extensions.some(value => value.id === command.id)) throw new Error('扩展不存在。');
        await removeOwned('extensions', command.id);
        await save({ ...document, extensions: document.extensions.filter(value => value.id !== command.id) });
        log(null, 'info', 'extension.deleted', '独立扩展副本与记录已删除，不修改导入来源。'); return;
      }
      case 'settings-save': {
        requireStopped();
        const globalConfigJson = mergeConfig(command.settings.globalConfigJson, document.settings.globalConfigJson);
        if (!command.settings.syncEnabled) for (const item of document.userScripts) await revokeScriptSync(item);
        await save({ ...document, settings: { ...command.settings, globalConfigJson } });
        log(null, 'info', 'settings.saved', '设置已加密保存；脚本强制更新选项仅保留配置，未冒充完整 GM 安装功能。'); return;
      }
    }
  }
  return {
    isBusy: (): boolean => pending > 0,
    execute(input: OcsCommand): Promise<OcsState> {
      if (closing || closed) return Promise.reject(new Error('OCS 源码集成服务已关闭或正在正常关闭。'));
      const parsed = ocsCommandSchema.safeParse(input);
      if (!parsed.success) {
        if (typeof input === 'object' && input !== null && 'command' in input && typeof input.command === 'string' && input.command.startsWith('pronunciation-')) return Promise.reject(new TypeError('本机语音命令参数无效，请核对音色、纯文本长度及整数语速；未回显输入或校验原文。'));
        return Promise.reject(parsed.error);
      }
      const command = parsed.data;
      // Cancellation must not wait behind a navigation or an accepted course operation.
      if (command.command === 'tsinghua-stop') {
        courseEpochs.set(command.id, (courseEpochs.get(command.id) ?? 0) + 1);
        if (!initialized) return Promise.reject(new DOMException('尚未初始化清华社课程会话，没有可停止的本应用任务。', 'InvalidStateError'));
        pending += 1;
        return perform(command).then(snapshot).catch(cause => {
          const message = sanitizeOcsMessage(cause instanceof Error ? cause.message : '停止返回非标准错误。', privateStrings(document));
          log(command.id, 'error', 'tsinghua-stop.failed', message);
          throw new Error('清华社任务停止未确认：' + message, { cause });
        }).finally(() => { pending -= 1; });
      }
      // State polling shares the queue but does not constitute a mutating business operation.
      const mutation = command.command !== 'state';
      const courseId = command.command.startsWith('tsinghua-') && 'id' in command ? command.id : null;
      const courseEpoch = courseId === null ? null : courseEpochs.get(courseId) ?? 0;
      if (mutation) pending += 1;
      const operation = queue.then(async () => {
        if (closed) throw new Error('OCS 源码集成服务已关闭。');
        await initialize();
        if (courseId !== null && courseEpoch !== (courseEpochs.get(courseId) ?? 0)) throw new DOMException('此课程操作已被后续停止请求取消，未重新执行。', 'AbortError');
        try { await perform(command); }
        catch (cause) {
          const message = sanitizeOcsMessage(cause instanceof Error ? cause.message : '收到非标准错误。', privateStrings(document));
          log('id' in command && z.string().uuid().safeParse(command.id).success && document.browsers.some(value => value.id === command.id) ? command.id : null, 'error', command.command + '.failed', message);
          if (cause instanceof AggregateError) throw new AggregateError(cause.errors, `OCS ${command.command} 失败：${message}`, { cause });
          throw new Error(`OCS ${command.command} 失败：${message}`, { cause });
        }
        return snapshot();
      });
      // Every caller receives its rejection; the queue remains usable after an explicit failure.
      queue = operation.then(() => undefined, () => undefined);
      return operation.finally(() => { if (mutation) pending -= 1; });
    },
    async assertCanClose(): Promise<void> {
      if (pending > 0) throw new Error('OCS 配置或浏览器操作仍在处理中，请等待操作完成再退出或升级。');
    },
    async close(): Promise<void> {
      if (closed) return;
      closing = true;
      await queue;
      try {
        const results = await Promise.allSettled([runtime.stopAll(), pronunciation.close()]);
        const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason instanceof Error ? result.reason : new Error('OCS 受控资源未确认正常关闭。'));
        if (errors.length) throw new AggregateError(errors, 'OCS 浏览器或本机语音正常关闭未完成；失败所有权保留，未强杀进程。');
        closed = true;
        log(null, 'info', 'source.closed', 'OCS 浏览器与本机语音连接器已正常关闭；无公共辅助监听残留。');
      } catch (cause) { closing = false; throw cause; }
    }
  };
}
