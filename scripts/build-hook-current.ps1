param([string]$HeadersRoot = '',[string]$VcVars = '',[string]$BuildDirectory = '',[string]$OutputDirectory = '')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $HeadersRoot) { $HeadersRoot = Join-Path $root 'components\WeChat-Hook' }
$HeadersRoot = [IO.Path]::GetFullPath($HeadersRoot)
foreach ($relative in @('include\json.hpp','3rdparty\httplib\httplib.h')) {
    if (-not (Test-Path -LiteralPath (Join-Path $HeadersRoot $relative))) { throw ('Header dependency missing: '+$relative+'; prepare components/WeChat-Hook or pass -HeadersRoot.') }
}
# Only header dependencies are used here; the old native implementation and its
# pinned-source build remain in build-hook.ps1 and are not linked into this DLL.
if (-not $VcVars) {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path -LiteralPath $vswhere)) { throw 'Visual Studio 2022 C++ Build Tools (v143) required.' }
    $installation = (& $vswhere -all -latest -version '[17.0,18.0)' -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1)
    if (-not $installation) { throw 'Visual Studio 2022 C++ Build Tools (v143) required; alternatively pass its -VcVars path.' }
    $VcVars = Join-Path $installation 'VC\Auxiliary\Build\vcvars64.bat'
}
if (-not (Test-Path -LiteralPath $VcVars)) { throw 'VC x64 environment script not found.' }
$build = Join-Path $root 'state\hook\build-4.1.15.13'
$output = Join-Path $root 'state\hook\native-4.1.15.13'
foreach ($taskOverride in @(@{value=$BuildDirectory;name='build'},@{value=$OutputDirectory;name='output'})) {
    if (-not $taskOverride.value) { continue }
    $taskPath = if ([IO.Path]::IsPathRooted($taskOverride.value)) { [IO.Path]::GetFullPath($taskOverride.value) } else { [IO.Path]::GetFullPath((Join-Path $root $taskOverride.value)) }
    if (-not $taskPath.StartsWith(([IO.Path]::GetFullPath((Join-Path $root 'state'))+'\'),[StringComparison]::OrdinalIgnoreCase)) { throw 'Custom build paths must stay inside this project state directory.' }
    if ($taskOverride.name -eq 'build') { $build=$taskPath } else { $output=$taskPath }
}
New-Item -ItemType Directory -Path $build,$output -Force | Out-Null
$source = Join-Path $PSScriptRoot 'native-hook'
foreach ($value in @($root,$HeadersRoot,$vcvars,$build,$output)) {
    if ($value -match '[%"\r\n]') { throw 'Build paths may not contain command expansion characters.' }
}
$commands = @(
    '@echo off',
    ('call "'+$vcvars+'" >nul'),
    'if errorlevel 1 exit /b 1',
    ('cd /d "'+$build+'"'),
    ('cl /nologo /O2 /MT /EHsc /std:c++17 /utf-8 /LD /I"'+(Join-Path $HeadersRoot 'include')+'" /I"'+(Join-Path $HeadersRoot '3rdparty\httplib')+'" "'+(Join-Path $source 'text_4_1_15_13.cpp')+'" /link version.lib ws2_32.lib /out:"'+(Join-Path $output 'wechatagent-text-4.1.15.13.dll')+'"'),
    'if errorlevel 1 exit /b 1',
    ('cl /nologo /O2 /MT /EHsc /std:c++17 /utf-8 "'+(Join-Path $source 'text_loader.cpp')+'" /link /out:"'+(Join-Path $output 'wechatagent-text-loader.exe')+'"'),
    'exit /b %errorlevel%'
)
$commandFile = Join-Path $output 'build.cmd'
[IO.File]::WriteAllLines($commandFile,$commands,[Text.UTF8Encoding]::new($false))
& $env:ComSpec /d /c ('"'+$commandFile+'"')
if ($LASTEXITCODE -ne 0) { throw 'Current-version native text build failed.' }
$manifest = @{
    targetVersion='4.1.15.13'; profile='4.1.15.13-media-mentions-v2'; integration='WeChatAgent-1';
    nativeTextSend=$true; nativeImageSend=$true; nativeMentionSend=$true; nativeQuoteSend=$false; nativeStickerSend=$false;
    sha256=(Get-FileHash -LiteralPath (Join-Path $output 'wechatagent-text-4.1.15.13.dll') -Algorithm SHA256).Hash.ToLowerInvariant();
    loaderSha256=(Get-FileHash -LiteralPath (Join-Path $output 'wechatagent-text-loader.exe') -Algorithm SHA256).Hash.ToLowerInvariant()
}
$manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output 'build.json') -Encoding UTF8
Write-Output 'Built 4.1.15.13 native text/image/mention components; no WeChat process was changed.'
