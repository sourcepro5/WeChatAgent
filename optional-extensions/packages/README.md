# 随源码分发的第一方插件包

fish-notebook-1.1.1.zip 在 `requiresHostFeatures` 中声明 `diary-question-v1`，宿主据此把微信日记询问交给它，不再按插件 id 绑定；需要包含该能力的宿主。

speech-recognition-1.5.0.zip 与 fish-notebook-1.1.0.zip 自带插件页面（`ui.json` + `ui/`）：语音插件的模型下拉、读取模型与测试识别移入包内设置页，记事本的日记列表与“写下今天”移入包内页面，宿主不再保留这两个插件的专用代码。需要支持插件页面与设置动作的宿主。

speech-recognition-1.4.0.zip 为独立插件更新：按公共文件转写 / Chat 音频协议接入，协议、地址、模型 ID 分开配置，不再按模型名字切换厂商路径。模型别名无需登记，未知能力可通过内置短句确认。只导入此 ZIP 即可更新插件，不修改主程序或宿主捆绑版本登记。配置、升级与旧页面限制见 ../speech-recognition/README.md；校验文件与 ZIP 同目录。

以下为旧版交付记录，历史 ZIP 保留：

speech-recognition-1.4.1.zip 是可配置 API 的语音识别插件，源码在 ../speech-recognition/，需要 voice-input-v1 宿主。配套新配置页提供三步新手引导、常见模型预设和内置短句测试，高级请求配置仍保留；接口、密钥和模型默认留空，不默认安装或启用。

重新生成第一方插件包使用 `node scripts/pack-bundled-plugins.mjs`；发布前运行 `node scripts/plugin-host-check.mjs`，会同时检查插件清单、宿主接口和 ZIP 与源码一致性。

fish-notebook-1.1.1.zip 可拖入 WeChatAgent 的“能力 → 能力目录”安装。安装后默认关闭，请明确选择权限与聊天。

对应源码位于 ../fish-notebook/。本 ZIP 已校验与源码逐项一致，不包含日记、账号或设置。开发者重新打包后应同时更新此处及校验文件；其他压缩包仍按发布边界排除。

需要本次新增的动作、文档、当前人设、独立模型生成与每日计划宿主能力。完整使用说明见 ../../docs/FISH_NOTEBOOK.md。

1.3.0 将服务预设、模型匹配与请求适配放入插件自身，原有支持 voice-input-v1 的安装版可只导入 ZIP 更新，无需更新安装器。旧宿主的检测按钮不随 ZIP 更新，详见插件 README。
