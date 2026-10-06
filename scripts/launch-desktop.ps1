$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
try {
    $entry = Join-Path $root 'WeChatAgent.exe'
    if (-not (Test-Path -LiteralPath $entry) -or -not (Test-Path -LiteralPath (Join-Path $root 'release\WeChatAgent\WeChatAgent.exe'))) {
        $node = (Get-Command node -ErrorAction Stop).Source
        & $node (Join-Path $PSScriptRoot 'build-desktop.mjs')
        if ($LASTEXITCODE -ne 0) { throw 'Desktop build failed.' }
    }
    Start-Process -FilePath $entry -WorkingDirectory $root -WindowStyle Normal | Out-Null
} catch {
    Add-Type -AssemblyName System.Windows.Forms
    [Windows.Forms.MessageBox]::Show($_.Exception.Message, 'WeChatAgent', [Windows.Forms.MessageBoxButtons]::OK, [Windows.Forms.MessageBoxIcon]::Error) | Out-Null
    exit 1
}
