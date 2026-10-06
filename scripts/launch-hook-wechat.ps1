param([switch]$PrepareOnly,[switch]$UpdateHook)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
& node (Join-Path $PSScriptRoot 'project-config.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Project configuration invalid.' }
$config = Get-Content -LiteralPath (Join-Path $root 'config\wechatagent.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($config.runtime.sender -ne 'wechat-hook') { throw 'Set runtime.sender to wechat-hook first.' }
$exe = if ([IO.Path]::IsPathRooted($config.hook.wechatExecutable)) { [IO.Path]::GetFullPath($config.hook.wechatExecutable) } else { [IO.Path]::GetFullPath((Join-Path $root $config.hook.wechatExecutable)) }
if (-not (Test-Path -LiteralPath $exe)) { throw 'Matching WeChat client missing. Follow docs/WECHAT_HOOK.md to download and extract it.' }
if ((Get-Item -LiteralPath $exe).VersionInfo.FileVersion -ne $config.hook.expectedVersion) { throw 'Client version mismatch; Hook not installed.' }
$signature = Get-AuthenticodeSignature -LiteralPath $exe
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Tencent') { throw 'WeChat executable signature check failed.' }
$directory = Split-Path -Parent $exe
$existing = @(Get-CimInstance Win32_Process -Filter "Name='Weixin.exe'" | Where-Object { $_.CommandLine -notmatch '--type=|--crashpad-handler' })
$ours = @($existing | Where-Object ExecutablePath -eq $exe)
if ($ours.Count) {
    if ($PrepareOnly) { throw 'Close the matching WeChat before replacing its native component.' }
    $currentBuild = Get-Content -LiteralPath (Join-Path $root 'state\hook\native\build.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $installedDll = Join-Path $directory 'version.dll'
    if (-not (Test-Path -LiteralPath $installedDll) -or (Get-FileHash -LiteralPath $installedDll -Algorithm SHA256).Hash.ToLowerInvariant() -ne $currentBuild.sha256) { throw 'HOOK_COMPONENT_UPDATE_PENDING: Exit the matching WeChat from its tray before reopening it to apply the updated sender.' }
    Write-Output 'Matching WeChat is already open. Log in there, then start WeChatAgent.'; exit 0
}
$native = Join-Path $root 'state\hook\native'
$build = Get-Content -LiteralPath (Join-Path $native 'build.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$dll = Join-Path $native 'version.dll'
if ($build.targetVersion -ne $config.hook.expectedVersion -or (Get-FileHash -LiteralPath $dll -Algorithm SHA256).Hash.ToLowerInvariant() -ne $build.sha256) { throw 'Native build hash/version mismatch.' }
$destination = Join-Path $directory 'version.dll'
if ((Test-Path -LiteralPath $destination) -and (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $build.sha256) {
    $previousFile=Join-Path $native 'build.previous.json'
    if (-not $UpdateHook -or -not (Test-Path -LiteralPath $previousFile)) { throw 'A different version.dll already exists here; use UpdateHook only for a verified previous project build.' }
    $previous=Get-Content -LiteralPath $previousFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($previous.targetVersion -ne $config.hook.expectedVersion -or (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $previous.sha256) { throw 'Installed DLL does not match the recorded previous project build.' }
    Copy-Item -LiteralPath $destination -Destination (Join-Path $native 'deployed.previous.dll') -Force
}
try {
    & (Join-Path $PSScriptRoot 'pin-hook-client.ps1') -Unlock
    Copy-Item -LiteralPath $dll -Destination $destination -Force
    Copy-Item -LiteralPath (Join-Path $root 'state\hook\native-token.txt') -Destination (Join-Path $directory 'wechatagent-hook.token') -Force
} finally { & (Join-Path $PSScriptRoot 'pin-hook-client.ps1') }
if ($PrepareOnly) { Write-Output 'Matching client prepared with verified Hook DLL and local token; not launched.'; exit 0 }
if ($existing.Count) { throw 'Another desktop WeChat is running. Exit it from the tray before opening the isolated Hook client; this script does not terminate it.' }
$port = ([Uri]$config.hook.baseUrl).Port
if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { throw 'Hook port is already in use; inspect the listener before launching.' }
$clientProcess = Start-Process -FilePath $exe -ArgumentList ('StartPort='+$port+' CallBackURL="http://127.0.0.1:'+ $config.ports.adapter + '/unused"') -WorkingDirectory $directory -WindowStyle Normal -PassThru
Start-Sleep -Seconds 2
$clientProcess.Refresh()
if ($clientProcess.HasExited) {
    $replacement = @(Get-CimInstance Win32_Process -Filter "Name='Weixin.exe'" | Where-Object { $_.ExecutablePath -eq $exe -and $_.CommandLine -notmatch '--type=|--crashpad-handler' })
    if (-not $replacement.Count) { throw 'WECHAT_LAUNCH_EXITED: The matching client exited after launch. If WeChat requests an upgrade, this fixed-version sender needs a compatible client adaptation.' }
}
Write-Output ('Opened matching WeChat '+$config.hook.expectedVersion+'. Log in, then start WeChatAgent.cmd.')
