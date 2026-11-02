param([Parameter(Mandatory)][string]$Executable,[Parameter(Mandatory)][string]$BaseUrl,[switch]$PrepareOnly)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$Executable = [IO.Path]::GetFullPath($Executable)
$uri = [Uri]$BaseUrl
if ($uri.Scheme -ne 'http' -or $uri.Host -ne '127.0.0.1' -or $uri.Port -lt 1024 -or $uri.Port -gt 65535 -or $uri.UserInfo -or $uri.AbsolutePath -ne '/' -or $uri.Query -or $uri.Fragment) { throw 'Hook API must be an HTTP loopback base URL.' }
if ((Get-Item -LiteralPath $Executable).VersionInfo.FileVersion -ne '4.1.15.13') { throw 'Client version mismatch; current sender not loaded.' }
$signature = Get-AuthenticodeSignature -LiteralPath $Executable
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Tencent') { throw 'WeChat executable signature check failed.' }
$native = Join-Path $root 'state\hook\native-4.1.15.13'
$build = Get-Content -LiteralPath (Join-Path $native 'build.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$dll = Join-Path $native 'wechatagent-text-4.1.15.13.dll'
$loader = Join-Path $native 'wechatagent-text-loader.exe'
if ($build.targetVersion -ne '4.1.15.13' -or $build.profile -ne '4.1.15.13-media-mentions-v2' -or
    (Get-FileHash -LiteralPath $dll -Algorithm SHA256).Hash.ToLowerInvariant() -ne $build.sha256 -or
    (Get-FileHash -LiteralPath $loader -Algorithm SHA256).Hash.ToLowerInvariant() -ne $build.loaderSha256) { throw 'Native text component hash/profile mismatch.' }
$tokenFile = Join-Path $root 'state\hook\native-token.txt'
$token = (Get-Content -LiteralPath $tokenFile -Raw -Encoding UTF8).Trim()
if ($token -notmatch '^[a-f0-9]{64}$') { throw 'HOOK_TOKEN_MISSING' }
[IO.File]::WriteAllText((Join-Path $native 'wechatagent-hook.token'),$token,[Text.UTF8Encoding]::new($false))
$imageRoot = Join-Path $root 'state\hook\outgoing-images'
New-Item -ItemType Directory -Path $imageRoot -Force | Out-Null
@{baseUrl=$BaseUrl.TrimEnd('/');expectedVersion='4.1.15.13';imageRoot=[IO.Path]::GetFullPath($imageRoot)} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $native 'wechatagent-hook.json') -Encoding UTF8
if ($PrepareOnly) { Write-Output 'Current-version text sender prepared; no process changed.'; exit }
$processes = @(Get-CimInstance Win32_Process -Filter "Name='Weixin.exe'" | Where-Object { $_.ExecutablePath -eq $Executable -and $_.CommandLine -notmatch '--type=|--crashpad-handler' })
if ($processes.Count -ne 1) { throw 'Open exactly one matching WeChat main process before loading its native text sender.' }
$targetPid = [int]$processes[0].ProcessId
$listener = @(Get-NetTCPConnection -LocalPort $uri.Port -State Listen -ErrorAction SilentlyContinue)
if ($listener.Count -and @($listener | Where-Object OwningProcess -ne $targetPid).Count) { throw 'HOOK_PORT_OWNER_MISMATCH' }
# Explicit load only: no client-file replacement, window controls, restarts or
# credential extraction. The DLL independently checks the loaded core's profile.
& $loader $targetPid
if ($LASTEXITCODE -ne 0) { throw 'Native text loader failed; no automatic reload attempted.' }
. (Join-Path $PSScriptRoot 'hook-client-health.ps1')
Wait-HookClient $Executable $BaseUrl '4.1.15.13' $tokenFile
$health = Invoke-RestMethod -Uri ($BaseUrl.TrimEnd('/')+'/WeChatAgent/health') -Headers @{Authorization='Bearer '+$token} -TimeoutSec 2
if($health.profile -ne $build.profile -or $health.nativeImageSend -ne $true -or $health.nativeMentionSend -ne $true){
    throw 'An older sender is still loaded. Exit/reopen the matching WeChat normally, then load this build; no automatic unload or restart was attempted.'
}
Write-Output 'Current-version native text/image/mention APIs ready; finish login and run hook:check.'
