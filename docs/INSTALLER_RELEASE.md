# Windows 安装发行版 0.4.2

安装器为 WeChatAgent-Setup-0.4.2-x64.exe，适用 Windows 10/11 x64。包含桌面应用、Node.js、Python、读取依赖，以及维护者已授权的匹配微信与原生发送/自动连接组件。全新安装匹配微信 4.1.15.13，并保留旧版适配，桥接插件 SDK 为 0.2.0-rc.2；DSH 桌面程序独立安装，不包含在安装包中。公开发布标识为 0.4.2，npm/Electron 内部版本为 0.4.2。

## 安装与升级

只需选择一次根目录：程序放入 app，WeChatAgent 数据放入同级 data。同位置升级保留已有数据路径；更换位置时首次启动确认来源与目标后复制并校验，原副本保留。微信原始数据库不搬动，DSH 保持自己的数据位置。建议预留至少 6 GiB，迁移保留旧副本需要额外空间。

升级前停止服务并完整退出旧版助手、DSH 和匹配微信；安装后准备连接配置并完整重开 DSH，以加载新版插件。新用户在首次配置中登录微信、验证数据库、安装或选择 DSH 并启用本机插件，再添加允许的聊天。初始允许范围为空。

窗口“×”仍收起到托盘；“退出应用”先停止本实例后台服务，停止失败保留窗口供重试。微信和外部 DSH 保持运行。卸载默认保留独立数据目录。详见[数据位置与迁移](DATA_STORAGE.md)、[退出与后台服务](EXIT_SHUTDOWN.md)。

## 0.4.2 功能入口

六项主导航为概览、聊天、人格、能力、表情包、设置。单聊任务、授权和工作区集中在聊天详情；管理员和反馈语录位于助手设置，搜索与网页阅读位于能力，诊断与日志位于设置。详见[界面导航](UI_LAYOUT.md)、[远程助手](ASSISTANT_REMOTE.md)、[文件收发](FILE_TRANSFER.md)、[语录管理](ASSISTANT_FEEDBACK.md)。

## 构建

维护者准备已授权的匹配微信、Hook 编译产物、wx_key.dll 和锁定依赖后，按根 package.json 的版本构建。无需准备 DSH 桌面程序或设置 WECHATAGENT_DSH_SOURCE；发行清单标记 dshBundled=false。

```powershell
npm run desktop:build
npm run installer:runtime
npm run installer:build
npm run source:build
node scripts/verify-plugin-release.mjs
npm run privacy:check
```

源码额外包含已校验的 fish-notebook-1.0.0.zip 与 speech-recognition-1.2.0.zip，以及固定版本、保留许可的 SILK 解码最小载荷；不包含完整安装器、vendor 程序及个人数据。安装器、源码包、可选插件、SHA256SUMS.txt 与 VERIFICATION.json 作为 Release 附件上传。上传命令见 [GitHub 发布](GITHUB_PUBLISHING.md)。

## 验证范围

本次构建的资源哈希、回归、归档完整性、干净部署及升级保留检查以 VERIFICATION.json 为准。验证使用隔离目录与虚构账号，不向真实微信聊天发送测试消息。安装包未商业代码签名；未在另一台物理设备安装验证时，不将其表述为已完成的验收。

## 新版微信与升级保留

0.4.2 全新安装使用独立微信 4.1.15.13 和外置原生发送组件。打开匹配微信会自动开启程序目录保护。旧安装升级保留已有的微信版本选择、账号、凭据、人格和允许的聊天；新版客户端同时准备就绪，可在连接设置中切换。维护程序文件前通过客户端维护入口解除保护。

图片和真实 @ 为新增底层原生 API，尚未提供完整的默认 OneBot/模型工具发送链路。具体范围见 [4.1.15.13 适配](WECHAT_4_1_15_13.md)和[客户端保护](CLIENT_PROTECTION.md)。
