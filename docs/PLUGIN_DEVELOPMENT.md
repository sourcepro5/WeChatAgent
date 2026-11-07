# WeChatAgent 插件开发规范 · API v2

本文是 **ZIP 安装插件的现行契约**。可以直接把本文交给开发者或其他模型，用来编写插件。接口版本为 `2`，插件宿主标识为 `wechatagent`。

## 安装者怎么使用

1. 打开 WeChatAgent 的“能力 → 能力目录”。把一个 `.zip` 拖入页面，或点击“安装 ZIP 插件”。
2. 核对名称、版本、作者和权限，点击“确认安装”。安装阶段只检查文件，不运行插件。
3. 在插件卡片点击“配置”，选择授权能力、允许的聊天，勾选“允许此插件运行”，保存。
4. 第一次升级到支持 API v2 的桥接宿主，先执行“准备项目配置”，从托盘完整退出并重开 DSH，再重新打开 WeChatAgent 窗口并重启后台。之后安装、更新和修改设置在空闲时或下一轮聊天自动加载，不必每次重启 DSH。

安装成功不代表已启用，也不代表每个请求都一定会调用工具；工具由当前 DSH 模型按描述选择。助手模式继续遵守管理员限制，普通群友的只读聊天通道不会获得插件任务工具。

**DSH 插件不兼容此 ZIP 接口。** dsh-meme、DSH 技能和 npm 插件仍在 DSH 中安装。旧 API v1 目录包不能作为 v2 ZIP 导入。

## 包目录与文件要求

ZIP 可以直接包含以下文件，也可以只包一层外部目录：

```text
chat-notes/
  plugin.json       必需，UTF-8 JSON 清单
  index.mjs         必需，ESM 入口
  README.md        建议，面向安装者的用法
  lib/             可选，插件自己的 .mjs 模块
  assets/          可选，静态资源；不自动注入前端
```

入口固定为 `index.mjs`，无需 `package.json` 或 npm install。只支持预先打包好的代码，不能在安装时执行命令、下载依赖或运行脚本。依赖应预先合并到入口或放在包内相对路径模块中；不得携带 `node_modules`、`.git`、符号链接和目录链接。

不要依赖 `process.cwd()` 等于插件目录。读取包内静态资源请使用 `new URL('./assets/文件名', import.meta.url)`；ESM 相对 import 按模块所在位置解析。这样启用中的插件也能在 Windows 上正常更新、归档和卸载。

ZIP 最大 8 MiB，解压后最大 16 MiB，单文件最大 4 MiB，最多 128 个 ZIP 条目、8 层子目录，最高压缩比 500。支持标准 ZIP 的 Store / Deflate，不支持加密、分卷和 ZIP64。拒绝绝对路径、`..`、Windows 设备名、ADS、重名文件、文件/目录冲突和校验不符。文件名使用 UTF-8。

每个 ZIP 只包含一个插件。最多安装 32 个插件，同时最多运行 8 个；超过运行限制时会显示加载原因，请停用不使用的插件并重新保存需要运行的插件。

## plugin.json

```json
{
  "id": "chat-notes",
  "name": "聊天小便签",
  "version": "1.0.0",
  "apiVersion": 2,
  "host": "wechatagent",
  "author": "你的名字",
  "homepage": "https://example.com/project",
  "description": "在当前聊天记下、查看和清空便签。",
  "permissions": ["storage"],
  "settings": {"maxNotes": 20},
  "configSchema": {
    "maxNotes": {
      "type": "integer",
      "title": "最多保留便签数",
      "minimum": 1,
      "maximum": 50
    }
  }
}
```

| 字段 | 要求 |
| --- | --- |
| id | 必需，小写字母开头，仅小写字母、数字和 `-`，最多 40 字符；`native-` 保留。更新时保持相同 id。 |
| name / description | 必需，分别为 1–80 / 1–1024 字符。 |
| version | 必需，如 `1.0.0` 或 `1.1.0-beta.1`。 |
| apiVersion / host | 必须分别为 `2` / `wechatagent`。 |
| author / homepage | 可选。作者最多 120 字符；主页只接受 HTTPS，不允许 URL 用户凭据。 |
| permissions | 可选字符串数组，仅接受下表列出的宿主权限，所有声明权限均需授权后才能运行。文档、模型、人设、计划和音频权限会自动合并对应的宿主能力要求。 |
| settings | 可选，完整的默认设置，必须符合 configSchema。 |
| configSchema | 可选，设置字段到 Schema 的映射，最多 24 项。 |
| requiresHostFeatures | 可选，额外所需能力标识数组，与权限推导的要求合并；本机安装宿主不支持时拒绝安装，不能假装兼容。 |
| requiresAccount | 可选布尔值，true 时要求已绑定微信账号才能运行。 |
| schedule | 可选每日计划，格式见后文；需 schedule 权限。 |
| dataNamespace | 仅第一方 fish-notebook 的旧数据兼容声明，其他插件不可指定。 |


未知顶层字段会被拒绝。不要添加 `entry`、`enabledByDefault`、`scripts` 或自行改变宿主。插件不能通过清单默认启用或扩大聊天范围。

设置和工具参数使用 JSON Schema 的受限子集：`type`、`properties`、`required`、`additionalProperties`、`items`、`enum`、`description`、`title`、`default`、`minimum`、`maximum`、`minLength`、`maxLength`、`secret`。支持 object、array、string、number、integer、boolean；嵌套最多 12 层，数组值最多 100 项。未知参数默认拒绝。对象字段名不能为 `__proto__`、`prototype`、`constructor`。

设置页面自动生成字符串、数字、布尔、枚举及 JSON 对象/数组输入。秘密字符串可设置 `secret: true`：管理接口返回空值，留空保存会保留已保存值。插件执行时可读取它自己的真实设置。插件设置属于本机数据，请勿在日志或模型结果中输出密码、令牌。

## 注册模型工具

`index.mjs` 必须导出 `setup(api)`。可以同步或异步，但初始化必须在 2 秒内完成。不要在初始化阶段发网络请求或启动长期任务。

```javascript
export function setup(api) {
  api.registerTool({
    id: 'notes',
    description: '用户明确要求记便签或查看便签时使用，只操作当前聊天。',
    parameters: {
      type: 'object',
      properties: {
        action: {type: 'string', enum: ['add', 'list']},
        text: {type: 'string', maxLength: 1000}
      },
      required: ['action'],
      additionalProperties: false
    },
    async execute(ctx, args) {
      const notes = await ctx.storage.get('notes') ?? [];
      if (args.action === 'list') {
        return {content: JSON.stringify(notes)};
      }
      if (!args.text?.trim()) {
        return {content: '请提供便签正文。', isError: true};
      }
      notes.push({text: args.text.trim(), createdAt: new Date().toISOString()});
      await ctx.storage.set('notes', notes.slice(-ctx.config().maxNotes));
      return {content: '便签已记下。'};
    }
  });
}
```

`api.apiVersion` 固定为 2。工具 id 最多 20 字符，格式与插件 id 相同；每插件最多 16 个工具，不能重复。description 为 1–2000 字符，parameters 必须是 object Schema。最终名称固定为 `<插件id>__<工具id>`，例如 `chat-notes__notes`，避免与 DSH 的 `web_search` 等工具重名。

如果 DSH 仍拒绝某个插件的工具注册（例如其他第三方插件使用了同名工具），会撤回该插件的本次工具注册并显示 `PLUGIN_TOOL_REGISTRATION_CONFLICT`，继续保留其他工具和原会话；更新插件的工具 id 后重新启用即可重试。

`execute(ctx,args)` 可以返回字符串，或 `{content: string, isError?: boolean}`。业务失败请返回 `isError:true` 或抛出 Error。模型会看到工具结果，并通过原有回复链路回复微信。返回值必须能 JSON 序列化；子进程结果上限 64 KiB，交给模型的文字最多 12,000 字符。

每轮最多调用 3 次插件工具，每次最长 8 秒。插件死循环、超时、进程崩溃时，只结束该插件子进程，不归档或废弃 DSH 会话；同一插件在其他聊天中的并发调用也可能失败，但其他插件、文字和后续聊天仍可继续。修正问题后，在插件设置中重新保存启用状态即可重试加载。

## ctx 与权限

所有存储、历史、fetch、reply 操作都是 **异步 API，必须 await**。不等待的副作用可能在本次工具结束时被取消。

| API | 权限 / 返回 |
| --- | --- |
| ctx.apiVersion | 2 |
| ctx.chat | 当前聊天 `{key, platform:'wechat', kind:'private'\|'group', id, name}`。没有跨聊天目标参数。 |
| ctx.actor | `{id}`，当前批次可识别的真实微信发送者；无法确认时为空字符串。它不是管理员授权凭据。 |
| ctx.sessionId | 当前 DSH 会话 id，仅用于关联。 |
| ctx.account / ctx.now | `{id}` 为不含原 wxid 的账号作用域；now 为本次调用开始的毫秒时间。 |
| ctx.config() | 本插件的当前设置副本。 |
| ctx.signal | 本次执行的取消信号；宿主取消或超时后也会终止进程并拒绝新的宿主操作。 |
| await ctx.storage.get(key) | `storage`，读取当前账号 + 插件 + 聊天的数据，不存在返回 null。 |
| await ctx.storage.set(key,value) | `storage`，写 JSON 值，返回 `{ok:true}`。 |
| await ctx.storage.delete(key) | `storage`，删除键，返回 `{ok:true}`。 |
| ctx.actorStorage.get/set/delete | 与 storage 相同，额外按当前发送者隔离。发送者无法确认时拒绝操作。 |
| await ctx.history.recent({limit:20}) | `history_read`，当前聊天最近 1–100 条已收录文字记录。 |
| await ctx.fetch(url,{maxChars:12000,timeoutMs:6000}) | `web_fetch`，公开 HTTP(S) GET，返回标准 Response。 |
| await ctx.reply(text) | `reply`，申请本轮回复，返回 `{queued:true}`，不是即时送达回执。 |
| await ctx.audio.read(id,{format:'wav'}) | `audio_read` + `voice-input-v1`；仅限宿主为本次语音动作绑定的 id，返回有界音频 `{id,b64,mime,filename,sampleRate,durationSeconds}`。format 可为 wav 或 silk；钩子不可调用。 |

存储键只允许 1–64 个英文字母、数字、`_`、`-`；值必须可 JSON 序列化。同一账号下每插件总存储上限 256 KiB。账号、插件、聊天、发送者不能通过参数改成其他目标。

历史只包含 `{id,text,senderId,senderName,timestamp,outgoing}`，不提供数据库密钥、原始路径或附件字节。未收录的旧消息不会自动补抓；每条文字最多 12,000 字符，整批最多 48 KiB，优先返回最新的记录。

fetch 仅接受 maxChars（256–32000）和 timeoutMs（100–7000 毫秒），不接受自定义请求头、请求体或任意代理。宿主检查 DNS、目标 IP 和重定向，拒绝本机/内网。用户本轮明确不允许联网时拒绝请求。Response 的 `X-WeChatAgent-Truncated: true` 表示正文被截断，不要把它当作完整 JSON 使用。

reply 每轮最多 3 项，合计最多 12,000 字符。只有工具与本轮模型任务成功、权限仍有效时，申请才会交给现有 Bridge 发送；失败、取消、停用后的申请丢弃。申请回复会作为本轮最终回复替代模型正文，避免重复发送两套回答。发送仍经过现有去重、聊天权限、限流与微信回执流程。

## 可选钩子与生命周期

```javascript
export const hooks = {
  'before-context': async ctx => ({context: '仅供本轮参考的资料'}),
  'after-response': async ctx => ({})
};
```

- before-context 额外收到 `ctx.message`；返回 `{context:string}` 添加当轮资料，最多采用 4000 字符。它不能替换人格、系统规则、聊天授权或工具权限。
- after-response 额外收到 `ctx.text`；可返回 `{text:string}`，但必须声明并获授权 `reply`，并保留精确的 `SILENT` 或 `RESPOND:` 协议，否则不采用改写。
- 钩子中的宿主 API 只允许读取存储、历史；不允许写存储、联网或申请发送。每插件每类钩子最多 800 毫秒，一类钩子总预算 2 秒，超时终止该插件并跳过，不阻塞本轮其他功能。
- 可导出 `activate()`，只在启用后、子进程初始化时执行。启停通过独立进程创建/结束实现；不要依赖退出清理来保证数据正确。持久数据应在工具成功前通过 storage 写完。
- 当前未提供 MCP 注册、向控制台注入任意 JavaScript（插件自己的隔离页面见文末“自定义页面”）、任意路径文件操作和原生图片/文件发送 API。每日计划、受限模型生成与文档存储见下文；其他任务仍使用已有、已授权的 DSH 能力。

插件在独立 Node 子进程运行，V8 旧生代堆上限为 96 MiB，并有执行时间限制（不是进程总内存硬上限）；宿主不向它传入模型账号密钥或完整环境变量。这是 **故障隔离，不是恶意代码的操作系统沙箱**。Node 代码仍可能直接访问本机文件或系统能力，因此只启用信任的插件。permissions 约束这里列出的宿主 API，不代表 Node 本身的完整权限封锁。

## 可选扩展：动作、文档、当前人设与每日计划

这些是 API v2 的可选能力扩展；只依赖早期基础 API v2 的工具包仍可运行。新包通过 `requiresHostFeatures` 明确声明，例如：

```json
{
  "requiresHostFeatures": ["actions-v1", "documents-v1", "persona-read-v1", "model-utility-v1", "daily-schedule-v1"],
  "requiresAccount": true,
  "schedule": {"timeSetting": "writeTime", "personaScoped": true}
}
```

schedule 的 timeSetting 必须指向 configSchema 中的字符串设置，默认值和保存值都需满足 HH:MM。personaScoped 为可选布尔值，true 时需 persona_read 权限，每日回执额外按人格签名隔离。requiresHostFeatures 的标识可从 GET /api/plugins 的 hostFeatures 查看，实际运行的 DSH 宿主还会在 health 的 pluginHostFeatures 报告；安装后显示“等待新版宿主”时，准备配置并重开 DSH。

### 宿主动作

```javascript
export function setup(api) {
  api.registerAction({
    id: 'write-today', description: '由本机页面主动调用',
    parameters: {type:'object', properties:{}, additionalProperties:false},
    async execute(ctx, args) { return {ok:true}; }
  });
  api.onSchedule(async ctx => ({retryLater:true}));
}
```

每插件最多 16 个动作，id、description、parameters 与工具同样校验，最多执行 35 秒。动作不会自动注册成模型工具，也不构成微信万能命令。通过专用宿主接入或带控制台令牌的 `POST /api/plugins/:id/actions/:action` 调用，正文为 `{key:"wechat:private:123",args:{}}`；仅允许本机已授权聊天。若需要模型调用，请另行注册工具。

动作和每日计划不支持 ctx.reply；返回值由调用它的界面或专用聊天接入决定如何使用，不能借定时计划绕过既有发送流程。

### 新增上下文 API

| API | 权限与限制 |
| --- | --- |
| await ctx.persona() | persona_read；仅本聊天的 `{personaName,persona,digest,signature}`。正文最多 8000 字符；digest 是完整正文的哈希，signature 包含完整人格名与正文，用于旧数据标识兼容。 |
| await ctx.history.today({date,limit:200,maxChars:14000}) | history_read；date 必须为当前北京时间日期。仅返回本聊天当天有限片段 `{who,text}`，不含工具推理、转发/引用展开或其他聊天。 |
| await ctx.documents.get(id) | documents；当前账号、插件、聊天的一份 JSON 对象，不存在返回 null。 |
| await ctx.documents.put(id,value) | documents；单份最多 1 MiB；已有 JSON 损坏时拒绝覆盖。 |
| await ctx.documents.list({offset:0,limit:12}) | documents；每次最多 50 份、整批最多约 1 MiB，保留损坏文件并报告 errors；按 nextOffset 续读。 |
| await ctx.model.generate({prompt,maxTokens:512,maxChars:2000,timeoutMs:25000}) | model_generate；使用当前已配置模型、tools 固定为空，仅返回可见文本，忽略内部推理。 |

文档 id 为 1–120 个英文字母、数字、`_`、`-`，以字母或数字开头；拒绝 Windows 设备名、路径穿越和链接。若文档包含 id / conversationKey / accountScope，必须与当前目标一致。普通文档保存在 `state/plugin-documents/<账号作用域哈希>/<插件id>/<聊天哈希>/`。它和 256 KiB 键值存储分别管理；插件应自行控制历史数量，宿主不擅自删除旧文档。

第一方 fish-notebook 的 `dataNamespace: "fish-notebook-v1"` 专供兼容旧的 `state/fish-notebook/`，不开放任意自定义数据路径，也不允许其他 id 读取该命名空间。这是宿主中唯一按插件 id 绑定的地方：它保护已有日记数据的归属，不用于功能路由。

模型 prompt 最多 32000 字符，maxTokens 为 16–2200，maxChars 为 1–4000，timeoutMs 为 1000–25000 毫秒。每次工具/动作最多 3 次独立模型请求，宿主最多同时处理 2 次；仍受外层工具 8 秒或动作 35 秒限制。支持关闭推理的模型会使用 off；计费及结果记入原聊天用量，不创建普通任务，也不改写主会话。生成和写文档会再次检查当前账号、授权及取消状态。不得把“独立请求”描述成没有模型费用。

每日计划由宿主每分钟检查。后台服务停止、账号变化或当前任务繁忙时等待；到时对已允许的聊天调用 onSchedule。成功回执按账号/插件/聊天/日期保存，personaScoped 时还包含人设签名；处理失败 15 分钟后再试。返回 `{retryLater:true}` 不记为当天完成，例如当天尚无聊天。停止或卸载插件结束新执行，保留文档和调度回执。不要自行创建不受宿主管理的常驻定时器。

鱼的记事本是完整示例，源码在 `optional-extensions/fish-notebook/`，包在 `optional-extensions/packages/fish-notebook-1.1.1.zip`。日记列表和“写下今天”由包内的 `ui/page.html` 提供，通过自己的 `list`、`write-today` 动作读取和生成；宿主不再内置记事本页面或 `/api/fish-notebook` 接口。微信里的日记询问经下文的 `diary-question-v1` 交给它的 `ask` 动作。

### 聊天能力路由

部分宿主能力会把一类微信消息交给插件的固定动作处理。宿主不按插件 id 选择，只看声明：插件需在 `requiresHostFeatures` 中声明该能力（或申请能推导出它的权限）、获得下表权限，并注册同名动作。

| 能力 | 宿主何时调用 | 动作与参数 | 所需权限 |
| --- | --- | --- | --- |
| `voice-input-v1` | 收到已授权聊天的微信语音 | `transcribe`，`{id}`；返回 `{ok,text}` 或 `{ok:false,code}` | `audio_read`（自动推导该能力） |
| `diary-question-v1` | 宿主识别出询问“日记 / 记事本 / 小本本”的消息 | `ask`，`{id,viewer}`（均为 64 位十六进制）；返回 `{handled,text,document}` | `reply` |

同一聊天只能有一个插件处理同一能力。语音有两个候选时返回 `VOICE_PLUGIN_CONFLICT`，并在这些插件卡片上提示；日记询问有两个候选时不交给插件，按普通聊天回复，并在 DSH 日志中记录。没有候选时语音返回 `VOICE_PLUGIN_DISABLED`，日记询问按普通聊天回复。最近一次真实语音结果按处理它的插件保存在 `state/plugin-service-checks/voice-input/<插件id>.json`。

## 打包、更新和卸载

### 可选语音输入能力

`voice-input-v1` 是 API v2 的可选宿主扩展。声明 `audio_read` 以及所需宿主能力后，可在受控动作中读取当前原消息绑定的语音。普通模型工具、本机通用动作接口和钩子不会自动获得语音 id 的绑定。配套示例为 `optional-extensions/speech-recognition/`，完整链路见 [微信语音 API 转写](VOICE_INPUT.md)。申请 `audio_read` 的插件页面可从 `wa.info().voice` 读取宿主的 WAV 转换组件状态和最近一次真实语音结果；插件卡片也只按真实语音结果显示状态。示例通过自己配置的 POST API 转写；这不改变 `ctx.fetch` 原有的公开 GET 限制。插件直接网络请求受其自身超时控制，Node 代码仍属于可信代码。

项目提供校验打包命令：

```powershell
node scripts/pack-plugin.mjs examples/plugins/chat-notes release/plugins/chat-notes-1.0.0.zip
```

它检查清单、入口、链接与限额，再生成标准 ZIP 并再次验证。也可以在 Windows 资源管理器压缩插件目录，或使用：

```powershell
Compress-Archive -Path '.\chat-notes\*' -DestinationPath '.\chat-notes-1.0.0.zip'
```

更新保持 id 不变、递增 version，重新拖入 ZIP 并确认更新。同名包不会悄悄覆盖：旧代码归档，数据及符合新 Schema 的设置保留，权限清空、插件停用，需要重新确认后启用。

卸载只归档代码并移除启用配置，保留插件数据。重新安装相同 id、相同微信账号时，可继续读取保存的数据；不要更换 id 来发布同一插件的更新。

路径均相对于当前 WeChatAgent 工作目录，安装版通常为所选数据目录中的 `workspace/`：

| 内容 | 相对路径 |
| --- | --- |
| 已安装代码 | plugins/插件id/ |
| 本机设置与授权 | config/plugins.json |
| 隔离后的持久数据 | state/plugins/账号作用域哈希/插件id/data.json |
| 旧版和卸载源码 | state/plugin-archives/ |
| 安装预览临时文件 | state/plugin-install-staging/ |

用户安装的代码、配置和运行数据不会自动混进项目发布包。安装器只包含宿主和第一方示例，未默认启用任何第三方插件。

## 本机管理接口

所有 `/api/plugins` 接口使用控制台的 Host/Origin 检查和 `X-Console-Token`，不供微信用户直接调用。

| 方法 / 路径 | 请求 / 结果 |
| --- | --- |
| GET /api/plugins | `{apiVersion:2,revision,plugins,runtimeConnected}`；秘密设置已脱敏。 |
| POST /api/plugins/inspect | `{name:'包.zip',zip:'标准Base64'}`，返回 ticket、revision、插件信息和已安装版本；不执行代码。 |
| POST /api/plugins/install | `{ticket,revision,replace:false}`，确认安装；更新需要 replace:true。 |
| POST /api/plugins/cancel | `{ticket}`，删除对应预览临时文件。 |
| POST /api/plugins/:id | `{revision,enabled,permissions,chats,settings}`；chats:null 为全部已允许聊天，[] 为不分配。 |
| POST /api/plugins/:id/uninstall | `{revision}`，归档代码，保留数据。 |
| POST /api/plugins/:id/settings-actions/:action | `{packageRevision,args}`，运行 ui.json 中声明的设置动作（见“设置动作”），返回动作结果。 |
| GET /api/plugins/:id/host-status | 申请 `audio_read` 的插件返回 `{voice:{decoder,lastAttempt}}`，其他插件返回 `{}`。 |

预览 ticket 有效 10 分钟，同一控制台最多保留 4 份。提交使用插件配置 revision 检查冲突，409 时重新读取列表或重新选择 ZIP，不要强行覆盖。

## 开发验收清单

安装管理、DSH 宿主、插件子进程与前端的权限和能力声明统一来自 `packages/plugin-api/contract.mjs`。控制台返回本机契约与实际 DSH 契约，安装预览提示运行宿主缺失的能力；已连接但过旧的 DSH 不能启用不兼容插件。需要账号的插件在账号未绑定时不会初始化。宿主与 worker 契约不一致时，报告 `PLUGIN_HOST_CONTRACT_MISMATCH` 并停止该插件，请完整重开 DSH。

发布前运行 `node scripts/plugin-host-check.mjs`；对照另一版本可使用 `--compare <另一个项目目录>`。此检查不执行插件代码，会核对宿主文件、共享声明、第一方插件的权限/能力、ZIP 与源码及校验值。安装器构建前后和公开源码检查均调用此检查，避免只更新开发目录或遗漏安装模板文件。

第一方 ZIP 重新生成使用 `npm run plugin:pack`；公开 Git 工作区的源码包使用 `npm run source:build`，先执行宿主及隐私校验，再生成来源哈希。Python 边界测试可通过环境变量 `WECHATAGENT_TEST_PYTHON` 指定解释器，避免依赖本机私有配置或占位的 `python` 命令。

- ZIP 根目录或单层目录中含合法 plugin.json 和 index.mjs；没有 npm 安装步骤。
- 安装后未启用时，不产生任何代码执行或网络请求；唯一例外是用户在设置页勾选“允许此插件运行”后主动触发的设置动作。
- 为一个聊天启用后能调用工具；其他聊天、账号和未授权发送者不越权。
- 所有宿主 API 都 await，输出为可序列化且有界的结果。
- 工具失败、超时、死循环、插件退出后，仍可继续发送普通文字。
- 更新、停用、重新启用、卸载后，数据保留且权限状态符合预期。
- README 写清功能、触发示例、权限用途、数据范围和版本要求，不声称整个 DSH/npm 插件直接兼容。

维护者可运行：`node --test scripts/test-plugin-api.mjs`。完整便签示例见 [examples/plugins/chat-notes](../examples/plugins/chat-notes/)。


## 可选的包内配置页面说明

在 ZIP 根目录加入 `config-ui.json`，新版宿主会在每次打开设置时读取当前安装包中的描述；没有此文件的旧插件使用当前 `configSchema` 生成标准表单。旧宿主会忽略此文件，不影响原有动作、权限和配置字段。

```json
{
  "version": 1,
  "description": "填写服务连接信息。",
  "sections": [
    {"id": "basic", "title": "基本设置", "fields": ["endpoint", "apiKey"]},
    {"id": "advanced", "title": "高级设置", "fields": ["timeoutMs"], "advanced": true}
  ],
  "fieldOptions": {
    "endpoint": {"label": "服务地址", "placeholder": "粘贴平台提供的地址", "help": "保留平台要求的路径前缀。"}
  }
}
```

页面说明最多 32 KiB、8 个分区；字段必须来自插件的 `configSchema`，不能重复。未分组的字段仍会显示，避免丢失设置。`fieldOptions` 支持 `label`、`help`、`placeholder` 和与枚举一一对应的 `enumLabels`。不支持 HTML、脚本、远程资源、路径跳转或新的宿主权限；秘密字段仍由 Schema 的 `secret` 决定。说明不合法时回退标准表单，显示错误提示，不执行插件代码。

`config-ui.json` 只描述分区和文案，不提供按插件 id 区分的控件或检测。旧版语音插件使用的 `widget` 与 `diagnostics` 字段已移除；仍声明它们的包会回退标准表单。需要模型下拉、连接测试等交互时，请改用下文的自定义设置页面和设置动作。

更新 ZIP 后，页面按新包的说明与 Schema 重建。卸载会取消页面请求、销毁表单和监听器、清除检测状态；迟到回调不能重新打开旧页面。日记、插件文档等独立用户数据继续保留。首次使用此页面文件需要应用宿主加载器修复一次，后续布局与文案可以只更新 ZIP。

## 自定义页面（沙箱 iframe）

需要比自动表单更自由的界面时，插件可以自带 HTML/CSS/JS 页面。在 ZIP 根目录加入 `ui.json`，页面文件全部放在 `ui/` 目录：

```text
chat-notes/
  plugin.json
  index.mjs
  ui.json
  ui/settings.html   设置页面（替代自动表单）
  ui/page.html       独立页面（插件卡片上的“打开”）
  ui/*.js / *.css / 图片 / 字体
```

```json
{
  "version": 1,
  "settings": {"entry": "settings.html", "height": 420},
  "page": {"entry": "page.html", "title": "聊天小便签", "description": "按聊天查看和删除便签。"}
}
```

- `settings` 与 `page` 至少声明一个；`entry` 是 `ui/` 下的相对路径，必须为已存在的 `.html`。`height` 为设置页初始高度（120–2000），使用 SDK 时会按内容自动调整。`title` 最多 40 字符，`description` 最多 200 字符。
- `ui.json` 只由控制台读取，不改变 `plugin.json` 契约，也不需要重开 DSH；旧宿主会忽略它。声明无效或文件缺失时，显示提示并回退到标准表单。
- 有设置页面时，宿主仍在页面上方显示启用开关、授权能力与聊天范围；插件页面只负责插件自己的设置字段。
- `settings.actions`（可选，最多 8 个）列出设置页可调用的**设置动作**，例如读取模型、测试连接。它们必须同时在 `index.mjs` 中用 `registerAction` 注册。

### 设置动作

设置页需要联网测试或校验时，页面不能自己请求（`connect-src 'none'`），而是调用声明过的设置动作：

```json
{"version": 1, "settings": {"entry": "settings.html", "actions": ["models", "check"]}}
```

- 只能从本插件的设置页调用，且只在用户勾选宿主的“允许此插件运行”后执行（无需先保存、启用或分配聊天）。未声明的动作仍走下文的聊天动作规则。
- 每次调用启动一个短时 Node 子进程，最长约 35 秒，结束即退出；同时最多 2 个。`ctx.mode` 为 `'settings'`，`ctx.settings` / `ctx.config()` 为**已保存**的设置（含秘密值）；没有聊天、账号、存储、文档、历史、语音、模型和回复等宿主服务，调用会报错。
- 页面把未保存的草稿作为参数传入。秘密字段在页面中始终为空，约定空字符串表示“沿用已保存值”，由插件自己合并；返回值不要包含密钥。参数按动作的 `parameters` 校验，可直接复用 `configSchema`。
- 结果不持久化在宿主中。安装、更新或卸载插件会取消仍在运行的设置动作。
- 完整示例：`optional-extensions/speech-recognition/` 的 `ui/settings.js` 与 `lib/settings-actions.mjs`。

### 运行环境与限制

页面以 `sandbox="allow-scripts allow-forms"` 的 iframe 加载，服务器再以 CSP `sandbox` 强制成为隔离来源：

- 只能加载本插件 `ui/` 下的脚本、样式、图片、字体和音频；**不能内联 `<script>`**，样式允许内联。
- `connect-src 'none'`：不能 `fetch`/WebSocket，也不能访问控制台 `/api/*` 或令牌。需要联网时在 `index.mjs` 的动作里使用 `ctx.fetch` 或插件自己的网络请求。
- 不能弹出窗口、跳转顶层页面、提交表单到其他地址、嵌套 iframe 或使用 Worker；没有 Cookie、localStorage 等持久存储，数据请通过动作写入 `ctx.storage` / `ctx.documents`。
- 页面地址包含随控制台令牌和插件包变化的随机段，更新或卸载插件后旧页面立即失效。

### SDK 与宿主接口

在页面脚本中 `import wa from './__sdk.mjs'`（宿主提供，无需打包）。SDK 只是下列 postMessage 协议的封装，所有接口都绑定当前插件，不能指定其他插件：

| SDK | 说明 |
| --- | --- |
| `await wa.info()` | `{pluginId, name, version, enabled, active, status, mode:'settings'\|'page', chats:[{key,name}], settingsActions, runAllowed}`。chats 为本插件已分配的聊天；settingsActions 为设置页可用的设置动作，runAllowed 表示打开时是否已勾选“允许此插件运行”。申请 `audio_read` 的插件另有 `voice:{decoder:{checked,decoder}, lastAttempt}` |
| `await wa.settings.get()` | `{values, schema}`；秘密字段始终为空字符串 |
| `await wa.settings.save(values)` | 只保存设置字段，按 configSchema 校验；秘密字段留空保留原值。不改变启用、权限和聊天范围 |
| `await wa.actions.call(id, args, {key})` | 调用本插件 `registerAction` 注册的动作；key 必须是 chats 中的聊天（只有一个聊天时可省略）。插件需已启用并被 DSH 加载，最长约 35 秒。设置页调用 `settings.actions` 中的动作时不需要 key，见“设置动作” |
| `wa.onCollect(fn)` | 设置页专用：用户点“保存插件设置”时调用 `fn({enabled})`（enabled 为保存后是否启用），返回要保存的设置对象，抛错则阻止保存并显示错误；可在其中调用不联网的设置动作做启用前校验，10 秒内需返回。未注册时保留已保存的设置 |
| `wa.ui.resize(h)` / `wa.ui.autoResize(false)` | 设置页高度（120–2000）；默认按内容自动调整 |
| `wa.ui.toast(text)` / `wa.ui.close()` | 显示宿主提示（最多 200 字符）；关闭设置窗口或离开独立页面 |
| `wa.on('theme', fn)` | 设置页另有 `wa.on('run-allowed', fn)`：用户勾选或取消“允许此插件运行”时收到 `{runAllowed}`。主题变化事件。SDK 会自动设置 `html[data-theme]` 和 `--wa-bg`、`--wa-surface`、`--wa-text`、`--wa-muted`、`--wa-border`、`--wa-accent`、`--wa-on-accent`、`--wa-error`、`--wa-radius`、`--wa-body-font` 等 CSS 变量 |

不使用 SDK 时，可直接与 `parent` 收发消息：页面请求 `{wa:1,type:'request',id,method,params}`，宿主回复 `{wa:1,type:'response',id,ok,result|error}`；宿主请求（如 `collect`）格式相同，由页面回复；宿主事件为 `{wa:1,type:'event',event,payload}`。方法名为 `host.info`、`settings.get`、`settings.save`（params `{values}`）、`actions.call`（params `{action,args,key}`）、`ui.resize`、`ui.toast`、`ui.close`。

页面仍是本机可信代码的一部分：沙箱阻止它读取控制台和其他插件，但动作在 Node 子进程中运行，权限规则与前文一致。完整示例见 [examples/plugins/chat-notes](../examples/plugins/chat-notes/) 的 `ui/` 目录。
