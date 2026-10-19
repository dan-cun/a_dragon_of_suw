# 使用本人 DeepSeek API 接入 Pi（兼容其他模型服务）

适用：西大日常的「Pi 助手」页。优先推荐使用本人申请的 DeepSeek 等国产模型 API，但不限制厂商或地区；其他服务按本应用实际支持的兼容协议配置。本教程以 DeepSeek 官方公开接口举例，不绑定任何本机私有端点。下述官网信息核对于 2026-10-18，模型名和计费以实际服务商文档为准。

## 先分清三个概念

- **DeepSeek API**：请求发送到 DeepSeek 云服务，需要本人创建的 API Key、网络及可用额度；不是把权重部署在电脑上。
- **本机模型服务**：自行安装推理服务、下载适合硬件的权重，再用本机兼容地址连接。它与 DeepSeek 云端当前模型不是同一服务，也不保证相同能力。
- **Pi**：此处使用 Pi 项目官方 Agent 核心引擎与模型 SDK，不安装独立 coding-agent CLI。连接模型与执行工具是两层能力；仅保存配置不代表会话已启动、API 已连通或工具已启用。[Pi 官方模型说明](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md "Pi 官方区分模型选择、鉴权与自定义兼容端点")

本教程不要求另装独立 Pi CLI。独立 CLI 的配置/鉴权文件不等于本应用的 DPAPI 存储，不应把学校账号或本应用密钥复制进去。

## 推荐的 DeepSeek 云端 API

### 1. 本人准备账户与密钥

1. 打开 DeepSeek API 官方文档，沿官方入口进入平台。
2. 本人登录并在 API Keys 页面创建密钥，确认账户计费与额度。网页聊天账号可用不等于 API 额度可用。
3. 密钥只填本应用专用的 **API Key** 框，不放在 URL、名称、模型 ID、请求参数、教程截图或诊断提示词里，也不交给 WorkBuddy。

官方当前给出的 OpenAI base URL 为 `https://api.deepseek.com`，模型名为 `deepseek-flash` 和 `deepseek-v4-pro`。[DeepSeek API 文档](https://api-docs.deepseek.com/ "DeepSeek 官方列出当前模型名、OpenAI 与 Anthropic 地址及 API Key 入口") [DeepSeek API Keys](https://platform.deepseek.com/api_keys "DeepSeek 官方平台的 API 密钥管理入口")

### 2. 在西大日常实填

进入侧栏「Pi 助手」→「模型配置」，点击「新建 DeepSeek 推荐配置」预填以下公开字段；也可以用「新增其他配置」手动填写。预填创建全新草稿，不覆盖已保存配置、不携带旧密钥、不自动保存：

| 界面字段 | 推荐填写 | 注意 |
| --- | --- | --- |
| 配置名称 | `DeepSeek API` | 只是本机显示名，不含账号 |
| 接口协议 | `OpenAI Chat Completions` | 首先用这一项建立最小配置 |
| 接口地址 | `https://api.deepseek.com` | 不填 Key、查询参数或聊天网页地址 |
| 模型 ID | `deepseek-flash` | 或本人选定的 `deepseek-v4-pro`，以官方列表为准 |
| API Key | 本人新建的密钥 | 教程不提供密钥；由本人填写 |
| 请求超时 | `120` 秒 | 先保留页面初始值；超时不等于未计费 |
| 上下文 / 输出上限 | 留空 | 未确认时不猜数值 |
| 图片输入 / 工具调用 | 图片能力保持未知；工具能力仅由本人显式启用 OCS 模式时使用，且必须明确为 `tools=true` | 服务商声明能力不等于授权或已验证 |
| 请求头 JSON / 额外请求参数 JSON | 留空 | 普通官方 API 无需手填 Authorization；不要复制网页 Cookie |

点击「校验并保存」。本应用通过现有 Windows CurrentUser DPAPI 加密保存配置，普通状态不回显 Key；编辑留空保留原密钥。忘记密钥同时清除自定义请求头，删除配置与忘记密钥是不同操作。DPAPI 是本机当前 Windows 用户的加密边界，不是跨电脑可迁移的密钥保险箱，也不保护已粘贴到外部聊天的文本。

**保存只验证配置结构并落盘，不会调用 API，不代表余额、鉴权、端点、模型或 Pi 会话正常。** 默认进入无工具 diagnose；只有本人启动时显式启用 OCS，且所选服务商明确 `tools=true`，才开放最小概览和已保存浏览器启动/停止/聚焦申请。发送对话前另有服务商确认，OCS 模式还需独立确认最小工具结果可继续发送；每个浏览器动作仍须本机逐次审批。整理器的复制或放入草稿动作都不是模型请求。详细步骤见 [Pi 会话与受控 OCS 边界](pi-assistance.md#使用原生-pi-会话)。

### 3. 五种协议如何选择

| 现有协议 | DeepSeek 云端 / 本机填写方式 | 当前边界 |
| --- | --- | --- |
| OpenAI Chat Completions | DeepSeek 云端填 `https://api.deepseek.com`，ID `deepseek-flash` 或 `deepseek-v4-pro` | 推荐起点；原生运行时保留所填根地址，由 SDK 请求 `/chat/completions`，不强加 `/v1` |
| OpenAI Responses | DeepSeek 云端填 `https://api.deepseek.com`，ID 同上 | 官方已提供 Responses，但不支持服务端会话持久化；运行时保留根地址，由 SDK 请求 `/responses` |
| Anthropic Messages | 填 `https://api.deepseek.com/anthropic`，ID 同上 | 使用真实 DeepSeek 模型名，不冒充 Claude；由 SDK 请求该根地址下的 `/v1/messages` |
| Gemini GenerateContent | **不要把 DeepSeek 官方地址填在此项** | 五协议配置仍保留；当前原生会话因该适配器不能注入受限 fetch 而明确拒绝启动，不借此放宽请求边界 |
| Ollama 兼容接口 | 仅用于本人已运行的本机 Ollama 服务，模型 ID 按该服务实际标签填写 | 保留兼容选择，不要求用户下载或部署 DeepSeek 权重 |

Responses 的 `previous_response_id`、`conversation`、`store` 等不能当成可用的服务端会话能力；兼容接口也不代表支持任意内置工具。[DeepSeek Responses 兼容说明](https://api-docs.deepseek.com/guides/responses_api/ "DeepSeek 官方列出 Responses 地址、无状态限制与支持字段") Anthropic 接口以 `/anthropic` 为 base URL，并有部分字段被忽略或不支持。[DeepSeek Anthropic 兼容说明](https://api-docs.deepseek.com/guides/anthropic_api/ "DeepSeek 官方说明 Anthropic 消息接口、模型名和兼容限制")

**端点说明**：原生运行时保留本人明确填写的 Chat / Responses 根路径，SDK 只拼接对应消息路径；其他服务如果官方要求 `/v1`，请明确填入 `/v1` 根地址。本教程没有使用真实 Key 验证服务商调用、SDK 流式行为或所有兼容协议。若明确发送后返回 404，应核对实际脱敏请求路径与服务商文档，不要反复添加 `/v1`、乱换协议或把保存成功写成已连通。

### 4. 最小验证与排错

- 在原生会话入口先用默认 diagnose 做最小验证：选定模型、启动、输入不含学校数据的短问题，阅读发送/计费提示并由本人确认发送。启动不调用模型；不要用真实课程或账号做首测。
- OCS 是单独显式模式，不是 DeepSeek 的默认工具能力：本人须启用 OCS 且 provider 声明 `tools=true`；每个浏览器动作仍逐次本机审批，工具结果另有发送确认。
- 仅看到「已保存密钥」不算验证。需有实际响应或具体错误；模型回复正常也不代表工具可用。当前已验收本机工具执行与编译/UI，但尚无真实模型→工具→结果闭环或学校登录/课程验收。
- 401/403：检查本人平台密钥、账户权限和 endpoint，不将密钥贴给助手；429：核对限流/额度，停止手动连点；404：核对路径及 ID；连接/超时：检查网络与服务商状态，不关闭 TLS 验证，不自动改系统代理。错误码含义以实际响应为准。
- 不自动切换服务、重发有副作用的动作或递归重试。分享错误时只保留脱敏状态码、操作阶段和可复现现象，不分享完整请求头、签名 URL、Key 或学校响应正文。
- 无真实 API 验证时，应明确标为「配置已保存，调用未验证」。本教程不保证价格、额度和未来模型 ID。

## 其他兼容模型服务

DeepSeek API 是国产推荐示例，不是唯一提供商，也不是只支持国产模型。本应用仍保留五种协议配置；可选择国产或其他厂商服务，由本人按该服务官方文档填写协议、公开端点、模型 ID 与凭据，不把 DeepSeek 的参数套用到其他服务。兼容应同时核对本应用已实现的适配器和服务商真实接口；保存配置不代表原生会话支持该协议，当前 Gemini 限制见上表。

**不保证所有模型支持视觉或工具。** 不清楚时将能力保持「未知」，服务商宣称支持也不等于本应用已接入该能力。默认 diagnose 仅文本输入且 `tools=[]`；显式 OCS 模式也只提供最小概览及已保存浏览器启动/停止/聚焦，不提供文件、shell、任意浏览器或学校业务权限。

已有的本机 Ollama 服务可按其官方 OpenAI 兼容文档配置本机 `/v1` 地址与实际已存在的模型 ID。此教程不要求安装 Ollama、下载 DeepSeek 权重或部署推理服务，也没有执行这些操作。[Ollama OpenAI 兼容文档](https://docs.ollama.com/api/openai-compatibility "Ollama 官方说明本机 OpenAI 兼容端点与配置方式")

## 西大日常交给别人怎么用

给对方由维护者提供、核验过的完整 Windows 安装包，不单发 EXE、不发送自己的用户数据目录或配置密文。对方安装后自行填入 API Key；不需要因为使用本页配置而安装 Bun、Python、独立 Pi CLI 或 WorkBuddy。源码编译、打包条件仍以项目现有 README 为准；模型服务配置不是西大日常的发布流程。

更多：[Pi 辅助与异常诊断](pi-assistance.md) · [WorkBuddy 外部协作](workbuddy.md)。
