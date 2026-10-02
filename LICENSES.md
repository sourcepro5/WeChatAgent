# 许可证与来源（源码发布副本）

本目录是源码发布副本，不是本机运行目录的完整打包。根目录 LICENSE 保留原作者版权与许可文本，不能替代独立第三方依赖、桌面软件、模型服务和平台接口各自的授权。

| 内容 | 来源与范围 |
| --- | --- |
| Bridge 运行子集 | [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)，MIT；完整通知见 [组件 LICENSE](components/qq-bridge/LICENSE)；裁剪与修改说明见该目录 README |
| NT 数据库读取子集与合成数据测试 | [zhuobichen/weflow-cli](https://github.com/zhuobichen/weflow-cli)，MIT；完整通知见 [组件 LICENSE](components/weflow-cli/LICENSE)；来源提交与修改范围见该目录 README |
| scripts/wechat_media.py | 同一 weflow-cli 来源版本中媒体辅助函数的复用，保留文件头来源说明和对应 MIT 通知 |
| scripts/wechat_sticker.py | 本项目新增绑定和下载逻辑；缓存布局及 CBC 约定参考同一 MIT 上游，保留来源说明 |
| imageio-ffmpeg | 独立安装的 Python 包，BSD-2-Clause；其 FFmpeg 程序按构建自带许可使用，本源码副本不分发二进制，见 [包元数据](https://pypi.org/project/imageio-ffmpeg/0.6.0/) |
| 有权独立授权的本项目新增代码及通用人格 | 依根目录许可的适用范围，不扩大到维护者无权授权的内容 |
| 安装时获取的 SDK 和 Python 包 | 各自原许可与依赖声明；副本不包含 node_modules 或解释器环境 |

来源记录见 [components.json](components.json)。原作者版权和完整许可文本保留，代码子集及修改范围单独标记。

## 独立准备的外部内容

- WeChat-Hook 没有确认整体许可证，本目录不包含其源码或二进制。使用和修改前应独立核实许可。
- 原 WeFlow 与历史 WeFlowBackup 不包含在本目录中。今后引入其源码时，应保留原作者与 CC BY-NC-SA 4.0 许可，遵守适用的署名、非商业和改编共享条件。
- 微信、DSH 程序，原生预编译资源，图片、字体、截图、聊天、私人人格及访问凭据不在发行范围内。
- 本项目覆盖层不包含第三方 Hook 的原实现，编译与运行仍有独立授权及兼容性前置条件。

公开可见不等于一般再分发许可，见 [GitHub 许可说明](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository)。本说明不是法律或平台授权保证，也不自动授予商标、账号数据或独立第三方内容的权利。
