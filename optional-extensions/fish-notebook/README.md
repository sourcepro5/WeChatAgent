# 鱼的记事本 · WeChatAgent 可选插件

本包是可拖入安装的 WeChatAgent 插件，不是 DSH/npm 插件。

## 安装与使用

1. 使用包含 `actions-v1`、`documents-v1`、`persona-read-v1`、`model-utility-v1`、`daily-schedule-v1`、`diary-question-v1` 的新版 WeChatAgent 插件宿主。早期 API v2 宿主缺少这些能力时，请先更新项目、准备配置，并完整重开 DSH 与 WeChatAgent。
2. 在“能力 → 能力目录”拖入 `fish-notebook-1.1.1.zip`，核对权限并确认安装。安装后保持关闭，不自动执行或迁移私人配置。
3. 在插件卡片点击“配置”，勾选所需权限、选择允许的聊天并启用；晚间时间默认北京时间 `21:30`。
4. 在插件卡片点击“打开”，选择聊天查看日记，或点击“写下今天”提前整理。也可以在微信问“看看你的日记”，短时间内接着说“再给我看看嘛”。

前两次按当前人设害羞回应，第三次分享当天已保存的日记，之后可直接查看。按账号、聊天、人设、日期和询问者分别计数；同一消息重试不重复计数。前端查看不计数。每聊天、每人设、每天最多生成一篇；晚间没有当天聊天时等待后续检查，已经提前写过时不重复写。

## 权限与数据

- `documents`：读写日记正文和询问回执，保留 JSON 文件。
- `history_read`：仅获取本聊天当天有限文字片段，不读取工具日志或内部推理。
- `persona_read`：读取本聊天当前人格。
- `model_generate`：使用现有 DSH 模型写日记与前两次回应，会产生模型消耗；独立请求不挂载工具。
- `schedule`：由宿主在所设时间后检查，不自行创建后台任务或主动发微信。
- `reply`：允许通过原有可靠发送链路分享日记。

兼容原来的 `state/fish-notebook/<账号作用域>/<会话哈希>/<日期-人设标识>.json`，已有日记和询问计数继续使用，不复制或覆盖旧数据。关闭、更新或卸载保留这些文件。日记页面通过 DSH 调用插件动作读取，插件关闭期间不显示内容；重新启用或重新安装相同 id 后可继续查看和使用。插件总开关和聊天授权改由 `config/plugins.json` 管理，旧 `wechat.fishNotebook` 开关不会自动变成新的插件授权。

日记不会自动发到微信，第三次被问起时才分享。群聊仍遵守聊天范围、唤醒和发送限制，不赋予普通群友 DSH 任务权限。

## 源码与打包

本包包含 `plugin.json`、`index.mjs`、`lib/notebook.mjs`、`ui.json`、`ui/`（日记页面）和本说明，不需要 npm 安装或项目外的相对源码引用。

1.1.0 起日记页面随包提供：`ui/page.html` 在沙箱 iframe 中运行，只通过 `import wa from './__sdk.mjs'` 调用本插件的 `list`（分页读取，不计入询问次数）和 `write-today` 动作。宿主不再内置记事本页面、下载入口或 `/api/fish-notebook` 接口。

1.1.1 在 `requiresHostFeatures` 中声明 `diary-question-v1`：宿主识别出微信里的日记询问后，交给声明了该能力、已获 `reply` 授权并注册 `ask` 动作的插件，不再按插件 id 绑定。1.1.0 在新版宿主上仍可查看和晚间写日记，但不再接收微信里的日记询问；旧宿主没有该能力时会拒绝导入 1.1.1，请先更新宿主。

```powershell
node scripts/pack-plugin.mjs optional-extensions/fish-notebook optional-extensions/packages/fish-notebook-1.1.1.zip
```

通用接入契约见项目的 `docs/PLUGIN_DEVELOPMENT.md`。本包内的日记生成、采样依据、询问计数与输出校验逻辑可单独维护；宿主只提供受限数据、模型、定时检查和页面沙箱。
