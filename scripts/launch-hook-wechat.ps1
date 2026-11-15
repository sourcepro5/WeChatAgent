param([switch]$PrepareOnly,[switch]$UpdateHook,[switch]$VoiceCandidate)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
& node (Join-Path $PSScriptRoot 'project-config.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Project configuration invalid.' }
$config = Get-Content -LiteralPath (Join-Path $root 'config\wechatagent.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($config.runtime.sender -notin @('wechat-hook','wechat-input','wechat-helper')) { throw 'Unsupported WeChat sender.' }
if ($VoiceCandidate -and ($config.runtime.sender -ne 'wechat-hook' -or $config.hook.expectedVersion -ne '4.2.0.12')) {
    throw 'The voice candidate requires the 4.2.0.12 WeChatAgent Hook.'
}
if ($config.runtime.sender -eq 'wechat-helper') {
    if ($PrepareOnly -or $UpdateHook) { throw 'Helper mode opens the client as installed and never installs the WeChatAgent Hook.' }
    $exe = if ([IO.Path]::IsPathRooted($config.hook.wechatExecutable)) { [IO.Path]::GetFullPath($config.hook.wechatExecutable) } else { [IO.Path]::GetFullPath((Join-Path $root $config.hook.wechatExecutable)) }
    if (-not (Test-Path -LiteralPath $exe)) { throw 'HELPER_CLIENT_MISSING: Select the WeChat 4.2.0.12 client used by Helper.' }
    if ((Get-Item -LiteralPath $exe).VersionInfo.FileVersion -ne '4.2.0.12') { throw 'HELPER_CLIENT_VERSION_MISMATCH: Helper sending requires WeChat 4.2.0.12.' }
    $signature = Get-AuthenticodeSignature -LiteralPath $exe
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Tencent') { throw 'HELPER_CLIENT_SIGNATURE_INVALID: WeChat executable signature check failed.' }
    $directory = Split-Path -Parent $exe
    if (Test-Path -LiteralPath (Join-Path $directory 'version.dll')) { throw 'HELPER_CLIENT_HAS_PROXY_DLL: Remove the WeChatAgent Hook proxy DLL or select a clean client for Helper.' }
    $running = @(Get-CimInstance Win32_Process -Filter "Name='Weixin.exe'" | Where-Object { $_.CommandLine -notmatch '--type=|--crashpad-handler' })
    $other = @($running | Where-Object { -not $_.ExecutablePath -or $_.ExecutablePath -ne $exe })
    if ($other.Count) { throw 'HELPER_OTHER_WECHAT_RUNNING: Exit the other WeChat from its tray icon first.' }
    foreach ($client in $running) {
        # Helper and the WeChatAgent Hook must not patch the same process.
        $hooked = @((Get-Process -Id $client.ProcessId -ErrorAction SilentlyContinue).Modules | Where-Object { $_.ModuleName -like 'wechatagent-*.dll' })
        if ($hooked.Count) { throw 'HELPER_CLIENT_HAS_HOOK: This WeChat was opened in Hook mode. Exit it from the tray icon, then open it again here.' }
    }
    if ($running.Count) { Write-Output 'Selected WeChat is running without the WeChatAgent Hook. Start Helper and connect this account.'; exit 0 }
    try { & (Join-Path $PSScriptRoot 'pin-hook-client.ps1') }
    catch { if ($_.Exception.Message -notlike 'CLIENT_PIN_SCOPE_REQUIRED*') { throw } }
    Start-Process -FilePath $exe -WorkingDirectory $directory -WindowStyle Normal
    Write-Output 'WeChat opened without the WeChatAgent Hook. Log in, start Helper with the wechatagent_voice plugin, then start WeChatAgent.'
    exit 0
}
if ($config.runtime.sender -eq 'wechat-input') {
    if ($PrepareOnly -or $UpdateHook) { throw 'Foreground input mode opens a clean client and never installs a native sender.' }
    $inputExecutable=if($config.input.wechatExecutable){$config.input.wechatExecutable}else{$config.hook.wechatExecutable}
    if(-not $inputExecutable){throw 'INPUT_CLIENT_REQUIRED: Select a matching Weixin.exe.'}
    $exe = if ([IO.Path]::IsPathRooted($inputExecutable)) { [IO.Path]::GetFullPath($inputExecutable) } else { [IO.Path]::GetFullPath((Join-Path $root $inputExecutable)) }
    if (-not (Test-Path -LiteralPath $exe)) { throw 'INPUT_CLIENT_MISSING: Select an existing Weixin.exe for foreground input.' }
    $signature = Get-AuthenticodeSignature -LiteralPath $exe
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Tencent') { throw 'INPUT_CLIENT_SIGNATURE_INVALID: WeChat executable signature check failed.' }
    $directory = Split-Path -Parent $exe
    if (Test-Path -LiteralPath (Join-Path $directory 'version.dll')) { throw 'INPUT_CLIENT_HAS_PROXY_DLL: Select a clean official WeChat directory without a Hook proxy DLL.' }
    $running = @(Get-CimInstance Win32_Process -Filter "Name='Weixin.exe'" | Where-Object { $_.CommandLine -notmatch '--type=|--crashpad-handler' })
    $other = @($running | Where-Object { -not $_.ExecutablePath -or $_.ExecutablePath -ne $exe })
    if ($other.Count) { throw 'INPUT_OTHER_WECHAT_RUNNING: Exit the other WeChat (for example the Hook client) from its tray icon first.' }
    if ($running.Count) {
        $loaded=@($running | ForEach-Object { (Get-Process -Id $_.ProcessId -ErrorAction Stop).Modules } | Where-Object ModuleName -like 'wechatagent-*.dll')
        if($loaded.Count){throw 'INPUT_CLIENT_HAS_HOOK: Exit WeChat from the tray and open it again in foreground input mode.'}
        Write-Output 'Selected clean WeChat is running. Keep its main window open (minimized is fine).'
        exit 0
    }
    # Same default client protection as the Hook path; clients outside state/hook are left untouched.
    try { & (Join-Path $PSScriptRoot 'pin-hook-client.ps1') }
    catch { if ($_.Exception.Message -notlike 'CLIENT_PIN_SCOPE_REQUIRED*') { throw } }
    # No load script: the client starts exactly as installed, without any Hook module.
    Start-Process -FilePath $exe -WorkingDirectory $directory -WindowStyle Normal
    Write-Output 'Clean WeChat opened for foreground input. Log in, then start WeChatAgent.'
    exit 0
}
$exe = if ([IO.Path]::IsPathRooted($config.hook.wechatExecutable)) { [IO.Path]::GetFullPath($config.hook.wechatExecutable) } else { [IO.Path]::GetFullPath((Join-Path $root $config.hook.wechatExecutable)) }
if (-not (Test-Path -LiteralPath $exe)) { throw 'Matching WeChat client missing. Follow docs/WECHAT_HOOK.md to download and extract it.' }
if ((Get-Item -LiteralPath $exe).VersionInfo.FileVersion -ne $config.hook.expectedVersion) { throw 'Client version mismatch; Hook not installed.' }
$signature = Get-AuthenticodeSignature -LiteralPath $exe
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Tencent') { throw 'WeChat executable signature check failed.' }
if ($config.hook.expectedVersion -in @('4.1.15.13','4.2.0.12')) {
    & (Join-Path $PSScriptRoot 'pin-hook-client.ps1')
    if (-not $PrepareOnly) {
        . (Join-Path $PSScriptRoot 'hook-client-health.ps1')
        Open-HookClient $exe $config.hook.baseUrl
    }
    $loadScript=if($config.hook.expectedVersion -eq '4.2.0.12'){'load-hook-42012.ps1'}else{'load-hook-current.ps1'}
    $loadOptions=@{Executable=$exe;BaseUrl=$config.hook.baseUrl;PrepareOnly=$PrepareOnly}
    if($VoiceCandidate){$loadOptions.VoiceCandidate=$true}
    & (Join-Path $PSScriptRoot $loadScript) @loadOptions
    exit
}
$directory = Split-Path -Parent $exe
. (Join-Path $PSScriptRoot 'hook-client-health.ps1')
$existing = @(Get-CimInstance Win32_Process -Filter "Name='Weixin.exe'" | Where-Object { $_.CommandLine -notmatch '--type=|--crashpad-handler' })
$ours = @($existing | Where-Object ExecutablePath -eq $exe)
if ($ours.Count) {
    if ($PrepareOnly) { throw 'Close the matching WeChat before replacing its native component.' }
    $currentBuild = Get-Content -LiteralPath (Join-Path $root 'state\hook\native\build.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $installedDll = Join-Path $directory 'version.dll'
    if (-not (Test-Path -LiteralPath $installedDll) -or (Get-FileHash -LiteralPath $installedDll -Algorithm SHA256).Hash.ToLowerInvariant() -ne $currentBuild.sha256) { throw 'HOOK_COMPONENT_UPDATE_PENDING: Exit the matching WeChat from its tray before reopening it to apply the updated sender.' }
    Write-Output 'Matching WeChat is open; checking its sender initialization...'
    Wait-HookClient $exe $config.hook.baseUrl $config.hook.expectedVersion (Join-Path $root 'state\hook\native-token.txt')
    Write-Output 'Matching WeChat sender is ready. Finish login, then start WeChatAgent.'; exit 0
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
Write-Output 'Waiting for matching WeChat launcher handoff and sender initialization...'
Wait-HookClient $exe $config.hook.baseUrl $config.hook.expectedVersion (Join-Path $root 'state\hook\native-token.txt')
Write-Output ('Opened matching WeChat '+$config.hook.expectedVersion+'; sender is ready. Log in, then start WeChatAgent.cmd.')
