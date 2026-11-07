# 语音识别 API 插件 1.5.0

按公共 HTTP 协议接入语音服务，采用与 DeepSeek Harness 相同的配置思路：**协议、API 基础地址、模型 ID 各自独立**。模型名字只作为参数传给平台，不用于猜测服务商、改写地址或选择请求格式。平台使用自定义模型别名也能接入，无需给每个模型增加适配代码。

这是可独立导入的 WeChatAgent API v2 插件，需要宿主支持 `voice-input-v1`、`actions-v1` 和 `audio_read`。

## 1.5.0 插件自带设置页

配置页改由本包的 `ui/settings.html` 提供（`ui.json` 声明），在宿主的沙箱 iframe 中运行；模型下拉、读取模型、测试识别和高级设置都在包内，宿主不再有语音专用代码。页面不能联网，读取模型、测试识别和启用前校验通过本包的设置动作 `models`、`check`、`validate` 完成，代码见 `lib/settings-actions.mjs`。

- 先勾选上方“允许此插件运行”，即可读取模型和测试；无需先保存、授权读取语音或选择聊天。
- 密钥栏不显示已保存的值，留空即沿用；结果中不会回显密钥。已保存的设置和密钥升级后原样保留。
- 勾选启用并保存时，页面先离线检查配置格式，有误时阻止保存。
- 需要支持插件设置动作的控制台（2026-11-04 起的插件页面宿主）；更早的宿主会忽略 `ui.json` 或无法运行检测，回退标准表单，转写功能不受影响。`config-ui.json` 已删除。

## 1.4.2 模型下拉修复

读取模型后，可通过独立下拉框查看所有语音候选。已有模型 ID 不会过滤列表，选择后会填入模型栏。修改服务地址或鉴权设置会清除上一次的候选。下拉控件由 WCA 绘制，旧宿主需要更新到包含此修复的版本。

## 1.4.1 页面卸载与更新修复

ZIP 自带 `config-ui.json` 声明配置布局和文案。应用一次配套宿主页面加载修复后，每次打开会读取当前安装包的页面说明；卸载会取消旧页面请求、销毁表单和监听器、清空接口检测状态，重装从新包重建页面。页面说明只允许受限 JSON，不运行插件网页脚本。日记、文档和聊天资料继续保留。

旧宿主会忽略这个可选 JSON，仍可使用转写功能；只有宿主页面加载修复需要应用一次。1.4.0 的公共协议规则保持不变。

## 新手使用：填写三项，再测试

1. 在“能力 → 能力目录”导入 `speech-recognition-1.5.0.zip`，打开配置并勾选“允许此插件运行”。填写平台提供的 **服务地址、API 密钥、模型 ID**。无需密钥的本机服务可以留空 Key。
2. 可点“连接并读取模型”后选择模型，也可以直接粘贴模型 ID。模型目录读取是 GET 请求，不上传语音，不自动选模型。目录接口不存在时，手动填写同样可用。
3. 点击“测试识别（内置短句）”。测试成功后，勾选启用、读取语音权限和需要使用的聊天并保存。

服务地址请从平台文档原样复制，包含它要求的 `/v1`、版本号及网关前缀。例如平台基础地址是 `https://gateway.example/team/v1`，就填写整个地址。插件不会自动增加 `/v1`，也不会换域名。API 密钥只粘贴 Key 本身，不带 `Bearer`、引号或 `API_KEY=`。模型栏填写名字或别名，不填写网址。

默认 `auto` 用于**文件转写协议**。如果平台文档要求 Chat 音频，可以直接填写完整的 `/chat/completions` 地址，或在 API 协议中选择 `openai-chat`。平台要求 Data URL 时，选择 `chat-audio-data-url`。不要因为模型名字相同，就认定两个平台提供相同接口。

标准协议自动生成鉴权、请求格式并提取文字，不用编写 JSON。音频默认 WAV，其他高级参数通常保留默认即可。测试仅发送插件附带的“语音识别测试”短音频，可能使用平台额度。

## 按接口文档选择协议

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

读取模型列表成功，仅表示目录可用。真正的音频支持以短句测试和实际转写结果为准。401 检查密钥，403 检查权限，404 检查协议及地址（尤其是 `/v1` 和网关前缀），429 检查额度。失败不会轮换协议、地址或模型重复上传语音。

公共协议依据：[OpenAI 官方文件转写协议](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create)、[OpenAI 官方 Chat 音频协议](https://developers.openai.com/api/docs/guides/audio-chat-completions)。Data URL 是兼容扩展，是否支持以平台文档为准。

## 从旧版升级

导入 ZIP 更新同名插件即可。宿主会按已有安装规则暂停启用；检查配置后重新授权并启用，不需要卸载或覆盖安装主程序。更新不会自动启用、处理历史语音或重启 WCA、微信、DSH。

已明确选择的协议、已经保存的自定义 JSON 模板、字段映射和鉴权设置继续生效。1.4.0 移除了依据模型名字自动切换厂商原生路径的行为：以前仅靠 `auto` 和模型名完成特殊匹配的配置，需要按平台公开接口重新选择协议。只有基础地址、默认字段和 `auto` 的配置，现在统一表示文件转写；旧私有完整地址应明确选择 `custom`。

**1.5.0 之前的宿主页面文案与检测代码不会随 ZIP 更新。** 它可能仍显示旧的“常见模型预设”文案，或对新协议规则给出不同的测试结果。可将“服务类型”选为“保留自定义配置 / 高级设置”，然后在 API 协议中明确选文件转写或 Chat 音频，并填写对应地址。实际微信语音由 ZIP 内的新版插件处理；这次不替换宿主页面或检测代码。

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
node scripts/pack-plugin.mjs optional-extensions/speech-recognition optional-extensions/packages/speech-recognition-1.5.0.zip
node --test scripts/test-speech-recognition.mjs scripts/test-speech-protocol.mjs scripts/test-speech-diagnostics.mjs scripts/test-speech-setup.mjs scripts/test-speech-plugin-standalone.mjs
```

测试只使用合成音频、本机模拟服务及临时宿主副本。独立 ZIP 测试会安装和调用插件，再核对宿主文件哈希，验证插件无需修改宿主即可运行。设置页测试见 `scripts/test-plugin-ui-lifecycle.mjs`（经控制台运行设置动作）与 `scripts/test-speech-setup.mjs`（页面边界）。
