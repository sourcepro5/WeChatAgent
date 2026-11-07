# 聊天小便签

WeChatAgent API v2 的最小可用示例，不是 DSH 插件。

在项目根目录执行：

```powershell
node scripts/pack-plugin.mjs examples/plugins/chat-notes release/plugins/chat-notes-1.1.0.zip
```

将 ZIP 拖入 WeChatAgent 的“能力 → 能力目录”，确认安装；再点击插件“配置”，授予存储权限、选择聊天并启用。

第一次加载 API v2 需要完整重开 DSH。之后安装、更新和设置在空闲时或下一轮聊天加载。

在所选聊天中试试：“帮我记个便签，周五整理书桌”“查看便签”“清空当前聊天便签”。模型通过 `chat-notes__notes` 调用插件。助手模式仍受管理员规则约束。

## 自定义页面示例（1.1.0）

`ui.json` 声明了两个插件自己的页面，文件都在 `ui/` 中：

- `settings.html`：替代自动生成的设置表单，用滑块调整“最多保留便签数”。宿主点“保存插件设置”时通过 `wa.onCollect()` 取值。
- `page.html`：插件卡片上的“打开”进入，按聊天列出便签并可删除，调用 `list` / `remove` 两个宿主动作。

页面通过 `import wa from './__sdk.mjs'` 与宿主通信，运行在隔离沙箱中，不能直接联网或访问控制台接口。

完整契约见 [插件开发规范](../../../docs/PLUGIN_DEVELOPMENT.md)。
