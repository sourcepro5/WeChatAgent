# 自备原生发送后端

源码发布副本提供本项目的版本、账号、令牌检查覆盖层与 OneBot 适配器，不包含第三方 Hook 源码、DLL、微信程序或安装包。

**微信 4.1.15.13 x64** 另有本项目独立的原生 profile，见 [4.1.15.13 接入说明](WECHAT_4_1_15_13.md)。它采用显式装载，不复用下述旧版偏移或替换微信文件。v2 在原生 API 层增加后台图片和群聊真实 @；OneBot 仍沿用文字路径，新接口尚未接入其媒体／@ 分段发送。引用、动态表情和音视频发送不在此 profile 的支持范围。以下原有步骤仍用于 4.1.10.27。

来源：[aixed/WeChat-Hook](https://github.com/aixed/WeChat-Hook)。当前匹配 Windows x64 微信 `4.1.10.27`，构建脚本要求的来源提交为 `e905d07ade50d2c6472e4eb3bd4f3fe19cf662c6`。维护者已确认当前使用组件的再分发授权；源码仓库仍将原始 Hook 和客户端作为外部组件，保留本项目覆盖层及来源记录。

## 本机准备

获得相应许可、独立准备源码和匹配客户端后：

1. 按 `scripts/build-hook.ps1` 的要求，将获授权源码准备到 `components/WeChat-Hook`。
2. 安装 C++ 构建工具，执行 `npm run hook:build`。
3. 将客户端位置填入 `hook.wechatExecutable`，使用 `npm run hook:open` 打开并登录，再通过桌面“检查后台发送”或 `npm run hook:check` 核对实际后端。
4. 数据库读取配置、账号及 DSH 插件就绪后，再启动完整项目。

构建输出只保存在本机私有 `state/` 目录。目录写保护用于降低本地更新导致的版本错配，不能保证某个版本持续可登录。版本失配需真实适配及验证，不能仅修改配置版本号。

## 接口与发送确认

后端应提供由本项目覆盖层注册的 `/WeChatAgent/health` 与 `/SendTextMsg`，仅监听本机回环地址，并检查本机令牌。

发送前核对实际核心版本和账号；发送后等待新的匹配发出记录及服务器消息 ID。账号、版本或接口不符时停止发送。服务器回执不代表对方已读，超时后应先核对实际发出记录再重试。

| 提示 | 检查 |
| --- | --- |
| `BACKEND_UNAVAILABLE` | 进程、接口、DLL 加载及端口 |
| `HOOK_VERSION_MISMATCH` | 实际客户端与核心库版本 |
| `HOOK_ACCOUNT_NOT_READY` | 登录账号、数据库归属及同步状态 |
| `NO_NEW_SERVER_RECEIPT` | 实际发出记录与新的服务器消息 ID |

此文档说明接入契约，不提供第三方分发授权或平台使用许可。


## 0.3.4 初始化与首次连接

version.dll 的加载入口只安排初始化工作；核心模块 Weixin.dll 就绪后再执行一次 Hook 初始化，最多等待 30 秒。启动检查可短暂等待发送后端，版本、令牌和账号异常不盲目重试。HTTP 服务只有绑定本机端口后才算就绪。

在运行日志查看 hook-init.log：waiting_for_weixin_dll 表示等待核心模块，weixin_dll_ready 表示模块已就绪，http_listening 表示端口已绑定，initialization_ready 表示初始化完成；module_wait_timeout 表示等待超时，http_bind_failed 表示端口无法绑定。日志不记录令牌、读取密钥或聊天内容。

升级需从托盘完整退出匹配微信后再通过助手“打开微信”，以加载新的 DLL。
