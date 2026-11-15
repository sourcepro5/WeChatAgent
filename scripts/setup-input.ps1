$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$config=Get-Content -LiteralPath (Join-Path $root 'config\wechatagent.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$distributionFile=Join-Path $root 'config\distribution.json'
$check="import psutil,win32api,win32clipboard,win32gui,win32process; print('Foreground input dependencies ready; no OCR or mouse automation required.')"
if(Test-Path -LiteralPath $distributionFile){
    $distribution=Get-Content -LiteralPath $distributionFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if($distribution.installed -eq $true -and $distribution.foregroundInputPython){
        & $distribution.foregroundInputPython -B -c $check
        if ($LASTEXITCODE -ne 0) { throw 'INPUT_DEPENDENCIES_VERIFY_FAILED' }
        Write-Output 'Using the bundled foreground input runtime.'
        exit 0
    }
}
$basePython=$config.runtime.python
$environment=Join-Path $root 'state\input\venv'
$python=Join-Path $environment 'Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) {
    & $basePython -m venv $environment
    if ($LASTEXITCODE -ne 0) { throw 'INPUT_ENVIRONMENT_CREATE_FAILED' }
}
& $python -m pip install --disable-pip-version-check --requirement (Join-Path $PSScriptRoot 'input-requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'INPUT_DEPENDENCIES_INSTALL_FAILED' }
& $python -B -c $check
if ($LASTEXITCODE -ne 0) { throw 'INPUT_DEPENDENCIES_VERIFY_FAILED' }
Write-Output ('Input Python: '+$python)
