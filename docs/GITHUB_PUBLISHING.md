# GitHub 发布 0.4.2

仓库：`sourcepro5/WeChatAgent`。新适配位于 `main`，合入前主线保留为 `stable`。发布标题为 `WeChatAgent 0.4.2`，标签为 `v0.4.2`。

## 发布前核对

在公开版仓库根目录执行。以下命令适用于已经完成本地提交和 `v0.4.2` 标签的构建；任何一步失败后先处理错误。

```powershell
gh auth status
npm run privacy:check
npm run release:verify
git status --short
git log -1 --oneline
git show-ref --verify refs/heads/stable
git show-ref --verify refs/tags/v0.4.2
```

## 推送源码与分支

```powershell
git push --atomic origin main stable v0.4.2
```

该命令同时推送主分支、稳定分支和新标签。保留 #3、#7 的原贡献及本地合并记录；不强推、不改写旧标签。若远端已有其他提交或同名标签，先核对并合并，再重新构建验证。

## 上传 Release 附件

确认推送成功后执行：

```powershell
gh release create 'v0.4.2' `
  '.\release\installer\WeChatAgent-Setup-0.4.2-x64.exe' `
  '.\release\installer\WeChatAgent-0.4.2-source.zip' `
  '.\optional-extensions\packages\fish-notebook-1.0.0.zip' `
  '.\optional-extensions\packages\speech-recognition-1.2.0.zip' `
  '.\release\installer\蓝色大肥鱼-小助手.md' `
  '.\release\installer\SHA256SUMS.txt' `
  '.\release\installer\VERIFICATION-0.4.2.json' `
  --repo sourcepro5/WeChatAgent `
  --verify-tag --latest `
  --title 'WeChatAgent 0.4.2' `
  --notes-file RELEASE_NOTES.md
```

安装器、构建缓存和个人运行数据不提交到 Git。Release 附件须使用同一轮最终校验的产物；更改源码后需重新构建和验证。构建过程只生成本地文件，不会自动上传。
