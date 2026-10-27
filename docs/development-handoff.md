# 开发与仓库接手说明

**源码状态快照：2026-10-19；版本 `1.0.0-beta`，edition `academic`（含教务版）。** 本文件供朋友在另一台电脑定位实现、恢复可用开发范围、继续未完工作和准备仓库。它不是发布批准，也不承诺当前源码包可以原样完整重建。

先读 [README](../README.md)，再按本文件的阅读顺序进入代码。使用教程继续由 [DeepSeek 与兼容服务配置](deepseek-pi.md)、[Pi 诊断会话与辅助边界](pi-assistance.md)、[WorkBuddy 外部协作](workbuddy.md) 维护，本文件不重复教程。

## 1. 先明确交接的是什么

- 这是 **Bun 宿主 + React 同页界面 + 受控 Playwright/独立 Chrome + Python 乐跑引擎** 的 Windows 项目，不是 Docker 部署，也不是把 OCS Desktop/Electron 管理程序嵌入另一层窗口。主应用窗口/认证使用系统 Edge；OCS 使用显式独立 Chrome，两者不可混为一个浏览器依赖。
- 源码、锁文件、固定上游原文和现有许可声明是接手输入；`node_modules`、虚拟环境、Chrome 二进制、引擎输出、安装包、运行 profile、账号数据及维护者的 `work/` 原证据不是源码依赖包的一部分。
- **私有引擎输入缺口仍存在：** `vendor/lepao3/data/` 整个目录不随私下源码包提供；`engine/engine.spec` 仍收集该目录。未读取其内容，也不应向前任维护者索取真实轨迹来补齐构建。具体替代路线见第 8 节。
- **发布仍为 `TEST_ONLY / RELEASE_BLOCKED`。** `proxy-agent-negotiate@1.1.0` 适用许可全文缺失，且 Playwright 内联该代码。已有本机 `LOCAL_ONLY` 安装不解除许可门禁，不等于公开源码或二进制分发获准。
- 原工作站的外置项目记录和测试报告只用于本次事实核对；接手者不需要具有原机器的盘符、账号或外置 Log。本文只带历史验收摘要，**源码包不带完整原始报告、日志、截图和失败证据**。需要审计原结果时请另行取得脱敏证据，或在自己机器重建隔离验证。
- 本文件不记录新归档的文件数、大小或 ZIP 哈希；打包方须在文档完成后重新归档并逐项核验。不要把较早源码包说成已经包含本次详细交接。

### 建议的第一小时

1. 核对源码包的显式清单、版本、锁文件和许可材料；不要先启动程序或双击旧 EXE。
2. 阅读第 2、3 节，确认本轮要改的是哪个服务和哪条数据边界。
3. 按第 5 节恢复项目依赖，先做类型检查与有限核心测试；记录全部 skip 原因。
4. 将第 8 节的私有输入缺口、第 6 节的测试可携带性缺口列为 P0；不要通过复制账号目录、禁用门禁或改 manifest 让检查“变绿”。
5. 每次只选一个可验收任务，写清输入、授权、预期副作用与验收标准；最后保存自己机器的新结果，不继承本机历史通过状态。

## 2. 目录、职责与建议阅读顺序

除 Markdown 链接外，下表路径均相对仓库根目录。函数名是导航入口，不代表文件只有该职责。

| 顺序 / 路径 | 关键符号或入口 | 接手时要理解的职责 |
| --- | --- | --- |
| 1. `package.json`、`bun.lock`、`requirements.in`、`requirements.lock` | scripts、dependencies、engines | 版本/edition、ESM、有限测试命令与两套依赖解析；锁文件不等于解释器版本锁。 |
| 2. `desktop/shared/contracts.ts`、`validation.ts`、`edition.ts` | 状态/桥接契约、schema、`releaseEdition` | 查寝状态、设置、返回值和版本能力边界；先确认字段再改 UI。 |
| 2. `desktop/shared/{pi,models,ocs,ocs-login,ocs-config,lepao,academic}.ts` | `piServiceCommandSchema`、`ocsCommandSchema` 等 | 模块命令、状态 DTO、模型私有/公开数据区别、登录策略和配置字段目录。 |
| 3. `desktop/bun/launch.ts` | 启动分支、`--shutdown`、`--uninstall` | 正常启动进入 `index.ts`；控制命令走 `control.ts`，卸载还关闭自启动。 |
| 3. `desktop/bun/index.ts`、`instance.ts`、`control.ts` | 服务装配、`shutdown`、实例管道 | 单实例所有权、回环 HTTP、会话鉴权、API 路由、SSE、托盘、业务忙碌退出门禁。 |
| 4. `desktop/renderer/main.tsx`、`App.tsx`、`bridge.ts` | `request<T>`、`window.desktop` / `window.pi` / `window.ocs` 等 | React 页面入口和 typed bridge；桥接验证返回 schema，不直接调用文件系统/模型密钥。 |
| 5. `desktop/bun/application.ts`、`scheduler.ts` | `createApplication`、`synchronize`、`planSchedule`、`isScheduleDue` | 查寝会话、任务调度、提交防重、回查、记住登录、持久状态及互斥。 |
| 5. `desktop/core/{api,workflow,submissions,schedule-policy,time,errors}.ts` | `syncTasks`、`runCheckin`、`readSubmissionConfirmation`、`claimSubmission` | 学校接口与业务规则；发起提交和确认学校结果必须区分，不能让重试产生重复提交。 |
| 5. `desktop/bun/{auth,auth-http,login-memory,captcha-ocr,store,native}.ts` | 认证、DPAPI、OCR、状态存储、原生接口 | Windows 专属能力和外部副作用边界；不是可移植账号导出接口。 |
| 6. `desktop/bun/lepao.ts` → `engine/bridge.py` | `createLepaoService`；`dispatch`、`run_action`、`main` | 按请求 ID 的有界 JSON-lines 子进程通信；操作保留、停止、代理恢复与结果状态。 |
| 6. `engine/lifecycle.py`、`results.py`、`captcha_ocr.py`、`mitm_entry.py` | 数据生命周期、提交摘要、OCR、代理入口 | Python 引擎外围适配；`engine.spec` 生成三个 EXE，不能只复制主引擎 EXE。 |
| 6. `vendor/lepao3/ui/run_core.py`、`vendor/lepao3/lepao/` | `resolve_data_dir`、`action_capture` / `action_full` / `action_dry`；`track.py` | 已署名上游业务及模板依赖。阅读代码，不打开被排除的 data 内容。 |
| 7. `desktop/bun/academic.ts`、`academic-browser.ts`、`academic-login.ts`、`academic-portal.ts`、`academic-transport.ts` | `createAcademicService`、`openAcademicBrowser`、`authenticateAcademicSession` | 同账号学校 SSO、教务身份核验和只读查询；`core/academic-data.ts` 映射数据，`CampusServices.tsx` 展示。 |
| 8. `desktop/bun/ocs.ts`、`ocs-document.ts`、`ocs-storage.ts` | `createOcsService`、内部 `save` / `snapshot`、`createOcsRepository` | 串行命令、独立 DPAPI 配置、capability 状态、成功持久保存后递增 `configurationRevision`、目录所有权。 |
| 8. `desktop/bun/ocs-browser.ts`、`ocs-lifecycle.ts` | `createOcsBrowserRuntime`、`own`、`stopOwned`、`releaseSettledOwner` | Playwright context 的强引用/所有权；关闭事件、断连和 GM 收尾分开结算。历史自退调查主要入口。 |
| 8. `desktop/bun/ocs-assets.ts`、`ocs-download.ts` | `parseUserScript`、`importScript`、`loadScript`、`importExtension`、`downloadScript` | 脚本声明/摘要、MV3 导入、下载 URL/DNS/文件安全；不支持的声明不得冒充支持。 |
| 8. `desktop/ocs/userscripts.ts`、`gm-runtime.ts`、`gm-world.ts`、`gm-types.ts` | `attachUserScripts`、`attachGmScripts`、`supportedGmGrants` | grant-none 与隔离 GM 路径、页面/脚本授权、GM API、flush/dispose/isSettled。 |
| 8. `desktop/ocs/gm-network.ts`、`gm-network-world.ts` | `gmRequestSchema`、`connectHost`、`requestGmNetwork` | 网络参数与脚本世界桥接、精确公开主机、固定连接地址、撤权/取消和请求上限。 |
| 8. `desktop/bun/ocs-script-resources.ts`、`ocs-script-asset-types.d.ts` | `resolveScriptResources`、固定 CSS 文本导入声明 | 有界同步资源、固定 CSS 摘要；声明文件参与 TypeScript，不能因看似非业务代码而漏打包。 |
| 8. `desktop/bun/ocs-config-sync.ts`、`ocs-gm-storage.ts`、`ocs-privacy.ts` | `convertOcsConfigToGmValues`、`applyOcsConfigSync`、`revokeOcsConfigSync`、`publicConfig` | 精确脚本授权、覆盖前值 journal、撤销恢复和私有配置不出 DTO。 |
| 8. `desktop/bun/ocs-automation.ts`、`ocs-login-runner.ts`；`desktop/ocs/automation-policy.ts`、`login-submission-policy.ts` | `runOcsLogin` 及表单策略 | 启动导航与显式单次登录分离；固定来源、原生表单和有效提交目标复核。 |
| 9. `desktop/bun/models.ts`、`pi-provider.ts`；`desktop/core/pi-runtime-model.ts` | `createModelService`、`createPiProvider`、`piProviderFetch` | 项目私有模型配置、官方 SDK 适配、限制凭据发送目标；不加载其他应用凭据。 |
| 9. `desktop/bun/pi-service.ts`、`pi-ocs-tools.ts`、`pi-ocs-approval.ts` | `createPiService`、`createPiOcsTools`、`createPiOcsApprovalGate` | 会话 epoch、工具预算、finishTurn、逐次宿主审批与最小工具结果。 |
| 9. `desktop/renderer/Models.tsx`、`PiChat.tsx`、`PiAssistance.tsx` | 模型配置、会话和审批界面 | 对话发送、工具结果继续发送、浏览器动作审批是不同确认。 |
| 9. `desktop/renderer/Ocs*.tsx` | BrowserManager、ConfigForm、Resources、Settings、Logs、Controller | OCS 同页 UI、授权/草稿/保存状态、能力禁用说明；不要恢复旧 Electron 管理窗。 |
| 10. `scripts/`、`installer/setup.iss`、`tests/` | 第 6、7 节列出的入口 | 验证、资源固定、许可 preflight、编译、安装；测试文件不全是离线单元测试。 |
| 来源层 `upstreams.json`、`vendor/ocs/`、`licenses/` | 固定提交、source manifest、许可/NOTICE | 上游原文基线和适配层分离；完整源码纳入不等于完整功能运行。 |

### 2.1 主调用链

```text
launch.ts
  -> index.ts: single-instance ownership + local session + service composition
  -> React App -> renderer/bridge.ts -> POST /api/<module>
  -> shared schema -> module service -> runtime/external boundary
  -> validated public state -> renderer

PiChat -> window.pi -> /api/pi -> createPiService
  -> createPiProvider -> official Pi Agent SDK
  -> optional ocs_browser_action -> host approvalId
  -> recheck epoch/revision/profile/ownership -> OCS service -> Playwright Chrome

Ocs UI -> window.ocs -> /api/ocs -> createOcsService
  -> repository / script assets / config sync -> createOcsBrowserRuntime
  -> attachUserScripts -> isolated GM world -> bounded storage/network/resources

Lepao UI -> /api/lepao -> createLepaoService
  -> lepao-engine.exe stdin/stdout JSON-lines -> engine/bridge.py -> attributed upstream
```

`index.ts` 仅绑定 `127.0.0.1` 随机端口。启动 key 换取 HttpOnly / SameSite=Strict 本机会话；写接口同时检查 Host、Origin、POST、`X-SWU-Request: 1` 和 JSON Content-Type。正文上限：OCS 2 MiB、Pi 64 KiB、其他 16 KiB，同时检查声明长度与实际字节数。这个回环 API 不是可公开部署的服务，不应改为监听全网来图方便。

### 2.2 schema 不是可删除的“重复校验”

- UI TypeScript 类型不能代替运行时验证。HTTP 解码先视为未可信数据，再由 shared schema 收窄；bridge 对返回值再次解析。Python stdout 也由 `lepao.ts` 的事件 union 校验。
- Pi 命令用 strict Zod object，审批单独要求 `approvalId` UUID；不得接受模型自带 `confirmed` 作为动作批准，也不能把 `toolCallId` 当批准凭据。
- Pi 工具使用直接依赖 **`typebox@1.3.27`** 的 `Type.Object(..., { additionalProperties: false })`；`validateToolCall` 用 `Value.Check` 再验参数、UUID、toolCallId 长度及 AbortSignal。SDK 声明是 `AgentTool<TSchema, TDetails>`，执行参数来自 `Static<TSchema>`，不是接受任意字典的接口。
- 策略/命令边界拒绝未知动作和额外字段；外部响应中无关额外字段按各自 schema 处理，不把所有 `.object()` 都描述成 strict。维护时保持现有边界差异，不能统一换成强制断言来“消除类型报错”。

## 3. 当前能力：实现了什么，不能据此宣称什么

### 3.1 Pi 默认无工具；显式启用才有两项 OCS 工具

根 `package.json` 和 `bun.lock` 均固定 `@earendil-works/pi-agent-core` / `@earendil-works/pi-ai` **1.3.0**，不是独立 coding-agent CLI。恢复依赖后可实读这两个包的 `dist/types.d.ts`、`agent-loop.js` 等，不猜新版 SDK 的接口。

| 边界 | 当前实现 |
| --- | --- |
| 默认 | `diagnose`，`tools=[]`，仅分析本人明确提供的脱敏文本；准备会话不发模型请求。 |
| 显式启用 | start 必须传 `ocsToolsEnabled`；启用时所选 provider 必须 `tools=true` 且宿主提供 OCS service，否则明确拒绝，不降级。 |
| 工具面 | 仅 `ocs_overview` 与 `ocs_browser_action`；动作只允许已保存 browser UUID 的 start / stop / focus。 |
| 最小输出 | 概览为 integration/phase、browser ID/phase、capability ID/available；动作结果为 browser ID/phase 和可用 capability ID。无标题、URL、路径、配置、日志、截图、自动化参数或凭据。 |
| 逐次动作批准 | gate 随机生成宿主 UUID `approvalId`，绑定 session epoch、toolCallId、目标和动作，最多等待 **120 秒**，同时只允许一个待批请求，一次结算即失效。 |
| 审批后复核 | 再读状态并核对精确资料、`configurationRevision`、ownership、phase 和 busy；目标变化、配置成功保存、停止/取消、超时、跨会话、重复点击均不得复用旧批准。 |
| revision | `ocs.ts` 内部 `save` 在 durable save 成功后递增；私有配置即使在公开 DTO 中被遮蔽，变更也会使旧审批失效。不能只比较公开设置文字。 |
| 三种同意 | ①对话发给所选服务商、可能计费；②OCS 模式最小工具结果可继续发给服务商；③本次具体浏览器动作。②不等于③。 |
| 预算与续发 | 每提示词宿主最多接受 **3 次 AgentTool 调用**；`finishTurn` 仅在独立同意、已有工具结果且尚未续发时返回一次 continue。**不是固定的 provider HTTP 请求总数承诺。** |
| 取消与错误 | 不自动重试；停止取消 pending approval、abort 并等待 SDK 空闲，不强杀浏览器。客户端取消不保证服务商取消或免计费，`costKnown=false`。 |
| 保密与生命周期 | 会话仅内存保存；Key/自定义 headers 由本项目 Windows CurrentUser DPAPI 保存。SDK 使用内存凭据容器，ambient env/file 查找不可用。 |

`piProviderFetch` 限制带凭据请求到所选 origin 和协议消息 endpoint，拒绝重定向。五种配置协议仍可保存，但当前 **Gemini 原生会话明确拒绝启动**，不能把“配置被保存”说成“协议连通通过”。推荐国产服务不等于限制厂商；WorkBuddy 是可选外部软件，不是第六协议或集成远控；W.O.F NAI Studio 仅为历史代码参考，署名保留于 licenses。

**Pi 没有**登录、页面导航/读取、截图、JS、shell、文件、配置编辑、课程、答题或学校提交工具。直接调用生产工具函数并观察 Chrome 效果，是工具层真实集成，不是“真实模型选择工具→弹审批→执行→结果回模型”的闭环证据。

### 3.2 OCS 是受控子集，不是完整 OCSJS

固定 OCS Desktop v2.12.0 的 162 文件原文位于 `vendor/ocs/source`。当前宿主直接持有 Playwright context；不启动 `OCS Desktop.exe`，不加载 Electron 管理应用，不监听旧 15319 辅助端口，也不读取旧 Electron 密文。

| 已实现 | 限制 / 不支持 |
| --- | --- |
| 浏览器资料 CRUD、多 profile 启停/聚焦、独立 DPAPI 设置与日志 | 浏览器运行不代表登录、课程执行或完成。OCS 没有系统 Edge 回退。 |
| 按需 PNG 页面预览 | 不是实时视频；可能含账号内容，只用于本机显示，不进入 Pi 工具结果。 |
| 源码导入/HTTPS 下载、页面匹配与排除、MV3 普通目录导入 | 禁止联接/链接越界；声明未适配能力的脚本仍不能运行。 |
| 基础信息/存储/监听/Tab/样式 11 grants | `GM_info`、`GM_getValue`、`GM_setValue`、`GM_deleteValue`、`GM_listValues`、`GM_addValueChangeListener`、`GM_removeValueChangeListener`、`GM_getTab`、`GM_saveTab`、`GM_getTabs`、`GM_addStyle`。写入 Promise 和持久完成语义不能改成假同步成功。 |
| 网络 2 种声明 | `GM_xmlhttpRequest` / `GM.xmlHttpRequest`，是同一有界网络子集的别名。 |
| 资源 2 项 API | `GM_getResourceText` / `GM_getResourceURL`；合计 **11 + 2 + 2 = 15 grants**，不意味着完整 GM。 |
| 通用启动导航 | 复用固定上游 `NewPageScript`；保存平台参数或启动浏览器不会自动登录。 |
| 配置定向同步子集 | 23 个已支持平面非敏感标量和私有 `common.settings.answererWrappers`；不是通用任意配置透传。 |
| 两种单次登录子集 | 超星手机密码、智慧职教账号密码；其余四种定义禁用。真实平台布局与账号兼容性未验收。 |
| 清华社旧版课程辅助（实验性、待真实增量验收） | 复用同一 OCS Chrome；主界面独立展示课程、题目、媒体及平台结果，停止不排在普通命令之后。脚本安装、启用、真实提交各自确认；课程导航和题级判分仍需当前官网验证。 |
| 本机英语发音练习 | Windows System.Speech 本机语音，显式检测并选择已启用的英文音色；不依赖浏览器语音，不录音、不保存文本、不提交课程或导出音频。 |

**清华社使用边界：**「用户脚本」中的安装入口在确认后下载 [TSH自动刷课](https://github.com/WASD258-jpg/tsh-auto-brush) 固定版本，版本、提交和 SHA-256 以 `desktop/shared/ocs-external.ts` 为唯一配置来源。后端核验原文摘要，初次导入默认禁用，同摘要不重复安装；从通用下载或本地导入同一固定源码也适用。用户审阅风险后可在既有列表启用，私有配置同步不自动授权。固定外部 GPL-3.0-only 原文不内置、不写回或自动更新；旧版执行副本仅在内存中通过唯一锚点受控适配，分别记录适配版本、原文和执行摘要，适配失败明确拒绝，不回退原引擎。运行时组合的发行许可尚未解除；仅限获准的 `LOCAL_ONLY / TEST_ONLY / RELEASE_BLOCKED` 本机包。

旧版登录页提供显式的“滑块验证并登录（一次）”按钮（命令 `tsinghua-verify-slider`、测试 ID `ocs-tsinghua-slider-once` 保持不变），仅在受控浏览器运行、等待登录且非 busy 时显示。仅限本人当前受控 HTTPS `/legacy/login`：复用原生鼠标按官网实际轨道宽度拖动一次，核对可见验证成功标志后，使用页面现有填写内容单次点击官网 `.login-btn`。不读取或填写账号密码、不读取 Cookie、不刷新挑战、不自动重试；失败明确提示交由本人处理，不回退其他登录方式。等待离开登录页且登录控件消失后才确认登录，再自动发现并导航课程；点击按钮或滑块通过均不是登录成功证据。登录确认与课程身份绑定、导航分别判断，后续课程发现或导航失败不能称为登录失败。该操作不授权或提交题目，普通题仍须独立确认，停止纳入现有取消结算。开发验证须持续复用同一个已登录受控浏览器；步骤失败只停止课程动作和朗读，不自动关闭会话、刷新挑战或重新登录。会话不存在或官网明确要求登录时停止并告知本人，不自动创建替代会话。单次滑块、登录确认与自动课程导航已在隔离真实产品路径验证通过（`14725355-9ed3-4f4e-8e93-80f97500c235`，2026-10-27）；该轮未提交题目或录音，后续样本定位的翻页就绪失败不影响此项登录证据，也不表示现用安装已更新。

旧版不启动上游浮层、原自动循环或刷时长任务；主界面控制导航与停止，SPA 跳转后不依赖旧浮层重建。普通题复用平台明确答案的识别、映射与填答；文本填空的明确开放标记（如 Answers will vary、答案略）独立处理为确定性非空内容，不再当作缺失客观答案一律拒绝。开放标记仅用于已审查文本路径，不适用于缺答案的选择、判断等题。非空提交门禁或平台接受不等于答对；不随机首答、不隐式调用云模型、不自动 Retry。没有完整客观答案、字段数量不匹配或没有官方判分证据时明确停下并显示未验证，不能称所有新题均能自动作答。媒体不静音、不加速、不跳结尾；语音题等待本人在官网录音，软件不点击录音、停止录音或提交录音。HTTP 状态、平台接受、题级正确率、综合成绩和学习进度分开显示；综合成绩不是当前口语题评分。当前新增实现仍待真实增量验收，不代表现用安装已更新或全课完成。

本机发音辅助通过固定 Windows PowerShell 5.1 与 System.Speech 连接器，仅列出系统已启用的英文音色；用户明确载入原文或手输文本、选择音色及整数语速后，文本只通过 stdin 交给本机合成器，不写入配置、日志或音频文件。超过 2000 字符明确拒绝整体载入，不静默截断。一次仅持有一个朗读进程，停止等待真实清理退出，收起朗读区、离开 OCS 页面或正常退出会请求取消；仅切换 OCS 标签不会卸载朗读区，须主动停止。无可用声音时明确不可用，不回退浏览器、其他语言或云端。完成事件不证明本人已听见声音，录音前须停止朗读并确认声音停止。上游设置中的 AI Key / GitHub Token 为页面明文，不得提供宿主密钥；本适配不启用其 AI 或失效上报链路。

仍不支持 `@require`、`unsafeWindow`、`GM_notification`、本机 `@connect`、完整 OCSJS、完整脚本辅助动作、OCS 图片/滑块 OCR、实时视频、其他平台课程执行或全课完成保证。`forceUpdateScripts` 只保存偏好，不意味着脚本管理器安装/更新成功。capability 中 `gm-runtime`、`ocr`、`live-video` 仍为 false；`course-results` 仅表示清华社旧版实验性辅助入口可用，不代表题级判分或课程已验收。

### 3.3 网络、资源、同步和关闭的安全不变量

**网络：** `gmRequestSchema` 只接受 GET/HEAD/POST、text/json 及有界参数。`@connect` 必须逐个精确小写公开 DNS 主机，不接受通配、自身、IP 或隐式子域；请求只走 HTTPS，DNS 地址经验证后固定连接，证书仍按目标主机核验。每跳重查授权/公开地址，最多 5 次重定向；POST 遇重定向明确失败，不重放可能已发生的副作用。没有浏览器 Cookie 自动附带，拒绝 Cookie、Host、代理/路由/分帧等危险请求头；调用者显式 headers 也受限制，不能把它泛称为“绝不可能携带任何秘密”。跨 origin 重定向不得携带自定义秘密头。当前单请求最多 20 秒、POST 正文 32 KiB、响应 1 MiB；上下文并发也受 runtime 限制，不是任意代理。

**资源：** 固定 commit 的内置 OCSJS CSS 是编译时文本，不在运行时访问它看起来像 HTTPS 的来源 URL；另一类仅 canonical base64、严格 UTF-8 的 `text/plain` / `text/css` / `application/json` data URL。最多 16 项、每项 64 KiB、每脚本总 256 KiB。不读网络/文件、不 eval 资源；资源授权绑定脚本摘要和原文档，撤权后不能通过保存的 API 引用恢复。CSS 导入摘要校验与固定来源 manifest 都要保留。

**同步：** 总开关、脚本启用、UUID 与源码 SHA-256 独立授权必须同时成立，在脚本附加前写入该 profile/脚本/摘要隔离 GM 存储。只拷贝存在且支持的键，不填默认值、不展开未知嵌套键、不注入公开占位符。修改设置/授权前先停全部持有浏览器。journal 的顺序是记录 pending ownership → 保存 GM 值 → 将 ownership 收缩到本次实际同步键；撤销时恢复覆盖前原值、删除注入键并保留其他数据。已被脚本读到的秘密无法召回。`answererWrappers` 整棵私有子树不出公开 DTO/高级 JSON DOM。

**登录：** 每次单独确认至多一次点击；固定 HTTPS 文档来源、原生 form、有效 action/submitter 等在填表和点击前复核。不自动勾协议、重试密码、代答验证码或绕过 MFA。结果明确 `loginVerified=false`、`requiresManualVerification=true`，本地测试成功不等于真实学校已登录。

**关闭：** `ocs-browser.ts` 保留 owned context，直到真实 context close / browser disconnect 与已接受 GM 工作结算分别得到确认。等待超时不是取消成功；未确认仍持有，禁止重启/删资料。GM dispose 报错也不能跳过底层正常关闭。历史浏览器自行退出根因仍未知，不用 keepalive、自动重启、强杀或短时间未复现来销项。

### 3.4 查寝、乐跑、教务的接手底线

查寝按账号/任务日期/任务 ID 防重，提交前声明意图，未知结果只做有限只读回查；不要把失败提示解读为可以重发。查寝、乐跑和教务相关操作存在宿主互斥。乐跑成员/会话独立，代理/证书操作有单独授权和恢复边界；不属于普通 UI 冒烟测试。教务仅课表/成绩/考试只读，同账号身份复核后才展示，结果在内存，旧结果保留读取时间，不当实时数据。

学校、平台与模型的真实验证均须独立授权，明确账号归属、外部副作用及预算。历史真实查寝/乐跑成功不保证新机器或新平台版本兼容；本次 Pi→OCS 技术测试没有新增学校/课程成功证明。

## 4. 固定来源与许可证：先保留，再核实

| 材料 | 当前固定依据 / 处理要求 |
| --- | --- |
| `upstreams.json` | swu-daka 基于 2.4.2 / commit `42d8973559841f75d98f019c9a8c97204c680d4c`；lepao3 commit `78357e4a5f05147c34b199869ee04379734260c9`。 |
| 根 `LICENSE`、`NOTICE`、`DISCLAIMER.md` | LRL-1.0 非商业授权、出处和免责声明；保留原文和要求的源码版权头/构建戳。NOTICE 使用 Apache 风格不等于项目整体按 Apache-2.0 授权。 |
| `licenses/swu-daka/LICENSE` | 原查寝协议与免责声明另行保留。 |
| `vendor/ocs/upstream.json`、`source-manifest.json` | Desktop v2.12.0 / commit `7e29272a3bdab0c84cb30ebc5935f1c3758ac52b`、来源归档与 162 文件逐项摘要。 |
| `vendor/ocs/ocsjs-source-manifest.json`、`ocsjs-5.2.1/` | OCSJS 5.2.1 / commit `8b25a3f44523a0d4b7373878488056f4aa478cf6` 的 125 文件来源；当前完整 runtime 未启用。 |
| `vendor/ocs/userscript-source-manifest.json`、`userscript-source/` | 同固定 OCSJS 的另一份 125 文件原文基线，供选择性移植；不是可随手去重/再生成的缓存。 |
| `licenses/ocs/NOTICE.md`、OCSJS 许可/来源、`licenses/ocs/browser.json` | 各组件声明和缺口分别核实，Chrome 固定版本为 137.0.7151.55 且核对完整目录哈希，不是任意新版 chrome.exe。 |
| `licenses/npm-source/`、`scripts/npm-notices.ts` | 精确版本上游许可证据、包元数据摘要、物理实例分别追踪；不可只拿包名或 SPDX 字符串代替适用全文。 |
| `licenses/WOF_NAI_Studio/` | 历史参考的来源和许可保留；不接触其账户/Key。 |

不要修改固定上游字节后重新生成 manifest 使校验通过；不要删除版权头。`prepare-ocs-source.ts` 在 manifest 缺失时有创建分支，因此日常核验前必须确认原 manifest 存在；缺失时恢复交付中的审定原件，不以运行脚本重建作为接受新内容的方式。来源记录内既有原工作站路径只是历史证据元数据，不是另一台电脑必须建立的路径；不要为了清理路径而擅自重写固定材料。

`proxy-agent-negotiate@1.1.0` 尚缺适用许可全文；此前 collector 的 90 个物理实例中 89 个有证据不代表最后一个可忽略。Playwright 内联意味着“应用没有直接 import 这个包”不足以排除它。应取得精确版本可验证全文/授权，或另行评估真正移除该代码的兼容依赖变更，并重做依赖、内联和分发审查；不能伪造文本、豁免检查或悄悄删依赖。

## 5. 跨电脑恢复：先恢复开发，不把它等同于完整重建

### 5.1 环境依据

使用 Windows 10/11 x64 和 **PowerShell 7 (`pwsh.exe`)**。系统 Edge 供主 UI/学校窗口与若干桌面测试使用；OCS Chrome 由开发者独立取得、核实来源/许可和固定摘要。不要全局设置某个项目的 VIRTUAL_ENV/PYTHONPATH，不导入原工作站账号环境。

| 项目 | 已核实事实 | 不能推断的内容 |
| --- | --- | --- |
| Bun | 根 engines 为 `>=1.4.2`；前次本机开发记录为 1.4.3。 | 没有固定 Bun 补丁版本；不能把任意更高版当已验收。 |
| TypeScript / React / Playwright | 根声明分别为 5.9.3 / 19.3.0 / 1.63.0；依赖解析用 `bun.lock`。 | 不能只升级其中一个后继承旧结果。 |
| Node | 根 package 没有 Node engines；已安装两份 Pi 1.3.0 包均声明 `node >=22.19.0`。 | `@types/node@26.6.3` 是类型包，不是本机运行版本；未锁定项目 Node 实际版本。核对运行 Playwright CLI 等脚本实际使用的解释器。 |
| Python | 前次本机开发环境 3.12.8；`requirements.lock` 固定包但不固定 Python 解释器。 | 根 NOTICE 写 Python 3.11，且其描述含原上游 GUI/运行时信息；与当前开发环境和新引擎是否兼容尚未消解。不能擅改原 NOTICE 来掩盖差异。 |
| uv | 前次本机记录为 0.11.16。 | 这不是项目版本锁，也不代表必须全局安装。 |
| Inno Setup | 构建脚本要求已有 6.5+ 编译器；前次本机 LOCAL_ONLY 安装使用 6.7.3。 | 安装器编译成功不等于公开发布许可通过。 |

下列命令供接手者在自己的已核实项目目录、工具环境和授权范围内运行；本轮文档维护没有执行安装、测试、编译或外部调用。

### 5.2 依赖恢复与第一轮检查

在**仓库根目录**的项目专属环境执行：

```powershell
bun install --frozen-lockfile
uv venv .venv --python 3.12.8
uv pip sync requirements.lock --python .venv/Scripts/python.exe
bun run typecheck
bun run test
```

Python 命令仅复原观测到的 3.12.8 开发环境；不证明随包引擎运行时已验证。若只先做 TS 开发，不必为运行类型检查先补私有轨迹或构建引擎。冻结安装失败应报告具体依赖/平台原因，不删除锁文件重新解析。依赖恢复可能联网，应由接手者确认；禁止以手工临时装包替代项目依赖声明。

**严禁裸 `bun test`。** `bun run test` 是明确七文件集合：`core`、`scheduler`、`native`、`service`、`submissions`、`notifications`、`modules`。它仍包含 Windows 原生/DPAPI 等集成，且 `SWU_TEST_LOCATION=1` 会启用真实定位、`SWU_LEPAO_ENGINE` 会启用真实引擎项；运行前检查继承变量，仅保留本轮确实授权的项。不要因核心名称就声称完全无系统交互。

可按本轮范围追加显式检查，不要一口气运行全部测试目录：

```powershell
bun test ./tests/pi-runtime.test.ts
bun test ./tests/ocs-config.test.ts ./tests/ocs-private-wrapper.test.ts
bun test ./tests/ocsjs-source.test.ts
bun test ./tests/npm-notices.test.ts ./tests/npm-build-preflight.test.ts
bun run test:ocs
```

这些检查各有 Windows/TEMP/依赖前置；`test:ocs` 等价 `bun test ./tests/ocs-integration.test.ts`，设置浏览器变量后会启用真实 Chrome 分支，其编译烟测也会生成临时 EXE。许可负向测试证明缺口会被拒绝，**通过不意味着正式许可已齐备**。

需要人工开发 UI 时，先为 `SWU_USER_DATA_DIR` 指定自己新建且核实为空的项目隔离目录，再执行 `bun run dev`（`start` 与 `dev` 都指向 `desktop/bun/launch.ts`）。它会启动真实宿主/托盘和主窗口，不是纯静态预览；不要在未设隔离目录时执行。OCS、乐跑和 OCR 资源分别按下表配置，缺失时准确保留 unavailable/报错，不回退日常安装数据。仅检查页面不授权点击登录、采集、证书、提交或模型发送；结束后从应用正常退出。

### 5.3 环境变量按作用域配置

在独立 PS7 会话中只给当前进程/子进程设置变量；不要改用户或机器全局环境。路径须自行核实存在、用途、普通目录/文件性质及不与用户数据重叠。本文不提供原工作站的绝对资源路径让你照抄。

| 变量 | 实际读取者 / 用途 | 配置注意 |
| --- | --- | --- |
| `TEMP` / `TMP` | Bun/Node/Python 与多项测试的临时位置 | 选已核实项目临时根；不少测试强制依赖 TEMP，不能误指账号或源码根。 |
| `SWU_USER_DATA_DIR` | `index.ts` / control 的用户数据根覆盖 | 不设时走当前用户 APPDATA 下 `swu-daka-desktop`；开发必须隔离，防止读到日常账号。桌面测试通常自行给子进程覆盖为唯一 work 目录。 |
| `SWU_OCS_BROWSER` | `ocs.ts` 运行时独立 Chrome EXE；多项真实 Chrome 测试 | 要求绝对路径；不是目录，不回退系统 Edge。部分测试目前有硬编码，见第 6 节。 |
| `SWU_OCS_BROWSER_DIST` | `ocsBrowserDirectory` / build 资源输入 | 完整 Chrome 目录，内含 chrome.exe/dll/pak 等；按 `licenses/ocs/browser.json` 固定摘要校验。 |
| `SWU_OCS_DIST` | 旧资源读取兼容入口 | 仅读取其 `resources/bin/chrome/chrome`；不复制 Electron/OCS 管理应用，不恢复旧 `prepare-ocs.ts` 流程。 |
| `SWU_PYTHON` | `build-engine.ts` | 已核实的项目 Python EXE；用它运行 PyInstaller 和导出 Python notices。图标入口 `icons.mjs` 另调 PS7 的 `compile-icons.ps1`，不读取此变量。 |
| `SWU_ENGINE_BUILD` | `build-engine.ts` | PyInstaller workpath，专用可再生临时目录。 |
| `SWU_ENGINE_DIST` | `build-engine.ts` 输出 / `build.ts` 输入 | 应指向生成的 `lepao-engine` 集合目录；脚本将它的父目录传为 distpath，spec 的 COLLECT 名为 lepao-engine。不是源码目录。 |
| `SWU_LEPAO_ENGINE` | `lepao.ts`、core 中真实 engine 测试 | 开发覆盖到已核实 `lepao-engine.exe`；是可执行文件，不是 Python 解释器或 bridge.py。 |
| `SWU_CAPTCHA_OCR` | `application.ts` 等认证路径 | 覆盖 `captcha-ocr.exe` 路径；只解决可执行资源定位，不授权调用学校登录。 |
| `SWU_BUILD_OUTPUT` | `build.ts` / build-metadata / installer | 主 EXE、engine、modules、licenses 输出；不设默认 releases，但实际应选新的专用源码外目录，不能指正式安装/预览。 |
| `SWU_INNO_COMPILER` | `build-installer.ts` | 已安装且核实版本的 ISCC.exe；不是安装目标目录。 |
| `SWU_TEST_EXE` | `tests/desktop/application.spec.ts` | 已独立编译并审核的 TEST_ONLY 主宿主 EXE；默认 releases 不能当作安全隔离保证。 |
| `SWU_OTHER_EDITION_EXE` | 桌面跨版本项 | 独立 Alpha EXE，测试 edition 互斥；未提供则跳过，不能据此宣称 Alpha 已验收。 |
| `SWU_PI_OCS_APPROVAL_EVIDENCE` | Pi→OCS 工具/UI 测试 | 本次新证据输出根，不是凭据来源，不修复测试中的 Chrome 硬编码。 |
| `SWU_OCS_SMOKE_DIRECTORY` | `desktop/ocs/compiled-smoke.ts` | 必须为 TEMP 内独立绝对路径，编译烟测使用；集成测试负责设置时不要改到日常数据。 |
| `SWU_BUILD_OUTPUT_CHECK` | prepare 脚本派生给 PS7 子进程 | 内部输出路径验证参数，通常不由开发者手工配置。 |

可选真实集成开关必须逐项读测试，不要将它们全部设为 1：

| 开关 / 配套路径 | 对应测试与真实用途 |
| --- | --- |
| `SWU_OCS_RUNTIME_GM_TEST=1` + `SWU_OCS_BROWSER` | `ocs-runtime-gm.test.ts`、`ocs-gm-extensions.test.ts`：真实隔离 Chrome/GM 生命周期、监听/Tab/样式。 |
| `SWU_OCS_CONFIG_SYNC_BROWSER`、`SWU_OCS_CONFIG_SYNC_WORK` | `ocs-config-sync.test.ts`：前者指定 Chrome 并启用浏览器分支；后者为专用工作根。不是 `SWU_OCS_BROWSER` 的同义名。 |
| `SWU_OCS_RESOURCE_TEST=1`、`SWU_OCS_RESOURCE_WORK` | `ocs-resources.test.ts`：真实 Chrome 资源分支和证据根；另需 SWU_OCS_BROWSER。 |
| `SWU_OCS_GM_NETWORK_TEST=1`、`SWU_OCS_NETWORK_WORK` | `ocs-gm-network.test.ts`：公网无凭据 GET/HEAD 和在途取消，需单独允许外网；另需 SWU_OCS_BROWSER。 |
| `SWU_OCS_GM_NETWORK_POST_TEST=1` | 同文件的独立公网 POST 项，可能有服务端副作用，不能随只读授权启用。 |
| `SWU_OCS_AUTOMATION_TEST=1` | `ocs-automation.test.ts`：实际浏览器自动化集成分支，先读当前目标页面与行为。 |
| `SWU_OCS_LOGIN_BOUNDARY_TEST=1`、`SWU_OCS_LOGIN_EVIDENCE` | `ocs-automation-login-boundary.test.ts`：本地真实 Chrome 表单安全边界及证据目录；不是学校账号登录验收。 |
| `SWU_OCS_UI_EVIDENCE` + `SWU_OCS_BROWSER` | `ocs-host-ui.test.ts`：源码宿主 UI 与隔离浏览器证据，缺少参数会明确失败。 |
| `SWU_OCS_GM_INVESTIGATION=1`、`SWU_OCS_GM_DIRECTORY` | `ocs-gm-storage.test.ts` 的显式调查分支；不是普通存储测试必填。 |
| `SWU_OCS_LIFECYCLE_INVESTIGATION=1`、`SWU_OCS_LIFECYCLE_DURATION_MS` | 生命周期长时调查，相关 test/desktop spec 要分别阅读；不是运行一次绿灯就定位自退根因。 |
| `SWU_OCS_LIFECYCLE_OPTIONS`、`SWU_OCS_LIFECYCLE_DIRECTORY`、`SWU_OCS_LIFECYCLE_PARENT_STDIO`、`SWU_OCS_NATIVE_OPTIONS` | observation 子进程的严格 JSON 参数、隔离路径/诊断元数据，按调用方生成，不猜字段或手填未知模式。 |
| `SWU_TEST_SESSION_SOURCE`、`SWU_ACADEMIC_LIVE_DATA` | 桌面真实会话/教务数据输入，**不是常规 fixture**，默认不提供。 |
| `SWU_READONLY_SESSION_SOURCE`、`SWU_READONLY_EVIDENCE` | `tests/readonly-session.ts` 会读取授权的学校会话并请求学校；只读也需要授权。 |
| `SWU_TEST_LOCATION=1` | 原生定位项，涉及真实位置，普通恢复不启用。 |

`NODE_OPTIONS` / `NODE_EXTRA_CA_CERTS` 是可能继承的运行环境，不是项目要求你修改的 TLS 修复开关；历史联网测试继承过它们，只记录变量名而不携带值。不能复制原机器代理/CA、禁用证书检查或把“已有环境可达”写成干净系统信任已验收。Pi Key 从本项目私有配置读取，不用环境 API Key 补洞。

## 6. 测试分层与可携带性缺口

| 层次 | 明确入口 | 必要前置 / 结果边界 |
| --- | --- | --- |
| 类型 | `bun run typecheck` | frozen 安装完成，CSS 文本模块声明在场；只证明类型，不证明浏览器或模型可用。 |
| 有限核心 | `bun run test` | Windows 原生依赖、TEMP；定位/引擎 opt-in 未启用时应保留 skip。 |
| OCS backend | `bun run test:ocs`；`bun test ./tests/ocs-script-security.test.ts` | 读对应文件，Chrome 变量决定真实浏览器分支；真实文件/DPAPI/编译烟测不等于平台课程测试。 |
| Pi runtime | `bun test ./tests/pi-runtime.test.ts` | 官方 SDK + 项目 DPAPI；使用无 Key/受限配置验证门禁，不应接入私人模型 Key。 |
| 源码 UI | `bun test ./tests/pi-ui.test.ts`；`bun test ./tests/ocs-host-ui.test.ts` | 起源码宿主及 Playwright，独立数据；Edge/指定 Chrome 和证据路径按文件要求。 |
| Pi→OCS 工具/UI | `bun test ./tests/pi-ocs-tools.test.ts ./tests/pi-ocs-ui.test.ts` | **当前不是跨机即用**，下述硬编码须先处理；不开真实模型请求，不能作为模型闭环。 |
| GM、同步、资源、网络 | 第 5 节文件与 opt-in | 仅启用已授权的那一层；公网 GET/HEAD、POST、实际学校登录不得混组授权。 |
| 构建资源 | `bun test ./tests/build-ocsjs.test.ts` | 完整固定 Chrome 输入、TEMP、Windows 路径/联接验证；会复制资源、测试篡改检测，仅作用于测试目录。 |
| 完整编译宿主 UI | `bun run test:desktop` | **必须先有完整独立 TEST_ONLY bundle**，显式 SWU_TEST_EXE；测试子进程按用例设置隔离用户目录，Edge 可用，engine/Chrome/许可资源匹配。不是源码级冒烟。 |
| 真实服务 | 具体授权后设计一次有预算的集成 | 学校/课程/模型调用不因某个变量存在而自动获准；记录 HTTP/计费/取消未知项。 |

### 6.1 目前需要先修的测试可携带性

- `tests/pi-ocs-tools.test.ts` 和 `tests/pi-ocs-ui.test.ts` 的 `chromePath` 常量仍是原维护工作站的绝对路径；前者不存在时 skip，后者直接启动。两者还在内部覆写 `SWU_OCS_BROWSER`，因此外部设置这个变量不能修复它们的 portability。**这次仅记录，未改测试代码。** 建议下一轮改为显式、已核实项目 Chrome 输入，缺失明确报错/按约定 skip，记录实际执行路径，不构造同名原盘符目录蒙混过关。
- `test:desktop` 的默认 `releases/打卡助手.exe` 不是隔离保证；使用前必须显式指定审核过的 TEST_ONLY EXE。`application.spec.ts` 自己在 work 下创建唯一目录并给子进程覆盖 SWU_USER_DATA_DIR；外部给该变量赋值不等于覆盖所有测试 fixture。
- 前次完整 TEST_ONLY bundle 的组装/验收流程保存在原维护者 work，不在源码包中，根 package 也没有 `build:test-only` 脚本。不能要求接手者运行不存在的报告或脚本。完整重新验收前，需要另行授权并补一个可审查、资源显式、保持 RELEASE_BLOCKED 标记的隔离测试构建流程；**不能以直接调用编译器绕过正式 build 门禁来冒充可发布产物**。
- `bun run check` 串联 typecheck、core、正式 build、desktop、installer。许可和私有输入未解决前，它不是日常“一键绿色”命令；应分层执行，明确阻塞，不能删掉失败步骤。

### 6.2 重新验收应记录什么

记录版本/edition、依赖和工具实际版本、源文件/EXE/资源摘要、精确命令、环境变量名称与脱敏用途、pass/fail/skip、退出码、耗时和重试次数；UI 用稳定 test ID，不用可见文案定位失败后的回退点击。保存首轮失败，不用后续成功覆盖它。

真实 Chrome/DPAPI 测试通过说明用了真实组件，不保证没有合成测试输入。现有测试有人工构造的 UUID、账号形状字符串、模型配置与 HTML 表单，这些是边界测试数据，**不要误当成真实凭据，也不要把它们当真实学校业务成功证据**。若怀疑某个值真实，停止传播并分类核查，报告不抄值。

完成后正常关闭自己创建的宿主/Chrome，确认 owned 进程和实例管道无残留；不强杀用户浏览器，不自动删除来源不明的 profile。失败时保留证据和所有权状态。

## 7. 引擎、主程序、安装器各自负责什么

### 7.1 构建入口顺序与门禁

下列是**条件满足后的项目入口**，不是当前能成功执行的承诺；不要现在为了得到 EXE 去关闭检查：

```powershell
bun run build:engine
bun run build
bun run build:installer
```

1. `scripts/build-engine.ts` 验证 SWU_PYTHON / SWU_ENGINE_DIST / SWU_ENGINE_BUILD，用该 Python 执行 `-m PyInstaller --noconfirm ... engine/engine.spec`。spec 收集 mitmproxy、Crypto、ddddocr、onnxruntime、上游模块、声明和私有 data 输入；COLLECT 产出 `lepao-engine.exe`、`mitmweb.exe`、`captcha-ocr.exe` 及共享资源，然后导出 Python notices。**缺少 data 时当前不能原样完成。**
2. `scripts/build.ts` 先 `assertOcsBuildOutputIsolated`，再 `assertNpmNoticesComplete`，再固定 OCS/OCSJS/Chrome 核验；许可失败发生在正式输出创建/编译之前。资源就绪后生成图标、编译 `desktop/bun/launch.ts` 为 Bun Windows EXE（带 renderer），复制 engine、Chrome、来源/许可，导出 npm notices，最终 `writeBuildMetadata`。
3. `scripts/build-metadata.ts` 将版本/edition、EXE 和 engine/modules/licenses 摘要写入 `build-info.json`；`verifyBuildMetadata` 复核当前包与版别。输出校验会拒绝 reparse points、非普通目录、陈旧 Electron/未知 OCS 输出、内容或 manifest 不匹配；**并没有宣称任意源码/work 重叠路径都会被自动禁止**，操作者仍必须选新的隔离输出。
4. `scripts/build-installer.ts` 要求主 EXE 和真实 `build-info.json`，先复核，再调用显式 ISCC 与 `installer/setup.iss`。禁止手写 build-info 或把 TEST_ONLY 元数据改名冒充正式 build。
5. `installer/setup.iss` 负责固定 AppId、当前用户安装位置、文件复制、快捷方式和卸载。正常目录为 `%LOCALAPPDATA%\Programs\SWU-Daka`；PrepareToInstall 执行控制入口 `--shutdown`，忙碌/未退出拒绝安装；卸载用 `--uninstall`。正常安装不是测试数据隔离器，不应在开发试错时反复覆盖日常安装。

旧 `scripts/prepare-ocs.ts` 和 vendor 兼容代码留存不代表仍是当前构建入口。不得恢复 OCS Desktop/Electron 打包、自动更新或旧辅助服务来补缺失能力。

### 7.2 已安装事实不改变发布状态

2026-10-19 最新已验收 EXE SHA-256：

```text
b42399a2f597c4c47bc3308029fdfecb0626acb6bc74e22b3ddb1cebe7977d89
```

同一件在隔离完整桌面测试中 **15 pass / 0 fail / 5 skip，134.47 秒、0 retries**；同期 typecheck exit 0，Pi UI **1 pass / 6 assertions**。不是继承较早 EXE 的结果。

本机随后按单独授权完成 **LOCAL_ONLY / TEST_ONLY / RELEASE_BLOCKED** 安装：1472 项 payload 哈希匹配，加 2 项本机说明/许可事实和 2 项卸载文件，共 **1476 文件**；快捷方式直接指向安装 EXE，TEST_ONLY 标记保留，未生成正式 build-info。**安装后未启动应用、未读取账号内容，未验收安装账号环境运行。** 正常关闭原实例可能刷新应用状态，不宣称账号树逐字节未变。

这是原维护者的历史执行事实，不是给接手者绕过 `build.ts` / `build-installer.ts` 门禁的操作指南，也不是新机器安装授权。

## 8. 下一个最小工程任务：解除非私有开发输入阻塞

### P0-A：先分清“可以开发 UI/宿主”和“可完整重建引擎”

当前 TS 依赖、shared schema、配置 UI、Pi/OCS 部分测试可独立推进；**不要把完整引擎构建成功作为开始阅读或 typecheck 的前提，也不要把它尚未成功藏起来。**

已定位的阻塞链：

- `engine/engine.spec` 的 datas 收集整个 `vendor/lepao3/data`。
- `vendor/lepao3/lepao/track.py` 的 `_find_template()` 与 `TEMPLATE_FILE` 定位模板，`TemplateGenerator.__init__` 会打开模板。只删 spec 的 datas 项并不能证明运行时不再依赖它。
- `engine/bridge.py` → 上游 `ui/run_core.py` 的 action 路径要共同检查，不能仅用 PyInstaller exit 0 作为业务可用证明。
- 根 NOTICE 对原随包模板和 Python 3.11 的描述，不自动适用于当前排除了私有目录的源码交接；原文保留，差异在这里说明，未重新认定该数据可以公开。

**建议方案，均未实施：**

1. 先定义不依赖私人数据的开发范围和输入契约。若仅需宿主/引擎通信与状态验证，设计显式的非生产测试输入或将确实依赖模板的功能明确报为不可用；不能静默回退、伪造成功或默认走另一条提交链。
2. 如必须提供模板，取得可验证许可、无身份/位置隐私的替代资源并单独审查；合成材料只用于明确的离线格式/构建测试，标注“非真实业务输入”，不得用于伪造学校/运动完成证明。不能改名补入原私有文件，也不能从账号/轨迹目录导出材料。
3. 以最小变更调整 spec 与运行时加载边界，参数显式、缺失/格式错误明确失败，保留原署名。不要新建未经验证的通用 fallback 或自动下载机制。
4. 决定并记录目标 Python 版本，对照锁文件、PyInstaller hooks、OCR/onnxruntime/mitmproxy 原生依赖验证；3.12.8 开发恢复不等于 3.11 随包兼容，两个结论分开。

**验收标准：** 从不含私有目录的干净源码输入出发，依赖冻结恢复、无读取私人文件、构建材料来源可审计；引擎三 EXE 与 notices 产物完整；隔离 JSON-lines 启停/无账号状态及受影响路径的失败边界清晰；未发生代理/证书/学校/运动提交副作用。若仍无法完整构建，准确列出剩余必需输入，不标完成。许可 preflight 仍独立保持阻塞。

### P0-B：让验证入口可携带

入口：`tests/pi-ocs-tools.test.ts`、`tests/pi-ocs-ui.test.ts`、`package.json`、`scripts/build.ts`、`tests/desktop/application.spec.ts`。先修两处 Chrome 输入硬编码，再在独立授权下设计可复用 TEST_ONLY 组装/校验入口。新流程不能改变正式许可检查或安装正式账号环境。

验收：另一非原盘符路径下能用显式 Chrome 运行工具/UI 测试；无输入时可操作地失败而非误报通过；完整测试包有隔离标记和真实资源哈希；桌面 suite 明确 5 类可选项的 skip，未让测试从 daily profile 取数据。此任务不包含升级 SDK/Chrome 或任意增加工具。

### P0-C：发布许可与仓库边界

入口：`scripts/npm-notices.ts` 的 `planNpmNotices` / `assertNpmNoticesComplete`，`licenses/npm-source`，`tests/npm-build-preflight.test.ts`、`npm-notices-artifact.test.ts`。核实缺失全文的精确版本与内联来源；取得可审计证据或批准兼容替代后再修改依赖/锁和审定清单。

验收：全部实际 runtime 实例有适用证据、打包产物内 notices/摘要一致、正式 preflight 与负向篡改测试仍有效；不能通过排除内联包或补任意 MIT 文本凑数。法律/分发决定与技术通过分别记录，未获批准不上传。

## 9. P1 接手计划：范围可验证，不作产品承诺

| 任务 | 代码入口 / 方法 | 完成条件和禁止冒称 |
| --- | --- | --- |
| 历史 Chrome 自退根因 | `ocs-browser.ts` 的 own/release/stopOwned、`ocs-lifecycle.ts`、`gm-runtime.ts`；`ocs-lifecycle.test.ts`、两个 observation 文件和桌面 lifecycle spec | 在隔离空白 profile 建立可重复事件时间线：宿主是否活着、ownerSequence、是否主动 close、context close/browser disconnect/page crash、GM 结算、父进程 stdio/GC 等。先证伪假设再最小修复；短时未复现只写观察结果，禁止 keepalive/自动重启/强杀掩盖。 |
| 真实模型→工具闭环 | `pi-service.ts`、`pi-ocs-tools.ts`、`pi-ocs-approval.ts`、`PiChat.tsx` | 另行授权服务商、脱敏 prompt、调用/费用上限；仅空白已存 profile。观察模型真实 tool call、独立工具结果同意、宿主审批、批准/拒绝/取消与返回结果；保留未知 HTTP 数/计费，不伪造响应或把生产函数直调叫模型闭环。 |
| OCS 剩余 GM / OCSJS 适配 | `ocs-assets.ts`、`desktop/ocs/*`、固定 5.2.1 原文、shared capability | 每次只移植一项所需能力并列威胁边界/真实隔离测试；仍不支持的声明保持 unsupported。新增能力不能扩大 Pi 工具权限或自动触发课程流程。 |
| 平台登录兼容 | `ocs-login-runner.ts`、`shared/ocs-login.ts`、`login-submission-policy.ts` | 先本地真实 form/来源/submitter 边界，再单独授权本人真实平台一次确认。验证码/MFA停给本人，不绕过、不重试密码；真实身份核验未接通前仍不报 loginVerified=true。 |
| 学校教务/查寝适配 | `academic-*`、`application.ts`、core workflow/submissions | 每平台变化定位具体返回/页面，使用授权最小只读验证；不让教务变成写操作，不破坏查寝防重与未知结果回查。 |
| OCR、视频、课程执行/完成回传 | OCS capability 目录及各自待设计适配层 | 目前未实现，先设计授权、数据流和可核验结果，不把宿主数字 OCR、PNG、配置保存或浏览器启动当替代验收。 |
| 完整 UI 与编译后 API/TLS | renderer、provider fetch、独立 TEST_ONLY bundle | 全界面中文化/真实审批视觉尚未验收；编译后真实模型/TLS与源码 SDK请求分层验收，不改全局代理/CA或关TLS。 |
| 陈旧能力提示一致性 | `desktop/bun/ocs-browser.ts` 的 `script.runtime.scope`；`desktop/bun/ocs.ts` 的脚本导入/启用错误文字 | 仍有“无网络/@resource”等旧范围描述，与已实现的受限网络/资源子集不一致。这次只记录，未修代码；后续逐处对照真实 parser/capability 修正文案并验收，不扩大 supported、不取消拒绝路径。 |

优先级表示建议工程顺序，不表示这些功能已获得真实学校、账号、模型付费或公开发布授权。若只接 UI/宿主工作，可在明确不触碰阻塞输入的范围内继续，但总项目不能因此写“完整完成”。

## 10. 历史验证摘要与证据层级

以下为维护者截至快照日的报告摘要，本轮文档未重跑。源码包不带对应 work 原始文件；不要创建空同名报告或把文档数字当新机器测试结果。

| 验证层 | 已有摘要 | 明确未覆盖 |
| --- | --- | --- |
| 最新同件完整 EXE | 上述 b42399…：desktop 15/0/5、134.47 秒、0 retries；typecheck 0；Pi UI 1 pass / 6 assertions | 五项 skip：真实失效会话、跨 Alpha EXE、两项真实教务、未启用生命周期调查；不是全功能全平台验收。 |
| Pi runtime / 工具生产函数 / UI | runtime 4 pass / 69 assertions；真实 Chrome/DPAPI 工具 1 pass / 57；UI 1 pass / 6 | 没有真实模型驱动审批和工具结果续发闭环；UI 门禁测试不发送 prompt。 |
| GM 资源与同步 | 8 pass / 117 assertions；资源外部请求 0；独立 EXE 内联 CSS 编译运行成功 | 不证明任意网络资源或完整 OCSJS。 |
| GM 公网无凭据只读 | 4 pass / 1 skip / 133 assertions；另在途取消 1 pass / 11；13 原生请求为 12 GET + 1 HEAD，POST/Cookie 为 0 | POST 项未授权启用；继承已有 CA/Node 环境，不是干净默认 TLS 验收。 |
| 网络授权分支修复后 | 23 pass / 0 fail / 4 skip / 451 assertions，独立 Bun 编译烟测成功 | 公网成功来自前序网络组，后续单行无 grant 修复后未重复成功公网请求，不混写为同次证据。 |
| 标准核心 / focused | core 21 pass / 2 skip / 73；focused 56 pass / 458 | 核心 skip 与对应环境有关；许可失败门禁测试通过不解除发布阻塞。 |
| 本机安装 | 1472 payload / 1476 total，EXE 与已验收件一致 | 未启动安装账号环境，未操作学校/模型；不是发布批准。 |

历史自退未定位、完整 OCS 未完成、学校平台兼容未全面验收、真实模型闭环未完成、私有输入替代未实施、Python运行时差异未解决、发布许可未解除，均应继续保留。后续通过项不能抹掉这些未验收层。

## 11. 上传仓库前的准备清单

本次文档任务没有执行 Git 初始化、暂存、提交、推送或上传，也没有为接手者取得这些操作的授权。以下仅是将来获准后的准备要求，不是自动发布脚本。

1. **先决定分发范围与许可证。** private source handoff 不等于 public repository 授权；LRL-1.0 非商业限制、上游署名、OCS 声明与 npm 许可缺口分别核查。不要为了“可上传”删 NOTICE 或变更许可证。
2. **从显式候选清单审查，不压整个工作目录。** 必须保留必要源码、测试、assets、`engine/engine.spec`、两套锁、package/tsconfig/Playwright 配置、installer 来源、固定 vendor 原文/manifest 和 licenses。私有 data 缺口在交接清单中明确，不能悄悄补入。
3. **秘密/隐私审查。** 排除账号、密码、Cookie、Key、个人 endpoint/header、学校/教务数据、轨迹、原始流量、DPAPI 密文及其 profile；密文也是私有数据，不因本机外无法解密就可上传。报告只写命中类别与位置，不复制值。
4. **大文件与生成物审查。** 排除 `node_modules`、虚拟环境、work、releases、预览、EXE/ZIP/安装器、Chrome/engine 二进制、日志/trace/截图/profile、缓存和个人智能体目录。不能只依赖扩展名：大二进制可能无扩展，图片也可能含隐私元数据；必要 assets 与固定上游材料逐项判断。
5. **理解现有 `.gitignore`。** 已覆盖 Python 缓存/venv、node_modules/dist/build、EXE、环境/常见密钥、日志/数据库、ChromeSwuLoginProfile、har、work/releases 和私有 `vendor/lepao3/data/`；`*.spec` 有 `!engine/engine.spec` 例外，`.env.*` 有 `.env.example` 例外。它不是完整安全策略，也没有自动排除任意名字的 profile、截图、ZIP 或个人配置。被忽略不等于未曾跟踪，最终仍需审核候选文件。
6. **测试值分类，不误删也不误信。** 合成 UUID、测试模型字段、动态 PEM 模板或无凭据公开 URL 的扫描命中，不直接等于泄密；逐位置实读并记录判断。测试 fixture 可保留不等于它证明真实凭据/学校调用成功。
7. **固定材料不为通过扫描而改写。** 既有 vendor 原文、manifest 和许可来源中有历史工具路径，应判断是非秘密来源元数据还是隐私；不能随意 scrub 或 regen 导致哈希失真。确需公开处理时另作可审计决定，不改装成上游原件。
8. **新归档逐项核验。** 文档完成后才冻结候选文件，记录实际哈希与排除边界；再比较归档条目、原件和禁止项。源码包版本与 EXE 版本分别标识，不称 ZIP 可完整重建，也不填尚未生成的 ZIP 哈希。

## 12. 每轮接手的最小交付

给下一位维护者留下：本轮明确目标、改动文件/完整调用边界、实际验证命令和摘要、失败/skip 与原因、是否触及外网/真实数据/系统设置、哪些问题没有解决、下一最小任务及验收标准。文档只维护当前有效摘要；大型日志与截图放在自己隔离证据位置并按授权分享，不把本机证据路径变成源码恢复的必需条件。

**本快照结论：** 可以继续开发和验证已实现的宿主/React/Pi/OCS 子集；不能称完整 OCS、真实模型工具闭环、跨平台学校兼容或浏览器自退已解决；不能称私下源码包可原样完整重建；已有 LOCAL_ONLY 安装也不能越过正式发布许可门禁。
