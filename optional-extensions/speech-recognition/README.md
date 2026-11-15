# 语音识别 API 插件 1.6.0

把微信语音转成文字交给 AI 处理。选平台、粘贴密钥、点测试，三步就能用。

这是可独立导入的 WeChatAgent API v2 插件，需要宿主支持 `voice-input-v1`、`actions-v1` 和 `audio_read`，以及插件自带设置页（2026-11-04 起的插件页面宿主）。

## 三步上手

1. 在“能力 → 能力目录”导入 `speech-recognition-1.6.0.zip`，点击插件卡片的“配置”，勾选页面上方的“允许此插件运行”。
2. **第 1 步**：在“语音识别平台”中选择你的平台，地址、请求方式和推荐模型会自动填好。按页面上的网址创建 API 密钥，粘贴到“API 密钥”栏。
3. **第 2 步**：一般保留推荐模型即可，也可以点“连接并读取模型”从完整列表中选择。
4. **第 3 步**：点击“测试识别（内置短句）”。显示“配置已验证”后，按第 4 步提示，在“授权能力与聊天”中勾选“读取当前微信语音”并选择聊天，然后点“保存插件设置”。

## 平台对照表

| 平台 | 服务地址（自动填写） | 推荐模型 | 获取密钥 |
| --- | --- | --- | --- |
| 硅基流动 SiliconFlow | `https://api.siliconflow.cn/v1` | `FunAudioLLM/SenseVoiceSmall`、`TeleAI/TeleSpeechASR` | https://cloud.siliconflow.cn/account/ak |
| 阿里云百炼（千问 ASR） | `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions` | `qwen3-asr-flash` | https://help.aliyun.com/zh/model-studio/get-api-key（按说明在控制台创建，北京地域） |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini-transcribe`、`gpt-4o-transcribe`、`whisper-1` | https://platform.openai.com/api-keys |
| Groq | `https://api.groq.com/openai/v1` | `whisper-large-v3-turbo`、`whisper-large-v3` | https://console.groq.com/keys |
| 本机语音服务 | `http://127.0.0.1:8000/v1`（按你的端口修改） | 按服务填写 | 通常不需要 |
| 其他 OpenAI 兼容平台 | 从平台文档复制，通常以 `/v1` 结尾 | 按平台文档填写 | 平台控制台 |

- 硅基流动、OpenAI、Groq 和本机服务使用标准文件转写接口（`/audio/transcriptions`）。
- 阿里云百炼按[千问 ASR 官方文档](https://help.aliyun.com/zh/model-studio/qwen-asr-api-reference)的 OpenAI 兼容格式发送：`content` 中只有一项 `input_audio`，音频为 `data:audio/wav;base64,...`，结果读取 `choices.0.message.content`。业务空间专属地址 `https://<业务空间ID>.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions` 也可以直接粘贴。
- 平台只是“帮你填好字段”的快捷方式，填好的值都可以在高级设置里看到和修改。插件不会根据模型名字猜平台。

## 1.6.0 新手优化

- **选平台代替选协议**：设置页第一项改为“语音识别平台”，内置上表预设。原来的“服务类型/API 协议”移到高级设置并改名为“请求协议”，“Anthropic Messages”选项不再显示（已保存的配置仍保留）。
- **自动整理密钥**：粘贴时自动去掉 `Bearer `、引号、`API_KEY=` 之类的变量名、`Authorization:` 和多余的空格换行，并提示去掉了什么。
- **检查服务地址**：填写时即时提示常见错误，并提供一键修正：缺少 `https://`、贴成了平台网页控制台地址、贴成了 API 密钥、网络服务使用了 `http://`、只有域名缺少 `/v1`、贴成 `/models` 等其他接口、已知平台路径不对、含全角符号或多余空格。
- **测试时自动换请求方式**：内置短句测试如果因请求格式被拒绝（HTTP 400/404/405/415/422 或找不到转写结果），会依次尝试文件转写、Chat 音频（Base64）、Chat 音频（Data URL），最多共发送 3 次，成功后把可用的方式填入设置，保存后生效。鉴权失败、额度不足、超时和网络错误不会换方式重试。自定义请求不会被自动替换。只使用插件自带的测试音频，不涉及聊天语音。
- **模型更好找**：选择平台后直接列出推荐模型；读取完整列表时，名字像语音识别模型的排在“推荐”分组，其余放在“其他模型”。排序只影响显示，不影响请求。
- **步骤更清楚**：“连接并读取模型”移到第 1 步；没勾选“允许此插件运行”时按钮变灰并说明原因；测试成功后显示第 4 步保存指引；高级设置按请求格式、返回结果、鉴权、模型列表、限制与缓存分组。
- 实际微信语音的转写逻辑（`lib/recognize.mjs`）与 1.5.0 相同，已保存的设置与密钥升级后原样保留。设置页不能打开外部网页，获取密钥的网址需复制到浏览器打开。

## 1.5.0 插件自带设置页

配置页改由本包的 `ui/settings.html` 提供（`ui.json` 声明），在宿主的沙箱 iframe 中运行；模型下拉、读取模型、测试识别和高级设置都在包内。页面不能联网，读取模型、测试识别和启用前校验通过本包的设置动作 `models`、`check`、`validate` 完成，代码见 `lib/settings-actions.mjs`。密钥栏不显示已保存的值，留空即沿用；结果中不会回显密钥。勾选启用并保存时，页面先离线检查配置格式，有误时阻止保存。

## 请求协议说明（高级设置中的“请求协议”）

| API 协议 | 适用接口 | 请求与结果 |
| --- | --- | --- |
| `auto`（默认） | 基础地址或完整识别地址 | 基础地址默认文件转写；完整 `/chat/completions` 使用 Chat 音频；保留旧自定义请求 |
| `openai-transcriptions` | OpenAI 兼容 `/audio/transcriptions` | multipart 上传 `file`、`model`，可选 `language`；读取 `text` 或纯文本结果 |
| `openai-chat` | OpenAI 兼容 `/chat/completions` | JSON `messages`，`input_audio.data` 为 Base64、`format` 为 `wav`；读取消息文字 |
| `chat-audio-data-url` | 要求 Data URL 的 Chat 音频扩展 | 同一 Chat 路径；`input_audio.data` 为 `data:audio/wav;base64,...` |
| `custom` | 平台私有 HTTP POST 接口 | 按已有模板、字段和结果路径调用完整地址 |
| `anthropic-messages` | Anthropic 原生模型目录 | 支持原生鉴权及模型发现；标准 Messages 不是本插件的音频转写入口 |

标准协议在基础地址后追加上表路径；已填写对应完整路径时不再追加。显式协议与完整路径冲突时会在读取聊天语音前报错。网关前缀及查询参数保留，模型列表由相同基础地址追加 `/models`；可用 `modelsEndpoint` 配置特殊列表地址。

模型目录支持标准 `data` 数组、字符串 ID 列表及 `models` 对象映射。映射键保留为可调用别名。没有音频能力信息的模型仍可选择，但需要测试确认；目录明确声明只接受文本或只走 WebSocket 的模型不会被推荐为 HTTP 音频候选。不会从模型名字推断这些能力。

读取模型列表成功，仅表示目录可用。真正的音频支持以短句测试和实际转写结果为准。401 检查密钥，403 检查权限，404 检查协议及地址（尤其是 `/v1` 和网关前缀），429 检查额度。实际微信语音失败时不会轮换协议、地址或模型重复上传；只有设置页的内置短句测试会按上文规则尝试其他标准请求方式。

公共协议依据：[OpenAI 官方文件转写协议](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create)、[OpenAI 官方 Chat 音频协议](https://developers.openai.com/api/docs/guides/audio-chat-completions)。Data URL 是兼容扩展，是否支持以平台文档为准。

## 从旧版升级

导入 ZIP 更新同名插件即可。宿主会按已有安装规则暂停启用；检查配置后重新授权并启用，不需要卸载或覆盖安装主程序。更新不会自动启用、处理历史语音或重启 WCA、微信、DSH。

已明确选择的协议、已经保存的自定义 JSON 模板、字段映射和鉴权设置继续生效。1.4.0 移除了依据模型名字自动切换厂商原生路径的行为：以前仅靠 `auto` 和模型名完成特殊匹配的配置，需要按平台公开接口重新选择协议。只有基础地址、默认字段和 `auto` 的配置，现在统一表示文件转写；旧私有完整地址应明确选择 `custom`。

从 1.5.0 升级到 1.6.0 时，设置页会按已保存的地址自动显示对应平台，不会改动任何设置；只有你在“语音识别平台”中重新选择时才会填入预设值。没有插件页面能力的旧宿主会忽略 `ui.json`，使用标准表单，转写功能不受影响。

## 高级自定义请求

只有平台使用私有接口时，才将 `apiProtocol` 设为 `custom`。此时 `endpoint` 是完整 POST 地址，不自动拼接路径。

- `requestMode: multipart`：使用 `fileField`、`modelField`、`languageField` 配置字段名。`extraFieldsJson` 是额外参数对象。
- `requestMode: json`：在 `jsonTemplate` 填写 JSON 模板。支持 `{{audio_base64}}`、`{{audio_data_url}}`、`{{model}}`、`{{language}}`、`{{filename}}`、`{{mime_type}}`、`{{sample_rate}}`、`{{audio_bytes}}`。
- `responseMode: json`：`responsePath` 指定文字位置，如 `text`、`data.text`、`results.0.text`；空路径表示根值本身是文字。纯文本响应可选 `responseMode: text`。
- `authHeader`、`authPrefix`、`headersJson` 支持自定义鉴权。multipart 的 Content-Type 和 boundary 由运行时生成，不要手工设置。

模板先解析 JSON 再替换值，不执行代码或表达式；独占一个值的数字占位符保留数字类型。Chat 协议可用 `extraFieldsJson` 增加平台要求的参数，不能覆盖 `model`、`messages` 或 `stream`。标准协议要求非空模型 ID；自定义请求可按平台约定省略模型字段。

本插件不实现动态签名、异步轮询或实时 WebSocket。此类服务需要平台提供兼容的 HTTP 网关。仅有网址、Key 和模型名无法改变平台实际使用的协议。

## 运行边界

只处理宿主绑定的当前账号、当前授权聊天的新语音。`audio_read` 不能读取任意文件、其他聊天或任意下载地址。宿主读取微信音频后，插件只向配置的服务上传；识别文字交给原聊天流程处理。

默认 WAV，需要宿主已有的微信 SILK 转 WAV 能力；平台接受微信原始音频时可选 `silk`。不下载识别模型，不新增 Python、GPU 或服务商 SDK 依赖。支持 HTTPS 和本机回环 HTTP，禁止 URL 账号密码和自动重定向。

最长语音 60 秒，音频上限由宿主限制为 2 MiB。API 默认 20 秒超时，可设 1–25 秒；响应最多 64 KiB，转写文字最多 4000 字符。不自动重试。进程内缓存最近 128 项，按账号、聊天、语音和完整配置隔离，不落盘保存音频或转写缓存。失败保留明确状态，不编造语音内容。

默认服务地址、Key、模型均为空。ZIP 不含真实凭据或聊天数据，交付不会安装或启用插件。

## 开发与验证

在项目根目录运行：

```powershell
node scripts/pack-plugin.mjs <本插件源码目录> release/plugins/speech-recognition-1.6.0.zip
```

测试只使用合成音频、本机模拟服务及临时宿主副本。独立 ZIP 测试会安装和调用插件，再核对宿主文件哈希，验证插件无需修改宿主即可运行。设置页测试见 `scripts/test-plugin-ui-lifecycle.mjs`（经控制台运行设置动作）与 `scripts/test-speech-setup.mjs`（页面边界）。
