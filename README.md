# WeChatAgent 0.2.2

Windows 微信助手与独立桌面控制台。支持白名单好友／群聊、人格预设、独立 DSH 会话、上下文压缩、图片理解、原生文字及表情包发送。

## 安装使用

普通用户使用 GitHub Releases 附件中的 `WeChatAgent-Setup-0.2.2-x64.exe`。安装后通过“首次配置”登录自己的微信和 DSH、自动查找账号并连接验证数据库、选择聊天范围，日常操作无需命令行。首次白名单为空。安装器需由维护者上传至 Releases；本源码目录不包含它。

用户数据位于当前用户 AppData 下的 WeChatAgent 工作区。升级保留配置、人格编辑和私有状态；卸载保留用户数据。维护者的账号、密钥、联系人、聊天和运行日志未包含在源码中。

## 版本与预设

- WeChatAgent：0.2.2；DSH 桌面端和插件 SDK 实际验收版本：`0.2.0-rc.2`。
- 匹配微信：Windows x64 `4.1.10.27`；版本可登录性需按实际账号和环境验证。
- 内置预设：傲娇助手、德克萨斯、洛奇希、示例助手、小鲸鱼。首次选中示例助手，可在桌面应用切换。
- 支持人格稳定复用、归档后创建新会话、图片完成后卸载输入、按聊天控制表情发送和标签缓存。
- 首次配置自动识别账号目录、获取并验证读取密钥，验证通过才安全保存；失败显示恢复步骤，保留原配置。
- 支持人格 Markdown 导入、接收引用消息、按需联网搜索、逐聊天主动聊天与自动上下文压缩；联网及主动聊天默认关闭。
- 当前未提供主动拍回、文件发送、语音／视频理解或通用新版微信适配。

## 源码与构建

运行要求：Windows 10/11 x64、Node.js 22.13+（建议 24）、Python 3.10+ 及读取依赖。桌面构建依赖在根 package.json 固定版本，已移除对历史 WeFlow 完整工程的依赖。

```powershell
npm ci
npm ci --prefix packages/dsh-social-bridge-plugin
python -m pip install -r scripts/reader-requirements.txt
npm run desktop:build
```

构建完成后双击根目录 WeChatAgent.exe 或 WeChatAgent-Console.vbs。源码副本不包含微信、DSH、第三方 Hook、已编译原生库或任何运行环境，完整收发需独立准备相应组件。外部组件说明见 [发送后端](docs/WECHAT_HOOK.md)。源码模式的自动连接需另行准备已授权的 wx_key.dll，放到 components/weflow-cli/resources/key/win32/x64/；安装器会内置该组件，普通用户无需手动准备。

安装器构建需要已获授权的微信客户端、Hook 编译产物及 DSH 程序。准备到本机私有 state/hook 目录，设置 DSH 程序目录后构建；每次均校验 DSH 与 SDK 版本匹配，并按根 package.json 中的版本号生成安装器。

```powershell
$env:WECHATAGENT_DSH_SOURCE = '<DSH program directory>'
npm run desktop:build
npm run installer:runtime
npm run installer:build
```

Python embed 与 wheel 下载校验 SHA256；临时下载、程序和构建输出仅在忽略的 state/、node_modules/、release/ 中生成。不要将这些目录加入源码仓库。

## 检查

```powershell
npm run privacy:check
```

公开副本不附带开发回归测试、合成数据生成器或独立模型验证脚本。开发探针测试入口也已移除；应用内的环境检查、数据库读取检查和实际发送后端检查仍保留。部署、启动与日常收发不依赖测试源码。

## 目录

| 目录 | 用途 |
| --- | --- |
| apps/console-desktop、public/console | 桌面程序与界面 |
| scripts | 生命周期、读取 API、构建与原生覆盖层 |
| packages/dsh-social-bridge-plugin | DSH 0.2 插件及依赖锁 |
| components/qq-bridge | MIT 微信社交运行源码子集 |
| components/weflow-cli | MIT 数据库读取源码子集 |
| roles | 五份预设与说明 |
| config/wechatagent.example.json | 空白聊天范围的示例配置 |

## 数据与许可

启用云端模型后，选中的聊天消息、人格和图片会交给配置的模型服务；本机读取不代表模型推理发生在本机。聊天不能修改人格、白名单、规则或模型工具权限，配置仅由本机所有者管理。

原作者署名和各组件许可保留，见 [LICENSES.md](LICENSES.md) 与 [components.json](components.json)。维护者已确认当前使用组件的再分发授权；这不将第三方程序、代码或角色素材重新许可为 MIT，也不表示微信或 DeepSeek 的官方背书。

源码与安装器分开发布：仓库提交本目录源码，Releases 附加安装器、SHA256SUMS.txt 和验证记录。推送与发布命令见 [GitHub 发布步骤](docs/GITHUB_PUBLISHING.md)。安装、启动、升级及卸载验收使用维护者 Windows 11 的隔离目录，不替代其他电脑或账号的实际登录与收发验证。

## 免责声明

本项目仅供学习、技术交流与个人实验使用。请在合法授权的前提下使用，并遵守适用法律法规、平台规则及第三方组件的许可要求。请勿用于骚扰、诈骗、未经授权的数据访问，或其他侵害他人权益的行为。

本项目为第三方技术整合，不代表微信、腾讯或 DeepSeek 官方，也不构成任何官方合作或背书。项目按现状提供，不保证所有客户端版本、账号和运行环境均可正常使用。使用前请做好必要的数据备份，并自行评估账号、隐私及模型服务使用等风险。“仅供学习”的说明不替代相关许可或授权。

## 交流与反馈

使用过程中遇到问题，欢迎添加 QQ：**3058492721** 交流反馈。没有问题也欢迎扩列，聊聊技术或日常。

## tips
默认人格的攻击力为**3250**，特别会怼人
## 自定义背景

点击右上角“换肤”，选择自己的 PNG 或 JPG 图片（最大 20 MB），可实时调整背景显示强度或恢复默认。浅色、深色主题均保留阅读遮罩。图片保存在本机 state/desktop 下，重启后继续生效，不上传至模型，也不作为公开源码或安装包预设分发。
