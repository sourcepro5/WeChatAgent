param([string]$MsBuild = '')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root 'components\WeChat-Hook'
$build = Join-Path $root 'state\hook\build-source'
$output = Join-Path $root 'state\hook\native'
if (-not (Test-Path -LiteralPath (Join-Path $source 'x64_Version_dll.vcxproj'))) { throw 'Download components/WeChat-Hook from https://github.com/aixed/WeChat-Hook first.' }
$commit = (& git -C $source rev-parse HEAD).Trim()
if ($commit -ne 'e905d07ade50d2c6472e4eb3bd4f3fe19cf662c6') { throw 'Upstream source differs from the reviewed commit. Recheck the integration before building.' }
New-Item -ItemType Directory -Path $build,$output -Force | Out-Null
foreach ($entry in Get-ChildItem -LiteralPath $source -Force) {
    if ($entry.Name -eq '.git') { continue }
    Copy-Item -LiteralPath $entry.FullName -Destination $build -Recurse -Force
}
$encoding = [Text.UTF8Encoding]::new($false)
function Replace-Checked([string]$File,[string]$Before,[string]$After) {
    $text = [IO.File]::ReadAllText($File)
    if (-not $text.Contains($Before)) { throw ('Expected upstream code missing: ' + $File) }
    [IO.File]::WriteAllText($File,$text.Replace($Before,$After),$encoding)
}
Replace-Checked (Join-Path $build 'src\inline_weixin_dll_load.cpp') 'g_httpServer->Start("0.0.0.0", g_StartPort);' 'g_httpServer->Start("127.0.0.1", g_StartPort);'
Replace-Checked (Join-Path $build 'src\inline_weixin_dll_load.cpp') '    Patch_Revoke();' '    // WeChatAgent does not change message recall behavior.'
Replace-Checked (Join-Path $build 'dllmain.cpp') 'HideModuleFromPEB(hModule);' '// WeChatAgent keeps the module visible for diagnostics.'
[IO.File]::WriteAllText((Join-Path $build 'src\http_routes.cpp'),"#include `"http_routes.h`"`n#include `"wechatagent_hook.h`"`nvoid RegisterRoutes(httplib::Server& server) { RegisterWeChatAgentRoutes(server); }`n",$encoding)
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'native-hook\wechatagent_hook.h') -Destination (Join-Path $build 'include') -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'native-hook\wechatagent_hook.cpp') -Destination (Join-Path $build 'src') -Force
$project = Join-Path $build 'x64_Version_dll.vcxproj'
Replace-Checked $project '<ClCompile Include="src\http_routes.cpp" />' '<ClCompile Include="src\http_routes.cpp" /><ClCompile Include="src\wechatagent_hook.cpp" />'
Replace-Checked $project 'psapi.lib;gdiplus.lib;' 'version.lib;psapi.lib;gdiplus.lib;'
if (-not $MsBuild) {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path -LiteralPath $vswhere)) { throw 'Install Visual Studio C++ Build Tools, or provide -MsBuild.' }
    $MsBuild = (& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -find 'MSBuild\**\Bin\MSBuild.exe' | Select-Object -First 1)
}
if (-not $MsBuild) { throw 'Visual Studio C++ compiler not found.' }
Push-Location $build
try {
    & $MsBuild $project /m /t:Build /p:Configuration=Release /p:Platform=x64 /p:PlatformToolset=v143 /v:minimal /nologo
    if ($LASTEXITCODE -ne 0) { throw 'Native Hook build failed.' }
} finally { Pop-Location }
$dll = Join-Path $build 'x64\Release\version.dll'
Copy-Item -LiteralPath $dll -Destination (Join-Path $output 'version.dll') -Force
@{ upstream='https://github.com/aixed/WeChat-Hook'; commit=$commit; targetVersion='4.1.10.27'; integration='WeChatAgent-1'; sha256=(Get-FileHash -LiteralPath $dll -Algorithm SHA256).Hash.ToLowerInvariant() } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output 'build.json') -Encoding UTF8
Write-Output 'Native sender compiled: state/hook/native/version.dll (loopback, token, account/version checks).'
