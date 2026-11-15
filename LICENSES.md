# 许可证与来源（源码发布副本）

本目录是源码发布副本，不是本机运行目录的完整打包。根目录 LICENSE 保留原作者版权与许可文本，不能替代独立第三方依赖、桌面软件、模型服务和平台接口各自的授权。

| 内容 | 来源与范围 |
| --- | --- |
| Bridge 运行子集 | [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)，MIT；完整通知见 [组件 LICENSE](components/qq-bridge/LICENSE)；裁剪与修改说明见该目录 README |
| NT 数据库读取源码子集 | [zhuobichen/weflow-cli](https://github.com/zhuobichen/weflow-cli)，MIT；完整通知见 [组件 LICENSE](components/weflow-cli/LICENSE)；来源提交与修改范围见该目录 README |
| scripts/wechat_media.py | 同一 weflow-cli 来源版本中媒体辅助函数的复用，保留文件头来源说明和对应 MIT 通知 |
| scripts/wechat_sticker.py | 本项目新增绑定和下载逻辑；缓存布局及 CBC 约定参考同一 MIT 上游，保留来源说明 |
| packages/voice-codec/silk-wasm | [idranme/silk-wasm](https://github.com/idranme/silk-wasm)，固定 npm 3.7.1 最小运行载荷；MIT，保留 LICENSE、版本来源和逐文件 SHA-256（PROVENANCE.json） |
| imageio-ffmpeg | 独立安装的 Python 包，BSD-2-Clause；其 FFmpeg 程序按构建自带许可使用，本源码副本不分发二进制，见 [包元数据](https://pypi.org/project/imageio-ffmpeg/0.6.0/) |
| 前台模拟输入依赖 | Windows 安装包随内置 Python 提供 [psutil 7.2.2](https://pypi.org/project/psutil/7.2.2/) 与 [pywin32 312](https://pypi.org/project/pywin32/312/)，保留原许可证文件与轮子哈希 |
| 有权独立授权的本项目新增代码、桌面界面及已授权人格预设 | 依根目录许可的适用范围，不扩大到维护者无权授权的内容 |
| 安装时获取的 SDK 和 Python 包 | 各自原许可与依赖声明；副本不包含 node_modules 或解释器环境 |

来源记录见 [components.json](components.json)。原作者版权和完整许可文本保留，代码子集及修改范围单独标记。

## 独立准备的外部内容

- 维护者已确认当前使用组件的再分发授权。本公开源码副本仍不包含第三方 WeChat-Hook 原始源码或二进制；本项目覆盖层单独保留。授权声明不替换上游自身许可。
- 原 WeFlow 与历史 WeFlowBackup 不包含在本目录中。今后引入其源码时，应保留原作者与 CC BY-NC-SA 4.0 许可，遵守适用的署名、非商业和改编共享条件。
- 微信、DSH 程序、原生预编译资源、第三方素材、截图、聊天及访问凭据不在源码发行范围内。五份已授权人格明确作为预设文件发布，用户安装后的账号配置和人格编辑不随源码分发。
- 本项目覆盖层不包含第三方 Hook 的原实现，编译与运行仍有独立授权及兼容性前置条件。

公开可见不等于一般再分发许可，见 [GitHub 许可说明](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository)。本说明不是法律或平台授权保证，也不自动授予商标、账号数据或独立第三方内容的权利。

## Weather data services

Weather forecasts are fetched from [Open-Meteo](https://open-meteo.com/) and locations from its GeoNames-backed geocoding API. Data is provided under [CC BY 4.0](https://open-meteo.com/en/licence); source attribution is retained in the model evidence and links. The default public API is for personal/non-commercial use and subject to [Open-Meteo terms and request limits](https://open-meteo.com/en/terms). Commercial use requires a suitable provider subscription or a separately operated service. No provider source code is bundled.

网页正文提取使用 [htmlparser2 10.0.0](https://github.com/fb55/htmlparser2/tree/v10.0.0)（MIT）；锁文件固定依赖，安装包保留 htmlparser2、entities、domhandler、domutils 等各自的 LICENSE。网页工具的网络地址校验复用 MIT Bridge 的 safe-fetch 逻辑，来源许可见 `components/qq-bridge/LICENSE`。仅使用本机 DNS 解析；代理返回 Fake-IP 时按非公开地址拒绝，不向额外 DNS 服务发送网页域名。
