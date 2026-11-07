<h1 align="center">WeChatAgent</h1>

<p align="center">让微信成为你的 AI 聊天伙伴与远程任务入口</p>

<p align="center">
  <a href="https://github.com/sourcepro5/WeChatAgent/stargazers">
    <img src="https://img.shields.io/github/stars/sourcepro5/WeChatAgent?style=flat-square&amp;logo=github&amp;logoColor=white&amp;label=Stars&amp;labelColor=374151&amp;color=d4a72c" alt="GitHub Stars" />
  </a>
  <a href="https://github.com/sourcepro5/WeChatAgent/network/members">
    <img src="https://img.shields.io/github/forks/sourcepro5/WeChatAgent?style=flat-square&amp;label=Forks&amp;labelColor=374151&amp;color=64748b" alt="GitHub Forks" />
  </a>
  <a href="https://github.com/sourcepro5/WeChatAgent/issues">
    <img src="https://img.shields.io/github/issues/sourcepro5/WeChatAgent?style=flat-square&amp;label=Issues&amp;labelColor=374151&amp;color=64748b" alt="GitHub Issues" />
  </a>
</p>

WeChatAgent 支持好友和群聊的人格对话与独立上下文。连接 DeepSeek Harness（DSH），还能通过微信交办已授权的任务。
有问题可以添加Q群：550582874

**[下载安装](https://github.com/sourcepro5/WeChatAgent/releases)** · [快速开始](#快速开始) · [插件下载](#插件安装) · [使用教程](#使用教程) · [常见问题](#常见问题) · [更新](RELEASE_NOTES.md)


## 能做什么

- **人格聊天**：为好友和群聊绑定人格，独立保留上下文，支持图片与表情理解；发送能力依所选微信适配版本而定。
- **远程助手**：通过微信交办任务，使用当前聊天已授权的 DSH 工具与技能。
- **能力扩展**：按需启用联网搜索、公开网页阅读和 ZIP 插件，为指定聊天配置能力与权限。

## 开始之前

- 使用 Windows 10/11 x64。
- 使用与当前发行版匹配的微信客户端。
- 单独安装 DSH，并配置可用的模型账号。
- 图片理解需要所选模型支持图片输入。
- 模型调用、搜索等能力可能产生费用或消耗额度。
- 初始允许的聊天范围为空，需要手动添加好友或群聊。

安装版包含所需的 Node.js、Python 和读取依赖，
普通用户无需安装开发工具。

当前兼容版本和安装范围见
[安装说明](docs/INSTALLER_RELEASE.md)。

**0.4.3 安装包只包含微信 4.2.0.12 x64**，全新安装默认使用此版本；升级保留原客户端选择和数据。已完成冷启动登录及文件传输助手文字、普通图片回执验收。4.2 已接通原生 GIF 表情发送及服务器回执，保留动画；暂不支持普通文件和引用发送。图片与真实 @ 的底层 API 不代表已提供完整模型工具链路。详见 [4.2 适配范围](docs/WECHAT_4_2_0_12.md)。

## 快速开始

完成以下步骤，让 AI 回复第一个好友。

### 1. 下载并安装

前往 [Releases](https://github.com/sourcepro5/WeChatAgent/releases)，
下载当前版本的 `WeChatAgent-Setup-版本号-x64.exe`。

运行安装器，选择安装根目录：

- `app/`：程序文件。
- `data/`：WeChatAgent 配置、缓存和运行数据。

### 2. 连接微信

打开 WeChatAgent，进入首次配置：

1. 打开匹配微信并登录。
2. 自动查找账号，选择当前使用的账号。
3. 连接并验证数据库。

**完成标志：** 账号与数据库验证通过。


### 3. 连接 DSH

1. 按引导单独安装或选择已有的 DSH。
2. 登录自己的模型账号。
3. 复制引导提供的插件路径，在 DSH 中添加并启用插件。
4. 从托盘完整退出 DSH，再重新打开。

详细步骤见 [连接 DSH](docs/EXTERNAL_DSH.md)。


### 4. 添加第一个聊天

1. 进入“聊天”，添加一个用于测试的好友。
2. 点击“设置此聊天”。
3. 选择聊天模式和人格，保存设置。
4. 按界面提示应用配置，然后启动服务。

### 5. 验证回复

请对方发送：

> 你好，介绍一下自己。

**完成标志：** 微信收到回复，聊天历史中出现对应记录。

如果没有回复，先检查允许范围、连接状态和运行日志，
再查看下方的常见问题。

## 聊天模式与助手模式

| 模式 | 适合什么场景 |
| --- | --- |
| 聊天模式 | 人格对话、群聊参与、看图、表情、搜索与主动聊天 |
| 助手模式 | 从微信交办任务，使用已授权的 DSH 工具与技能 |

助手模式需要配置管理员身份，并为目标聊天明确授权。
两种模式分别保留设置与上下文。

配置步骤和使用示例见
[远程助手教程](docs/ASSISTANT_REMOTE.md)。

## 使用教程

| 我想做什么 | 教程 |
| --- | --- |
| 熟悉界面、为聊天选择人格与模式 | [界面与聊天设置](docs/UI_LAYOUT.md) |
| 通过微信交办任务 | [远程助手](docs/ASSISTANT_REMOTE.md) |
| 为指定聊天分配工具与技能 | [能力授权](docs/DSH_CHAT_ACCESS.md) |
| 接收附件、回传任务成果 | [文件收发](docs/FILE_TRANSFER.md) |
| 添加和管理表情 | [表情管理](docs/STICKER_MANAGER.md) |
| 接入 dsh-meme 图库 | [图库接入](docs/DSH_MEME.md) |
| 安装鱼的记事本 | [记事本插件](docs/FISH_NOTEBOOK.md) |
| 了解群友记忆 | [群友记忆](docs/MEMBER_MEMORY.md) |
| 更换安装位置、迁移数据 | [数据位置与迁移](docs/DATA_STORAGE.md) |


## 插件安装

### 下载插件包

插件压缩包位于仓库的 [`optional-extensions/packages/`](optional-extensions/packages/) 目录。
下载源码后可在该目录找到，也可以点击下表直接下载。

| 插件 | 下载 ZIP | 使用说明 |
| --- | --- | --- |
| 语音识别 API | [speech-recognition-1.5.0.zip](https://github.com/sourcepro5/WeChatAgent/raw/refs/heads/main/optional-extensions/packages/speech-recognition-1.5.0.zip) | [API 配置与语音转写](docs/VOICE_INPUT.md) |
| 鱼的记事本 | [fish-notebook-1.1.1.zip](https://github.com/sourcepro5/WeChatAgent/raw/refs/heads/main/optional-extensions/packages/fish-notebook-1.1.1.zip) | [记事本插件说明](docs/FISH_NOTEBOOK.md) |

每个 ZIP 都附有同名的 `.sha256` 校验文件，位于同一目录。安装时直接导入 ZIP，无需解压。

### 安装步骤

在“能力 → 能力目录”拖入 WeChatAgent API v2 插件 ZIP：

1. 核对插件名称、版本与权限。
2. 安装插件。
3. 配置参数，并选择允许使用的聊天。
4. 启用插件。

安装后默认关闭。更新与卸载的数据保留规则，
以插件说明和界面提示为准。

WeChatAgent 插件与 DSH 插件分别管理，安装包不通用。

微信语音可通过单独分发的“语音识别 API”插件转写，再交给当前聊天模型。接口、密钥及模型默认留空，不默认安装或启用；说明见 [语音 API 转写](docs/VOICE_INPUT.md)。插件宿主校验使用 `npm run plugin:check`；源码与安装器构建会检查权限、能力声明及第一方 ZIP 与源码的一致性。

[插件开发规范](docs/PLUGIN_DEVELOPMENT.md)
· [聊天小便签示例](examples/plugins/chat-notes/)
· [鱼的记事本](docs/FISH_NOTEBOOK.md)

## 常见问题

### 自建搜索后端总是超时怎么办？

自建 Search API 或响应较慢的搜索后端，可在“能力 → 联网与阅读 → 搜索次数、缓存与超时”将搜索超时调为 30–60 秒；配置 `wechat.search.timeoutMs` 的单位为毫秒，例如 `45000`。默认仍为 20 秒，已有设置不变。若报 `native_timeout`，还需检查 DSH 与后端自身的时限；外层等待不会延长内部超时。详见 [联网搜索说明](docs/WEB_SEARCH.md)。

### 添加好友后为什么没有回复？

检查服务是否启动、好友是否加入允许范围，
以及微信和 DSH 是否连接正常。

### 群聊为什么有时不回复？

检查本群的唤醒方式和回复频率设置。
自然参与模式下，模型也可能选择沉默。

### DSH 插件启用后为什么仍连接不上？

确认添加的是当前安装位置提供的插件，
并从托盘完整退出、重新打开 DSH。
进一步检查“设置 → 诊断”中的连接结果。

### 关闭窗口后为什么还在运行？

窗口“×”会收起到托盘。
需要停止后台并关闭程序时，请使用“退出应用”。

### 升级会丢失数据吗？

同位置升级沿用已有数据位置。
更换位置时，需要核对迁移来源与目标。
详细说明见 [数据迁移](docs/DATA_STORAGE.md)。

### 为什么看不到表情包

先确认电脑微信是否已有该表情的完整副本。本机缺失且下载开关关闭时，日志会显示 `STICKER_CDN_DISABLED`。如允许从腾讯补充下载，在“表情包 → 来源和搜索 → 缺失资源下载与版本兼容”开启“允许从腾讯下载缺失的表情包”，保存后重试；已有本机副本仍可直接读取。

## 升级与更新

升级前：

1. 停止助手服务。
2. 完整退出 WeChatAgent、DSH 和匹配微信。
3. 核对当前数据位置。

安装新版后，按发布说明准备连接配置并重新打开 DSH。

[查看发布说明](RELEASE_NOTES.md)
· [下载新版](https://github.com/sourcepro5/WeChatAgent/releases)

## 开发与构建

开发前请了解目录职责、外部组件和构建前置条件。

- [项目目录](docs/PROJECT_LAYOUT.md)
- [构建说明](docs/INSTALLER_RELEASE.md#构建)
- [插件开发](docs/PLUGIN_DEVELOPMENT.md)


## 数据与隐私

WeChatAgent 的配置、缓存和运行数据保存在本机。
DSH 独立管理自己的会话与附件。

启用模型后，相关聊天内容和附件会交给所选模型服务处理。
分享日志、截图或配置前，请移除账号、凭据和聊天隐私信息。

## 许可证与致谢

本项目包含不同来源和许可的组件，
具体范围见 [LICENSES.md](LICENSES.md)。

感谢相关上游项目及贡献者。

欢迎通过 [Issues](https://github.com/sourcepro5/WeChatAgent/issues)
反馈问题。提交时请附上版本、复现步骤和脱敏日志。

<!-- 325328799 -->
