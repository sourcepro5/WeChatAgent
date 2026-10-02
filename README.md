# WeChatAgent

基于 Windows 个人微信、OneBot v11 与 DeepSeek Harness（DSH）的 AI 聊天整合项目。为白名单好友和群聊提供人格化文字回复、图片理解及独立会话上下文。

本项目是第三方整合实现。提及微信、WeChat、DeepSeek、WeFlow 等名称用于说明依赖和兼容性，不表示获得相关权利人的官方授权、合作或背书。

**发布须知：** 仓库包含不同许可的组件，不能将整套项目统一描述为 MIT。本源码副本已排除第三方 Hook、预编译资源、客户端、历史数据与私人人格；完整运行仍需用户独立准备获授权的外部组件。具体范围见 [许可证与来源](LICENSES.md) 和文末的[版权与发布范围](#版权与发布范围)。README 的说明不能代替授权。

## 功能

| 功能 | 当前实现 |
| --- | --- |
| 好友私聊 | 仅处理白名单好友，支持自动文字回复 |
| 群聊参与 | 支持白名单、昵称提示／唤醒词识别，以及 `hybrid`、`mention` 两种模式 |
| 人格卡 | 使用 Markdown 文件，可按好友或群分别指定 |
| 独立上下文 | 每个聊天使用独立 DSH 原生 session，自动设置会话名称 |
| 人格复用 | 初始化、人格变化或压缩后补入一次，正常续聊只追加新消息 |
| 会话归档 | 当前 session 被归档后，后续消息创建新会话，旧记录保留在归档中 |
| 图片理解 | 白名单普通图片从本机文件解码，经 DSH 原生附件交给支持图片的模型 |
| 表情包理解 | 接收类型 47 的表情包，校验原消息摘要；动画使用有限的采样画面 |
| 拍一拍回应 | 收到别人拍群友账号时触发文字回复；群成员互拍不唤醒 |
| 图片消耗控制 | 成功识图后释放后续请求中的图片输入，保留原生附件记录 |
| 后台文字发送 | 通过自备的匹配版本 Hook 调用发送，不使用鼠标、键盘、剪贴板或窗口切换 |
| 回执核验 | 等待新的匹配发出记录及非零服务器消息 ID，再确认发送成功 |

当前未接入联网搜索、语音／视频理解、图片发送、文件发送、主动拍一拍和原生引用回复。群友会话的模型侧工具执行受限制；图片与表情包直接作为附件输入。

## 架构

```text
已授权的本机微信数据
  → NT 读取 API / SSE
  → 微信 OneBot 适配器
  → Social Bridge：白名单、消息缓冲、人格和发言规则
  → 已有 DSH 桌面端：原生 session 与模型推理
  → OneBot 文字发送动作
  → 自备原生发送后端
  → 微信发出记录与服务器消息 ID 核验
```

默认读取方式为 `nt`：外层 Python API 调用 `weflow-cli` 的 NT 读取模块。默认启动流程不打开 WeFlow 桌面界面。此副本保留默认读取与微信协议所需源码子集，不包含原 WeFlow 界面或历史整合目录。

## 运行要求

| 项目 | 要求 |
| --- | --- |
| 操作系统 | Windows x64；当前生命周期管理脚本使用 PowerShell |
| Node.js | 22.13 或更高，建议使用 24 系列 |
| Python | 3.10 或更高，需能安装固定版本的读取依赖 |
| DSH | 已安装的 DeepSeek Harness 桌面端，支持本地插件和原生 session API |
| 模型 | DSH 中已配置可用的 provider／model；图片理解还要求图片输入能力 |
| 微信 | 用户独立取得的、合法可用且与发送实现匹配的 Windows 客户端 |
| 原生发送后端 | 当前代码固定适配 `4.1.10.27`，需单独准备并核实授权 |
| 读取凭据 | 本机账号、数据库目录及有效读取凭据，需由用户完成授权配置 |

当前 Hook 适配以 [aixed/WeChat-Hook](https://github.com/aixed/WeChat-Hook) 的固定提交 `e905d07ade50d2c6472e4eb3bd4f3fe19cf662c6` 为基础。本项目没有提供通用的新版微信适配，修改配置中的版本号不能替代接口适配。版本登录可用性需要在实际账号和环境中验证。

微信客户端、DSH 安装程序及本机凭据不属于公开源码发行内容。用户应独立遵守相应软件许可、服务条款和数据访问要求。

## 安装与准备

### 1. 获取源码并核对组件

在项目根目录打开 PowerShell。默认运行需要以下文件存在：

- `components/qq-bridge/src/social-bridge.js`
- `components/weflow-cli/scripts/nt_decrypt.py` 与 `nt_common.py`
- `packages/dsh-social-bridge-plugin/index.js`
- 对应组件的 `LICENSE` 文件

第三方组件来源记录在 [components.json](components.json)。此副本采用附带许可、来源版本和裁剪说明的普通源码 vendor 目录，没有内嵌 Git 仓库。

### 2. 创建本机配置

```powershell
if (-not (Test-Path -LiteralPath .\config\wechatagent.json)) {
    Copy-Item -LiteralPath .\config\wechatagent.example.json -Destination .\config\wechatagent.json
}
```

编辑 `config/wechatagent.json`：

| 设置 | 用途 |
| --- | --- |
| `runtime.python` | Python 命令或解释器完整路径；使用 Conda 时填写对应环境的解释器 |
| `runtime.dshDesktop` | DSH 桌面程序路径，或手动先打开 DSH |
| `account.nicknames` | 账号在聊天中的昵称提示，用于唤醒识别 |
| `wechat.wake_words` | 自定义唤醒词 |
| `wechat.whitelist` | 允许交给 AI 处理的好友和群的数字 ID |
| `persona.default` | 默认人格文件名，不包含 `.md` |
| `dsh.provider`、`dsh.model` | DSH 中实际支持并已配置的模型标识 |
| `hook.wechatExecutable` | 用户独立准备的匹配客户端位置 |

公开示例使用通用人格 `示例助手`，好友与群白名单均为空。已有本机配置继续使用其中的设置。

修改模型标识后，需要让配置生成脚本更新插件 patch，再从托盘完整退出并重新打开 DSH。运行中的插件缓存不会仅因编辑 JSON 而自动更新。

### 3. 安装依赖

```powershell
npm run setup
```

安装脚本按锁文件安装 DSH 插件依赖，并向 `runtime.python` 指定的解释器安装 [reader-requirements.txt](scripts/reader-requirements.txt) 中的 Python 依赖。

使用已有 DSH 桌面端即可，无需另装一份 DSH CLI。默认安装不重新编译原 WeFlow，也不包含账号登录或首次读取凭据配置。

### 4. 准备本机读取配置

读取器使用私有文件 `state/weflow/WeFlow-config.json` 中的 `dbPath`、`myWxid` 和 `decryptKey` 等设置。它们必须对应用户已授权、已同步到本机的账号和数据库。

当前项目没有一键初始账号配置向导。新环境必须先完成有效配置；安装依赖或复制公开示例本身不能使数据库可读。Windows 当前用户保护的凭据不能直接跨用户／机器复用，原 WeFlow 的 `safe:` 加密内容也不能当作已转换的读取凭据直接使用。

准备好配置后可进行只读验证：

```powershell
$config = Get-Content .\config\wechatagent.json -Raw -Encoding UTF8 | ConvertFrom-Json
& $config.runtime.python -B .\scripts\reader-api.py --check
```

结果应包含 `databaseReady: true`。凭据和账号数据仅保存在本机私有目录，分享问题时只提供脱敏的错误信息。

### 5. 准备原生发送组件

先核实第三方实现的使用、修改和分发授权，再在本机准备所需源码、匹配客户端及 C++ 构建工具。Hook 整体许可证尚未确认，公开发行范围不包括其源码和 DLL。

本地获授权的源码就绪后：

```powershell
npm run hook:build
npm run hook:test-native
```

构建脚本核对固定提交，在 `state/` 中的副本应用本项目覆盖层。输出为本机运行数据，不作为公开发行资源。接口和诊断说明见 [Hook 接入说明](docs/WECHAT_HOOK.md)。

匹配客户端和后端的准备是完整收发的前置条件；本项目不承诺克隆后无需外部准备即可运行。

### 6. 安装 DSH 插件

在 DSH 插件页面添加本项目目录：

```text
<项目目录>\packages\dsh-social-bridge-plugin
```

启用插件后，从托盘完整退出并重新打开 DSH，以加载模块和微信安全 preset。仅关闭主窗口可能保留后台进程及旧模块缓存。

## 启动与停止

先打开并登录匹配的电脑微信，等待本机消息同步；打开已启用插件的 DSH，再启动项目。

| 双击入口 | 功能 |
| --- | --- |
| `Launch-Hook-WeChat.cmd` | 校验并打开用户已准备的匹配微信 |
| `Setup-WeChatAgent.cmd` | 安装项目依赖 |
| `WeChatAgent.cmd` | 启动读取器、Bridge 和 OneBot 适配器 |
| `Restart-WeChatAgent.cmd` | 重读配置并重启本项目管理的服务 |
| `Stop-WeChatAgent.cmd` | 停止本项目管理的服务 |
| `Status-WeChatAgent.cmd` | 查看连接与读取状态 |

命令行入口：

```powershell
npm start
npm run status
npm run restart
npm run stop
```

完整启动应显示 `Database ready: True`、`Reader connected: True`、`OneBot connected: True` 和 `Hook account verified: True`。匹配微信或发送组件未就绪时，启动检查会报错；端口开放不等于已经完成真实收发。

默认状态页为 [本机状态页](http://127.0.0.1:8766/)。停止／重启入口按记录的进程身份管理项目服务；微信和 DSH 桌面应用由用户独立管理。

### 默认端口

| 端口 | 服务 |
| --- | --- |
| 5031 | NT 读取 API，采用 WeFlow 兼容路由；默认不是原 WeFlow 界面进程 |
| 11229 | OneBot v11 反向 WebSocket |
| 8766 | 微信 I/O 适配器状态页 |
| 11230 | DSH 本地插件接口 |
| 30001 | 自备原生发送后端 |

当前实现使用本机回环地址，并对相关读取、插件与发送接口检查令牌。部署到其他设备或网络需要独立设计访问控制。

## 白名单与人格

在 `config/wechatagent.json` 中设置，例如：

```json
{
  "wechat": {
    "whitelist": { "groups": ["123456"], "private": ["654321"] },
    "wake_mode": "mention",
    "wake_words": ["小助手"]
  },
  "persona": {
    "default": "示例助手",
    "chats": { "wechat:group:123456": "示例助手" }
  }
}
```

这是合并到本机配置的片段，不是完整配置；数字为虚构示例，需换成实际 OneBot ID。群名或原始微信账号标识不能直接代替此数字 ID。

好友 ID 可在读取服务就绪后查询：

```powershell
npm run friend-ids -- "联系人A"
```

群 ID 可从本机日志中的会话标识核对。加入白名单前应确认聊天身份和必要的数据处理授权。

- `mention`：只在昵称提示／唤醒词满足条件时进入群聊判断。
- `hybrid`：也可判断普通群消息，由模型选择回复或沉默；沉默判断仍可能消耗模型 token。
- 默认群回复间隔为 15 秒，每分钟最多 3 条，每十分钟最多 10 条。

测试时请由另一位成员使用微信的 @ 功能明确提问。群友账号自己发出的消息会被过滤，避免回复循环；没有唤醒的普通群消息允许模型选择沉默。归档后的旧窗口不能继续运行，应查看插件新建的当前会话。

人格文件位于 `roles/`。新的人格、图片和示例应使用自行创作或已获适当授权的内容。修改聊天范围或人格配置后执行 `npm run restart`。

## 会话、图片与消耗

每个好友／群拥有独立原生 session。常规轮次使用未处理新消息；人格在初始化、变化或成功压缩后补入一次。标题由聊天名称和人格名称直接设置，不额外调用模型生成。

在 DSH 归档当前会话后，后续消息会创建新会话，旧记录继续归档。仅关闭窗口不会归档会话。原生压缩则继续使用同一个 session：

```powershell
npm run sessions:status
npm run sessions:configure
npm run sessions:compact -- wechat:group:123456
```

压缩需要额外的模型摘要调用，应根据上下文长度安排。会话复用和缓存命中不会使历史输入免费；费用和额度以配置的模型服务规则为准。

图片每批最多 4 张，最长边 1280 像素，每张传输上限 768 KiB。处理可准确匹配的普通图片与表情包；无法取得时会报告错误，不猜测其他聊天的图片。GIF 和 WXGF 动画转换为最多三张采样画面的拼图，不保证理解完整动画。图片输入成功完成后追加原生 `image/offload` 记录，避免后续轮次反复提交历史图片内容。

表情包先尝试当前账号的本机缓存。需要腾讯 CDN 回源时，在 `wechat.media` 中设置 `"allowStickerCdn": true`；公开示例默认关闭。启用后只使用当前白名单原消息自带的 `wxapp.tc.qq.com` 或 `vweixinf.tc.qq.com` 地址，强制 HTTPS、禁止重定向并校验 MD5；下载凭据不会写入公开日志。该选项不改变普通图片的本机读取方式。

拍一拍依据微信 `appmsg/62` 的发起人和被拍账号判断，不根据聊天文本中的“拍了拍”猜测。群里拍群友等同明确唤醒，仍受白名单与发言频率限制；自己拍别人或其他成员互拍会被忽略。目前按配套微信的实际字段实现，其他版本需另行验证。

旧 `vweixinf.tc.qq.com` 地址可能无法通过 HTTPS 证书校验。取得将下载凭据交给腾讯兼容域名的持续授权后，可另外设置 `"allowStickerCdnAlias": true`，仅将这个旧域名映射到 `wxapp.tc.qq.com`。公开示例默认关闭；仍核验 TLS 和原消息 MD5，不关闭证书验证或退回明文 HTTP。

更多说明：[原生会话](docs/DSH_SESSIONS.md)、[图片接收](docs/IMAGE_INPUT.md)。

## 数据处理范围

本地读取器、Bridge 消息缓冲、凭据、日志和媒体缓存位于本机。启用云端模型后，白名单消息、人格以及所选图片会传给配置的模型服务；DSH 也保存原生会话和附件。

使用者应取得适用的数据处理授权和必要同意，遵守平台条款、隐私要求及当地法律。本项目的开源许可证不自动授予对他人账号、聊天、图片或其他作品的访问及传播权利。

`state/`、本机配置、环境凭据及运行缓存已由 [.gitignore](.gitignore) 排除。已被 Git 跟踪或写入历史的敏感文件，需要另行处理；忽略规则不会自动清除它们。

## 排查

| 现象 | 检查 |
| --- | --- |
| 好友发消息没有记录 | 电脑微信是否已登录并完成同步；账号、白名单、读取 API 与 SSE 是否正确 |
| 群里不回复 | 是否满足唤醒条件、触发频率限制，或模型选择了 `SILENT` |
| `BACKEND_UNAVAILABLE` | 匹配微信与发送后端是否运行，本地接口是否可访问 |
| `HOOK_VERSION_MISMATCH` | 核对实际客户端及核心库版本，使用经过验证的匹配实现 |
| `HOOK_ACCOUNT_NOT_READY` | 核对电脑微信登录账号与所选数据库账号 |
| `turn_blocked` | 查看会话是否已归档，以及是否加载 `archive-rotation-v1` 生命周期修复 |
| `MODEL_IMAGE_INPUT_UNSUPPORTED` | 当前模型没有声明图片输入能力 |
| `IMAGE_LOCAL_COPY_UNAVAILABLE` | 在电脑微信打开图片并等待下载，再核对本机资源是否可读 |
| `NO_NEW_SERVER_RECEIPT` | 查看实际发出记录；服务器消息 ID 是发送确认，不是对方已读证明 |
| 微信提示版本过低 | 先解决当前客户端的正常登录及版本匹配；目录写保护不能保证旧版长期可登录 |

运行日志位于 `state/logs/`。发送超时不一定代表消息未发出，人工测试前应核对现有发出记录。

## 项目目录

```text
WeChatAgent/
├─ components/qq-bridge/              上游 Bridge 与本项目微信协议适配
├─ components/weflow-cli/             NT 读取组件，按其原许可管理
├─ packages/dsh-social-bridge-plugin/ 原生会话插件与安全 preset
├─ roles/示例助手.md                   通用示例人格
├─ scripts/                          安装、启动、读取、发送适配与验证
├─ config/wechatagent.example.json    公开空白配置
├─ config/wechatagent.json            本机私有配置
├─ state/                            私有运行数据与外部组件，仅在本机准备
├─ components.json                   组件来源和固定版本记录
├─ LICENSE                           根目录许可文本与第三方边界说明
└─ LICENSES.md                       组件许可证与发布待核验事项
```

## 开发与验证

依赖安装、源码组件完整后运行：

```powershell
npm test
```

检查覆盖配置路径、账号与白名单、OneBot 收发、服务器回执、人格初始化、会话压缩／归档换代，以及图片身份绑定、解码、传输和上下文释放。

当前版本已通过 41 项项目回归，并在授权环境验证文字私聊、群聊回复、普通图片理解、私聊表情包及拍一拍回复。真实群聊表情包与拍一拍尚未现场验收。回归使用虚构数据；真实验收记录保存在本机私有目录，不作为公开示例。测试结果不能替代其他账号、版本或未来客户端的兼容性验证。 此副本的独立验证及范围见 [发布说明](RELEASE_NOTES.md)。

贡献时保留原作者版权与许可文本，记录第三方来源及修改范围，使用虚构联系人和合成数据作为示例。

## 版权与发布范围

### 组件许可

| 范围 | 来源与许可 |
| --- | --- |
| 有权独立授权的本项目新增代码与通用示例 | 依根目录 [LICENSE](LICENSE)；不替代第三方许可 |
| Bridge 源码及派生部分 | [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)，MIT；保留版权及许可文本 |
| NT 读取组件和复用的媒体辅助函数 | [zhuobichen/weflow-cli](https://github.com/zhuobichen/weflow-cli)，本地版本 LICENSE 为 MIT；保留来源和许可 |
| 外部 WeFlow 参考，不随此副本分发 | [hicccc77/WeFlow](https://github.com/hicccc77/WeFlow)，本地版本采用 CC BY-NC-SA 4.0；保留作者、许可和修改说明 |
| 外部历史 WeFlow 来源，不随此副本分发 | [Nixer-2301/WeFlowBackup](https://github.com/Nixer-2301/WeFlowBackup)，其提供的副本不替代原组件许可 |
| 自备 Hook | 上游整体许可证未确认，当前分发范围排除其源码与二进制 |
| 预编译库、图标、字体及其他素材 | 需按具体文件的来源和许可核验，不能仅由根目录许可推定可分发 |

WeFlow 的 CC BY-NC-SA 条款包括署名、非商业要求，以及适用改编部分的相同方式共享义务。具体以保留的许可文本及 [CC 官方法律文本](https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode.en)为准；它不自动授予第三方原生库、商标或其他独立素材的权利。

### 发布前待核验

1. 保留各组件的版权、作者、许可证和来源说明，对修改内容作出标记。
2. Hook 未声明整体许可，公开仓库和发布包不应附带未经授权的源码或 DLL；源码公开可见不等于已获得一般再分发授权，见 [GitHub 许可说明](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository)。
3. 此副本排除原生二进制、图片、字体及其他媒体资源。今后添加资源前需逐项核实授权；源码许可不能代替独立资源的权利。
4. 微信及 DSH 的程序、安装包、商标素材、人物图片和自定义人格应分别核实权利。项目名与依赖名称不意味着取得商标使用或软件再分发授权。
5. 发布副本应清理真实账号、聊天、图片、密钥、令牌、个人路径及未获授权的素材；分享截图、角色卡和故障日志时同样需要处理。

“学习研究用途”“不用于商业”或 README 中的免责声明不能自动替代第三方授权，也不能保证项目没有侵权、隐私或平台条款问题。**此副本已整理文件范围与已知私有信息，但不构成法律或平台使用授权的保证。外部组件需独立核实许可。**

完整清单见 [LICENSES.md](LICENSES.md)。本仓库的作用是记录实现、来源和边界，不能替使用者取得第三方许可或确认某项具体使用的法律结论。


## 本源码发布副本

本目录包含默认微信收发链路、公开配置、通用人格、必要 MIT 源码子集及离线回归。原 WeFlow 界面、历史 apps、全量 QQ 产品和未使用资源不在发行范围内。

读取组件裁剪了未使用的进程发现、扫描和原 CLI，默认 API 功能通过合成加密数据库验证。用户独立准备有效的授权读取凭据和原生发送实现。

默认依赖安装仍使用 `npm run setup`。`setup.ps1 -BuildOriginalWeFlow` 不适用于本源码副本。

测试在没有本机配置时使用公开示例；需要指定测试解释器时，临时设置 `WECHATAGENT_TEST_PYTHON` 即可，无需把本机路径写入公开配置。
