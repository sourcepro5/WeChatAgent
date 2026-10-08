# GitHub 发布步骤

本目录为 WeChatAgent 0.2.1 公开源码工作树，对应 sourcepro5/WeChatAgent 的 main 分支。本次使用新标签 v0.2.1，保留已发布的 v0.2.0。源码与 Release 附件分别上传。

## 登录

在此公开源码目录打开 PowerShell。首次使用 GitHub CLI 时执行：

```powershell
gh auth login
gh auth setup-git
```

## 上传源码

```powershell
npm run privacy:check
if ($LASTEXITCODE -ne 0) { throw '隐私检查未通过，请先修正再上传。' }
git diff --check
if ($LASTEXITCODE -ne 0) { throw '差异检查未通过。' }
git add .
if ($LASTEXITCODE -ne 0) { throw '暂存失败。' }
git diff --cached --stat
git commit -m "Release WeChatAgent 0.2.1: simplify first-run setup"
if ($LASTEXITCODE -ne 0) { throw '提交未完成，请检查 Git 输出。' }
git push origin main
if ($LASTEXITCODE -ne 0) { throw '源码推送未完成，请检查远程分支或登录状态。' }
```

## 上传 Release

先把对应 0.2.1 的安装器、SHA256SUMS.txt 和 VERIFICATION.json 放在本目录的 release/installer/。此目录已被 Git 忽略，附件只通过 Release 上传。

```powershell
$assets = @(
  '.\release\installer\WeChatAgent-Setup-0.2.1-x64.exe',
  '.\release\installer\SHA256SUMS.txt',
  '.\release\installer\VERIFICATION.json'
)
foreach ($asset in $assets) {
  if (-not (Test-Path -LiteralPath $asset)) { throw "缺少 Release 附件：$asset" }
}
git tag -a v0.2.1 -m "WeChatAgent 0.2.1"
if ($LASTEXITCODE -ne 0) { throw '标签创建未完成；不要强制覆盖既有标签。' }
git push origin v0.2.1
if ($LASTEXITCODE -ne 0) { throw '标签推送未完成。' }
gh release create v0.2.1 @assets --repo sourcepro5/WeChatAgent --verify-tag --title "WeChatAgent 0.2.1" --notes-file RELEASE_NOTES.md
if ($LASTEXITCODE -ne 0) { throw 'Release 创建或附件上传未完成，请检查命令输出。' }
gh release view v0.2.1 --repo sourcepro5/WeChatAgent --web
```

若 Release 创建成功但附件上传中断，使用 gh release view 检查缺少的附件，再用 gh release upload v0.2.1 <缺少的附件路径> --repo sourcepro5/WeChatAgent 补传。不要重复创建同一个 Release，也不要默认使用 --clobber 替换已有附件。

不要将 state/、release/、node_modules/、实际配置、数据库、凭据或日志提交到 Git。五份授权人格作为公开预设保留；开发测试与合成数据不随公开版分发。源码检查针对候选提交文件，不替代其他电脑与真实账号的功能验证。

官方命令说明：[gh release create](https://cli.github.com/manual/gh_release_create)、[gh release upload](https://cli.github.com/manual/gh_release_upload)。
