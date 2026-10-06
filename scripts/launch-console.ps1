param([int]$Port = 3210, [switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$logDir = Join-Path $root 'state\logs'
try {
    if ($Port -lt 1024 -or $Port -gt 65535) { throw 'Invalid console port.' }
    $url = 'http://127.0.0.1:' + $Port
    $connected = $false
    try {
        $info = Invoke-RestMethod ($url + '/api/info') -TimeoutSec 2
        if ($info.project -ne 'WeChatAgent Console' -or [IO.Path]::GetFullPath($info.root) -ne $root) { throw 'Console port is used by a different project.' }
        $connected = $true
    } catch {
        $client = [Net.Sockets.TcpClient]::new()
        $occupied = $false
        try {
            $task = $client.ConnectAsync('127.0.0.1', $Port)
            $occupied = $task.Wait(500) -and $client.Connected
        } catch {} finally { $client.Dispose() }
        if ($occupied) { throw 'Console port is occupied. Close the other console or choose another port.' }
    }
    if (-not $connected) {
        $node = (Get-Command node -ErrorAction Stop).Source
        New-Item -ItemType Directory -Force -Path $logDir | Out-Null
        $previousConsolePort = $env:WECHATAGENT_CONSOLE_PORT
        try {
            $env:WECHATAGENT_CONSOLE_PORT = [string]$Port
            $process = Start-Process -FilePath $node -ArgumentList ('"' + (Join-Path $PSScriptRoot 'console-server.mjs') + '"') -WorkingDirectory $root -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logDir 'console.stdout.log') -RedirectStandardError (Join-Path $logDir 'console.stderr.log')
        } finally { $env:WECHATAGENT_CONSOLE_PORT = $previousConsolePort }
        for ($i = 0; $i -lt 50; $i++) {
            if ($process.HasExited) { throw 'Console failed to start. See state/logs/console.stderr.log.' }
            try {
                $info = Invoke-RestMethod ($url + '/api/info') -TimeoutSec 1
                if ($info.project -ne 'WeChatAgent Console' -or [IO.Path]::GetFullPath($info.root) -ne $root) { throw 'Console identity mismatch.' }
                $connected = $true
                break
            } catch { Start-Sleep -Milliseconds 200 }
        }
        if (-not $connected) { throw 'Console did not respond. See state/logs/console.stderr.log.' }
    }
    if (-not $NoBrowser) { Start-Process -FilePath $url -WindowStyle Normal | Out-Null }
} catch {
    Add-Type -AssemblyName System.Windows.Forms
    [Windows.Forms.MessageBox]::Show($_.Exception.Message, 'WeChatAgent Console', [Windows.Forms.MessageBoxButtons]::OK, [Windows.Forms.MessageBoxIcon]::Error) | Out-Null
    exit 1
}
