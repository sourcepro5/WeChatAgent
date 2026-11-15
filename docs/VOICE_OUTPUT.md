# 语音对话与发送接口

Windows x64 0.4.5 安装包的 4.2.0.12 Hook 支持后台原生语音发送。启动时校验微信核心文件的指纹，健康接口报告 `nativeVoiceSend: true` 后，现有 WAV、插件合成和 Realtime 音频都可以交给 Hook 发送。已加载的旧 Hook 仍会返回 HTTP 501 与 `VOICE_UNSUPPORTED`。

0.4.5 安装包预置语音对话 API 1.7.0。可在「能力 → 能力目录」直接配置，默认关闭。若同时启用内置的语音识别 API，请为同一聊天只配置一个转写来源。升级后从微信托盘退出旧客户端，再通过控制台打开匹配微信。已配置并授权的语音对话插件可通过该 Hook 发送原生语音。

## 开发版手动构建与验收

在开发目录构建语音组件。构建完成后，控制台的「打开微信」和 `Launch-Hook-WeChat.cmd` 都会选用这个开发组件。从托盘退出旧微信再打开，登录后重启 WeChatAgent，使适配器也载入新版代码。

```powershell
.\scripts\build-hook-42012.ps1 -BuildDirectory state\hook\build-voice-4.2.0.12 -OutputDirectory state\hook\native-voice-4.2.0.12
.\scripts\launch-hook-wechat.ps1 -VoiceCandidate
```

上面的 `-VoiceCandidate` 只开放文件传输助手的语音投递。按常规流程把文件传输助手加入聊天白名单，再使用下方接口验证。看到 `confirmed` 后，在微信里点开气泡确认音频可播放。通过常规入口启动时，开发组件按项目聊天白名单处理私聊和群聊。打包语音组件需要实机回执验收。

Hook 将音频提交给微信原生任务队列，构造类型 34 的语音消息。只有账号、目标、时间窗口和 SILK 指纹匹配的出站记录取得服务器消息 ID 时，才返回已确认。语音 ABI 和版本指纹参考 Helper 的原生实现与兼容表。[Helper 原生语音路径](https://github.com/Prometheus-first/helper/blob/main/native/voice_send.h) · [Helper 兼容表](https://github.com/Prometheus-first/helper/blob/main/native/compatibility.json)

## 本机接口

接口使用现有 adapter 的回环端口。调用方需在开发目录的 `state/voice-send.token` 中配置一个独立的 64 位小写十六进制随机令牌，并通过 `Authorization: Bearer <token>` 提交。只有配置过的令牌才可访问。可在开发目录运行以下命令生成令牌文件，已有文件时命令会报错。

```powershell
node --input-type=module -e 'import fs from "node:fs"; import crypto from "node:crypto"; fs.writeFileSync("state/voice-send.token", crypto.randomBytes(32).toString("hex"), {flag:"wx",mode:0o600})'
```

`POST /api/voice/send` 接受 `application/json`。

```json
{
  "conversationKey": "wechat:private:12345",
  "deliveryId": "unique-client-operation",
  "wavBase64": "<base64 encoded WAV>"
}
```

- `conversationKey` 使用现有微信聊天白名单中的私聊或群聊 ID。
- `deliveryId` 为 1–80 个 ASCII 字母、数字、下划线或短横线。同一 ID 绑定同一聊天和音频。重复提交查询原投递。`realtime-` 或 `dsh-` 后接 64 位十六进制的 ID 留给自动回复使用，接口不接受。
- `wavBase64` 为标准 Base64 编码的 RIFF WAV。音频须为 16 kHz、单声道、16 位有符号 PCM，时长最多 60 秒，文件最多 2 MiB。宿主在内存中将其编码为 SILK。

`GET /api/voice/send/<deliveryId>` 查询状态。两条接口返回 `deliveryId`、`durationMs` 和 `status`。

| 状态 | HTTP | 含义 |
| --- | --- | --- |
| `pending` | 202 | 已登记投递，等待回执 |
| `confirmed` | 200 | 已找到关联的原生语音回执，同时返回本地 `messageId` 和 `receipt: "wechat-server-id"` |
| `unconfirmed` | 200 | 查询窗口内未能确认，可继续查询迟到回执 |
| `rejected` | 200 | 后端明确拒绝本次投递 |

音频字节只在请求期间保留，投递元数据保存在本机 `state/voice-deliveries/`。进程重启后使用原 ID 查询即可。每次查询都会核对当前账号、聊天映射和白名单。

## 通过插件合成并发送

在“能力 → 能力目录”打开“语音对话 API”插件，设置页列出三项语音能力（语音合成、实时语音识别、单条语音识别），每项一行。点“添加”或“编辑”展开该项，在页签中选择第三方模型提供商（腾讯云、千问 / 阿里云百炼、OpenAI、硅基流动、ElevenLabs、Azure AI Speech、Google Cloud、智谱、阶跃星辰）或任何兼容的自定义 API，用“试听”或“测试”检查后保存。三项能力各自保存服务、凭据和参数；“收到语音时使用”决定每条收到的语音交给实时识别还是单条识别（只提交给一个服务）。启用后授予插件权限并分配聊天。每个聊天可指定一个启用的合成插件。各服务实际接通的能力和验证状态见插件说明。[插件说明](../optional-extensions/speech-synthesis/README.md)

使用与 WAV 发送接口相同的本机令牌，调用 `POST /api/voice/send-text`，正文使用 `application/json`。

```json
{
  "conversationKey": "wechat:private:12345",
  "deliveryId": "speech-001",
  "text": "这段文字会合成为微信语音。"
}
```

适配器先核对聊天、账号和语音发送后端，再调用该聊天授权的插件。插件将文本提交给本机配置的 `/audio/speech` 服务，取得 WAV 后统一转换为 16 kHz 单声道，并交给现有投递流程。单次文本最多 4096 个字符，语音最多 60 秒。只有主动调用此接口才触发合成。

投递状态仍通过 `GET /api/voice/send/<deliveryId>` 查询。同一投递 ID 绑定文本和聊天。重试只查询原投递，合成失败后可使用新 ID 发起一次新的请求。重启时仍处于合成阶段的投递会在等待窗口结束后显示 `unconfirmed`。

## 逐轮选择文字或语音

同一聊天里，模型每轮决定这一次回文字还是语音。收到文字或语音都可以触发。用户明确要求（例如“用语音回答”“念给我听”“打字发我”）时优先照做；代码、链接和需要复制的内容用文字。两条模型链路最终都交给 WeChatAgent 发送，共用聊天白名单、账号核对、投递去重和回执核对。

本轮能否发语音由当前发送后端决定，模型只会被告知本轮可用的形式：

| 发送后端 | 文字 | 语音 |
| --- | --- | --- |
| `wechat-hook`（默认） | 可以 | 4.2.0.12 语音 Hook 就绪时可用，候选启动方式仅限文件传输助手 |
| `wechat-helper`（下文 Helper 完整后端，实验） | 可以 | Helper `allowed_targets` 中的目标 |
| `wechat-input` 且 `input.voiceSend` 为真 | 可以 | 仅文件传输助手 |

### Realtime 链路

Realtime 链路在 WeChatAgent 内独立运行，不经过 DSH 的会话、人设和工具，只把当前这一条消息交给所选平台。

1. 在“语音对话 API”设置中，把“语音合成”配置为任意支持 Realtime 朗读的服务（OpenAI、千问 / 阿里云百炼、智谱或阶跃星辰，或自定义 Realtime WebSocket），在“高级设置 → 回复的生成方式”中选择“语音直接对话”，填写密钥。点击“测试对话（查看回复形式）”，页面会显示模型选择的形式和正文，选语音时可试听。测试结果只说明平台可用，不代表微信投递结果。
2. 启用插件，授予语音读取和生成权限，将目标聊天分配给插件。
3. 私聊里的文字和语音都会交给 Realtime。群聊里的文字需要 @ 本账号；群聊语音沿用聊天的触发方式，仅 @ 模式仍要求 @。助手模式继续校验发送者的管理员授权。分配了 Realtime 的聊天里，这些消息不再交给 DSH；群聊里未 @ 的文字仍交给 DSH。

模型先只输出文字，格式为 `{"mode":"voice"|"text","text":"…"}`。宿主校验形式、正文长度（不超过 600 字，语音不超过 400 字）、编码和协议标记。选语音时，同一会话再请求一段音频，逐字朗读已选定的正文，最长 60 秒。文字和音频都要等到 `response.done` 状态为 completed 才算完成。

- 输出无法解析或形式不可用时，记录错误代码 `VOICE_REALTIME_CHOICE_INVALID` 并结束本轮，不发送任何内容。
- 选了语音但音频生成确定失败（尚未提交微信）时，改发一次同样的文字。语音已提交、或提交结果不明确时，只查询原投递的回执，不改发文字。
- 每条入站消息有一个固定的投递 ID：语音为 `realtime-<语音 ID>`（与 1.3.0 相同，1.3.0 已回复过的语音不会再回复），文字为 `realtime-` 加账号、聊天和消息 ID 的 SHA-256。模型的选择在发送前写入 `state/realtime-replies/`，只保存阶段、形式、回复正文和错误代码，不保存收到的正文和音频。重复事件和进程重启都按记录继续，不会再次询问模型或重复发送。
- 每次发送前重新核对账号、白名单、插件分配和权限。中途撤销时两种形式都不发送。队列最多 8 条，超出时记录 `VOICE_REALTIME_QUEUE_FULL`。

供应商实测状态：OpenAI Realtime 正式版已按官方 SDK 的事件类型核对；千问、智谱 GLM-Realtime 和阶跃星辰为实验支持，按各自文档通过 `session.update` 切换输出形式，未经供应商实测，请先在设置页用真实密钥测试。测试失败时，结果会附上平台返回的错误码和出错参数。

### DSH 链路

DSH 链路沿用原有会话、人设、上下文和工具。普通聊天或助手的聊天模式下，WeChatAgent 每轮查询该聊天能否发语音（后端可发语音，且该聊天恰好分配了一个启用的语音合成插件）。可以时，提示词附加语音规则，模型可回复 `RESPOND_VOICE: 正文`，见[回复协议](REPLY_PROTOCOL.md)。

- 选择“沿用 DSH 人格 · 普通语音 API”或“沿用 DSH 人格 · Realtime 语音 API”。人格统一在原聊天的会话设置中管理，DSH 负责生成正文并选择回复形式。
- 使用千问 Realtime 时，可以填写识别模型 `fun-asr`，由该连接返回入站语音转写。也可以填写独立识别地址和模型。插件将转写交给同一个 DSH 会话，DSH 选中语音回复时，WeChatAgent 只提交已生成的正文供语音服务朗读。投递 ID 由 DSH 回复的投递 ID 派生。[千问转写事件](https://platform.qianwenai.com/docs/api-reference/qwen-audio-realtime/server-events)
- 合成在提交前确定失败时，用新的投递 ID 改发一次同样的文字。已提交或 50 秒内没有结果时，只核对原投递的回执。
- 本轮不能发语音、正文超过 400 字、含链接或代码块时，`RESPOND_VOICE:` 按普通文字回复处理。文字、沉默、分条和表情的处理不变。
- 此链路修改了 DSH 插件的提示文件。更新后请先执行“准备项目配置”，从托盘完整退出并重开 DSH，再重启 WeChatAgent 后台。

## Helper 后台验证模式

本节为只发语音的独立验证模式。要让 Helper 同时发送文字和语音、接入桥接和 DSH，请使用下文的“Helper 完整后端”。

Helper 的文档记录了其已匹配的 Windows x64 微信 4.2.0.12 在文件传输助手的原生语音发送。此模式使用其插件 SDK 的 `send_voice`，需要单独准备 Helper。请先阅读该项目的使用许可。验证时只让 Helper 连接微信进程，单独启动 WeChatAgent 的 NT 读取器和语音适配器。[Helper 语音文档](https://github.com/Prometheus-first/helper/blob/main/docs/messages/voice.md) · [Helper 许可](https://github.com/Prometheus-first/helper/blob/main/LICENSE)

1. 将 `extensions/wechatagent_voice` 放入 Helper 项目的 `plugins` 目录。准备两个独立令牌。上层使用 `state/voice-send.token`，Helper 桥接使用 `state/helper-voice.token`。生成方法同上，替换目标文件名即可。
2. 在 Helper 的 `bot_config.json` 的 `plugins` 下启用 `wechatagent_voice`，设置 `token_file` 为开发目录内 `state/helper-voice.token` 的绝对路径。默认监听 `127.0.0.1:8777`。若自定义 Helper 插件的 `port`，同步设置 WeChatAgent 开发配置的 `helperVoice.port`。
3. 在开发版的私聊或群聊白名单中添加要发送的聊天。好友和群聊还需在 Helper 的 `wechatagent_voice.allowed_targets` 中列出其原始微信 ID。登录匹配的微信，启动 Helper 并连接该账号。使用开发版已配置的 Python 单独运行 `scripts/reader-api.py`，需要已有的 NT 读取器配置和 `state/wechat-io-config.json`。
4. 运行 `node scripts/hook-onebot.mjs --helper-voice-only --check` 校验版本和账号，通过后运行 `node scripts/hook-onebot.mjs --helper-voice-only`。该模式提供本机发送与状态接口，也会处理已启用 Realtime 模式的聊天语音。

桥接插件需要 Helper 提供 `text.send` 和 `voice.send` 能力。Helper 的插件配置示例中的账号与群 ID 均为占位值。未设置 `allowed_targets` 时默认允许 `filehelper`，设置后只允许列表中的目标。修改后重新加载插件。

```json
{
  "wechatagent_voice": {
    "enabled": true,
    "token_file": "E:/path/to/WeChatAgent/state/helper-voice.token",
    "allowed_targets": ["filehelper", "wxid_example_friend", "123456789@chatroom"]
  }
}
```

使用本机 NT 读取器的 `GET /api/v1/sessions` 可以在同一条记录中核对 `username` 和 `conversationId`。Helper 白名单填 `username`，发送请求的 `conversationKey` 使用 `conversationId`。两处白名单都通过后，才可提交发送或查询结果。

Helper 接受原生提交后，响应会附带 `submitted: true`。适配器优先使用后端返回的本地消息 ID。Helper 插件 SDK 只提供提交结果时，NT 读取器可在提交窗口内核对目标聊天中本账号新发出的类型 `34` 消息。只有唯一一条消息的 SILK 摘要与提交音频相同，且有非零服务器消息 ID，才返回 `confirmed`、`serverMessageId` 和 `receiptSource: "silk-sha256"`。读取器只返回回执元数据。

媒体库缺失、候选不唯一，或同一账号在同一聊天提交相同 SILK 时上一笔投递仍无法区分，查询窗口结束后返回 `unconfirmed`，除非后端能提供确切的本地消息 ID。已确认的旧消息如果出现在新投递前的记录里，会从新回执候选中排除。原投递可按 ID 查询，重复请求不会再次发送。好友和群聊实发需分别核对目标及语音条播放。

## Helper 完整后端（文字与语音，实验）

将发送后端设为 `wechat-helper` 后，文字和语音都经 Helper 发出，桥接、DSH 和 Realtime 链路照常运行。读取和回执仍使用 NT 读取器。本机没有安装 Helper 时无法验证此模式；首次使用请用测试聊天实发核对。

1. 按上文第 1–3 步准备 Helper 和 `wechatagent_voice` 插件。文字和语音共用 `allowed_targets`、会话绑定和操作记录。
2. 在控制台“微信发送方式 → 发送后端”选择“Helper 后台文字与语音（实验）”，并设置 Helper 端口（默认 8777，需与插件的 `port` 一致）。对应开发配置为 `runtime.sender: "wechat-helper"`、`helperVoice.port`，还需 `hook.wechatExecutable` 指向干净的 4.2.0.12 微信客户端。首次加载配置时会创建 `state/helper-voice.token`，将 Helper 插件的 `token_file` 指向它。
3. 用 WeChatAgent 打开微信。此模式不注入 Hook；客户端目录有代理 DLL、已运行其他微信或该进程已加载 WeChatAgent Hook 时会拒绝打开。登录后启动 Helper 并连接该账号，再启动 WeChatAgent。
4. 启动时适配器核对 Helper 版本和账号，并要求 health 同时报告 `nativeTextSend` 和 `nativeVoiceSend`，缺少文字能力时报 `HELPER_TEXT_NOT_READY`，缺少语音能力时报 `HELPER_VOICE_NOT_READY`，后台启动校验失败时报 `HELPER_SENDER_NOT_READY`。

文字单条最多 1023 字节，更长的回复按字符边界拆成多条，每条有自己的投递记录和回执。文字回执与 Hook 后端相同：NT 读取器查到本账号发出、带非零服务器 ID 的同内容消息才算确认。Helper 返回提交结果不明确时只核对回执，不会重发。此后端不支持图片、表情包和文件发送，状态中显示为不可用。原有 `--helper-voice-only` 模式保持不变。

## 实验性前台录音

1. 按[前台模拟输入说明](FOREGROUND_INPUT.md)准备当前账号对应的干净微信 4.2.0.12 x64 客户端，选择 `wechat-input`。将文件传输助手纳入私聊白名单。
2. 准备独立的 [VB-CABLE](https://vb-audio.com/Cable/)。在 Windows 中将 `CABLE Output` 选为默认输入和默认通信输入，确认微信使用这一路麦克风。`CABLE Input` 专用于语音发送，其他程序应继续使用各自的播放设备。程序只读校验设备。
3. 在「微信发送方式」开启「前台录音发语音（实验）」后保存。启动服务后，适配器的 `GET /status` 显示 `foreground_voice_send: true` 时可试发，设备异常见 `foreground_voice_error`。
4. 使用同一个发送接口上传最长 59 秒的 WAV。前台发送器打开文件传输助手，保持右 Alt 录音，并将 PCM 播放到虚拟音频线。首次验收请在文件传输助手中确认出现可播放的语音气泡。

前台路径没有精确的本地消息 ID。操作完成后接口返回 `unconfirmed`，同一投递 ID 不会再次录音。前台占用期间，请避免键鼠操作或切换窗口。

## 发送后端契约

通过账号和版本校验的 4.2.0.12 后端，在 `/WeChatAgent/health` 声明 `nativeVoiceSend: true` 后，适配器才会调用以下接口。沿用现有本机鉴权及账号校验。

- Helper 完整后端另需 `POST /SendTextMsg`，接收 `wxidorgid`、64 位十六进制的 `operationId` 和不超过 1023 字节的 `msg`。重复的 `operationId` 只返回原状态。已提交返回 `{ret:0, state:"accepted"}`；提交结果不明确时返回 HTTP 503 和 `HELPER_TEXT_UNCONFIRMED`。
- `POST /SendVoiceMsg` 接收 `wxidorgid`、UUID 格式的 `operationId`、`silkBase64` 和 `durationMs`。声明 `nativeVoiceProtocol: "silk-receipt-v1"` 的 Hook 同时接收实际微信账号 ID `accountWxid`，并在原生任务中再次核对。旧版读库设置使用带后缀的账号目录名时，适配器会先从已验证的目录名提取实际账号 ID。
- `GET /WeChatAgent/voice-deliveries/<operationId>` 查询本次 Hook 进程的提交状态。语音 Hook 的提交和查询接口返回 `operationId`、`target`、`ret` 和 `state`。`state` 可为 `queued`、`accepted`、`rejected` 或 `uncertain`。适配器持久化投递 ID，遇到丢失的响应时查询原操作。
- 适配器用后端提供的本地消息 ID，或用语音 Hook 的已接受状态和 SILK 指纹，匹配当前账号在目标聊天中新发出且具有服务器 ID 的唯一类型 `34` 消息。

随附 Hook 组件接入上述契约后，须使用合成音频做实发验收，并在微信客户端确认语音气泡可播放。
