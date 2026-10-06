$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$config = Get-Content -LiteralPath (Join-Path $root 'config\wechatagent.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $config.runtime.dshDesktop -or -not (Test-Path -LiteralPath $config.runtime.dshDesktop)) { throw 'Select the DSH program in connection settings first.' }
Start-Process -FilePath $config.runtime.dshDesktop -WorkingDirectory (Split-Path -Parent $config.runtime.dshDesktop) -WindowStyle Normal | Out-Null
Write-Output 'DSH opened. Sign in, enable the local WeChatAgent plugin, then restart DSH from its tray menu.'
