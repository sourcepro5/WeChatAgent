$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$config = Get-Content -LiteralPath (Join-Path $root 'config\wechatagent.json') -Raw -Encoding UTF8 | ConvertFrom-Json
& $config.runtime.python -B (Join-Path $PSScriptRoot 'check-runtime.py')
if ($LASTEXITCODE -ne 0) { throw 'Bundled Python runtime verification failed. Reinstall the application while retaining user data.' }
& node --version
if ($LASTEXITCODE -ne 0) { throw 'Node runtime verification failed.' }
