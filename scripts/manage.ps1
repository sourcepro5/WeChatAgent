param([ValidateSet('start','stop','restart','status','prepare')][string]$Action = 'start')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$stateDir = Join-Path $root 'state'
$recordFile = Join-Path $stateDir 'runtime.json'
$script:record = @{}
if (Test-Path -LiteralPath $recordFile) {
    $saved = Get-Content -LiteralPath $recordFile -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($property in $saved.PSObject.Properties) { $script:record[$property.Name] = $property.Value }
}
function Save-Record { $script:record | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $recordFile -Encoding UTF8 }
function Test-Port([int]$Port) {
    $client = [System.Net.Sockets.TcpClient]::new()
    try { $task = $client.ConnectAsync('127.0.0.1',$Port); return ($task.Wait(700) -and $client.Connected) }
    catch { return $false } finally { $client.Dispose() }
}
function Owned-Process($Item) {
    if (-not $Item) { return $null }
    $process = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $Item.pid)
    if (-not $process) { return $null }
    if ($process.ExecutablePath -ne $Item.exe -or $process.CommandLine.IndexOf($Item.marker,[StringComparison]::OrdinalIgnoreCase) -lt 0) { throw 'Recorded PID no longer belongs to WeChatAgent; refusing to stop it.' }
    return $process
}
function Stop-Services {
    $externalWeFlow = $false
    $settingsFile = Join-Path $root 'config\wechatagent.json'
    if (Test-Path -LiteralPath $settingsFile) {
        $settings = Get-Content $settingsFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $externalWeFlow = $settings.runtime.weflowMode -eq 'existing'
    }
    foreach ($name in @('adapter','bridge','reader','weflow')) {
        if ($name -eq 'weflow' -and $externalWeFlow) { continue }
        if ($script:record.ContainsKey($name)) {
            $item = $script:record[$name]
            if (Owned-Process $item) {
                $stoppedGracefully = $false
                if ($name -eq 'weflow') {
                    try {
                        $api = Get-Content (Join-Path $stateDir 'wechat-io-config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
                        $null = Invoke-RestMethod ($api.reader_base_url + '/api/v1/wechatagent/shutdown') -Method Post -Headers @{Authorization='Bearer '+$api.reader_token} -TimeoutSec 3
                        Wait-Process -Id $item.pid -Timeout 10 -ErrorAction Stop
                        $stoppedGracefully = $true
                    } catch {}
                }
                if (-not $stoppedGracefully) { Stop-Process -Id $item.pid -ErrorAction Stop; Wait-Process -Id $item.pid -Timeout 10 -ErrorAction SilentlyContinue }
            }
            $script:record.Remove($name); Save-Record
            Write-Output ($name + ' stopped.')
        }
    }
}
function Start-ServiceProcess([string]$Name,[string]$Exe,[string]$Arguments,[string]$Directory,[string]$Marker,[int]$Port,[bool]$Visible) {
    if (Test-Port $Port) {
        $item = $script:record[$Name]
        if (-not (Owned-Process $item)) { throw ($Name + ' port is used by another installation. Stop that installation before starting WeChatAgent.') }
        $owners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique)
        if ($owners -notcontains [int]$item.pid) { throw ('Unexpected owner of ' + $Name + ' port.') }
        return
    }
    $style = if ($Visible) { 'Normal' } else { 'Hidden' }
    $process = Start-Process -FilePath $Exe -ArgumentList $Arguments -WorkingDirectory $Directory -WindowStyle $style -PassThru -RedirectStandardOutput (Join-Path $stateDir ('logs\'+$Name+'.stdout.log')) -RedirectStandardError (Join-Path $stateDir ('logs\'+$Name+'.stderr.log'))
    $script:record[$Name] = @{pid=$process.Id;exe=$Exe;marker=$Marker}; Save-Record
    for ($i=0;$i -lt 80 -and -not (Test-Port $Port);$i++) {
        if ($process.HasExited) { throw ($Name + ' exited; see state/logs/'+$Name+'.stderr.log') }
        Start-Sleep -Milliseconds 250
    }
    if (-not (Test-Port $Port)) { throw ($Name + ' API not ready. Finish its setup in the opened window, then start again.') }
}
function Show-Status($Config) {
    $hookSender = $Config.runtime.sender -eq 'wechat-hook'
    Write-Output 'Sender: wechat-hook (native HTTP)'
    foreach ($property in $Config.ports.PSObject.Properties) { Write-Output ($property.Name + ': ' + (Test-Port ([int]$property.Value))) }
    $wechatRunning = [bool](Get-Process Weixin,WeChat -ErrorAction SilentlyContinue)
    Write-Output ('WeChat desktop running: ' + $wechatRunning)
    if (-not $wechatRunning) { Write-Output 'Open desktop WeChat and log in to receive new messages.' }
    $databaseReady = $false
    $databaseError = ''
    if (Test-Port ([int]$Config.ports.weflow)) {
        try {
            $api = Get-Content (Join-Path $stateDir 'wechat-io-config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
            $result = Invoke-RestMethod ($api.reader_base_url + '/api/v1/sessions?limit=1') -Headers @{Authorization='Bearer '+$api.reader_token} -TimeoutSec 3
            $databaseReady = $result.success -ne $false
        } catch {
            $databaseError = 'Account/API verification failed; see state/logs/sync.stderr.log.'
            if ($_.ErrorDetails.Message -match '读取组件已过期|expired') { $databaseError = 'Native database component expired.' }
        }
    }
    Write-Output ('Database ready: ' + $databaseReady)
    if ($databaseReady -and (-not $Config.runtime.weflowMode -or $Config.runtime.weflowMode -eq 'nt')) {
        $readerStatus = Invoke-RestMethod ($api.reader_base_url + '/api/v1/reader/status') -Headers @{Authorization='Bearer '+$api.reader_token} -TimeoutSec 3
        Write-Output ('Reader polling healthy: ' + (-not [bool]$readerStatus.lastError))
    }
    if ($databaseError) { Write-Output $databaseError }
    if (Test-Port ([int]$Config.ports.adapter)) {
        $status = Invoke-RestMethod ('http://127.0.0.1:'+$Config.ports.adapter+'/status') -TimeoutSec 3
        Write-Output ('OneBot connected: '+$status.ob_connected); Write-Output ('Reader connected: '+$status.reader_connected)
        if ($hookSender) {
            Write-Output ('Hook connected: '+$status.hook_connected)
            Write-Output ('Hook account verified: '+$status.hook_account_verified)
            Write-Output ('Hook version: '+$status.version)
            if ($status.last_error) { Write-Output ('Hook last error: '+$status.last_error) }
        }
    }
    Write-Output ('Logs: '+(Join-Path $stateDir 'logs'))
}
if ($Action -eq 'stop') { Stop-Services; exit 0 }
$node = (Get-Command node -ErrorAction Stop).Source
& $node (Join-Path $PSScriptRoot 'project-config.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Invalid project configuration.' }
$config = Get-Content (Join-Path $root 'config\wechatagent.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$hookSender = $config.runtime.sender -eq 'wechat-hook'
if ($Action -eq 'prepare') { exit 0 }
if ($Action -eq 'status') { Show-Status $config; exit 0 }
if ($Action -eq 'restart') { Stop-Services }
$python = (Get-Command $config.runtime.python -ErrorAction Stop).Source
$weflowRoot = Join-Path $root 'components\WeFlowComplete'
$electron = Join-Path $weflowRoot 'node_modules\electron\dist\electron.exe'
$externalWeFlow = $config.runtime.weflowMode -eq 'existing'
$ntReader = -not $config.runtime.weflowMode -or $config.runtime.weflowMode -eq 'nt'
if (-not $externalWeFlow -and -not $ntReader -and (-not (Test-Path -LiteralPath $electron) -or -not (Test-Path -LiteralPath (Join-Path $weflowRoot 'dist\index.html')))) { throw 'Run npm run setup to install and build WeFlow.' }
$names = @('ELECTRON_RUN_AS_NODE','WEFLOW_CONFIG_CWD','WEFLOW_USER_DATA_PATH','AUTO_UPDATE_ENABLED','SOCIAL_DSH_TOKEN','PYTHONUTF8','PYTHONUNBUFFERED','WECHATAGENT_LOG_DIR','WECHATAGENT_STATE_DIR')
$previous = @{}; foreach ($name in $names) { $previous[$name] = [Environment]::GetEnvironmentVariable($name,'Process') }
try {
    $env:ELECTRON_RUN_AS_NODE = $null
    $env:WEFLOW_CONFIG_CWD = Join-Path $weflowRoot '.local-state'; $env:WEFLOW_USER_DATA_PATH = $null
    $env:AUTO_UPDATE_ENABLED = '0'
    $env:PYTHONUTF8='1'; $env:PYTHONUNBUFFERED='1'
    if ($ntReader) {
        $readerEntry = Join-Path $PSScriptRoot 'reader-api.py'
        Start-ServiceProcess 'reader' $python ('"'+$readerEntry+'"') $root $readerEntry ([int]$config.ports.weflow) $false
    } elseif ($externalWeFlow) {
        if (-not (Test-Port ([int]$config.ports.weflow))) { throw 'Open your existing WeFlow and enable its API before starting WeChatAgent.' }
        Write-Output 'Using existing WeFlow API; its process and encrypted configuration are not managed here.'
    } else {
        Start-ServiceProcess 'weflow' $electron ('"'+$weflowRoot+'"') $weflowRoot $weflowRoot ([int]$config.ports.weflow) $true
    }
    $sync = Start-Process -FilePath $node -ArgumentList ('"'+(Join-Path $PSScriptRoot 'sync-weflow.cjs')+'"') -WorkingDirectory $root -WindowStyle Hidden -PassThru -Wait -RedirectStandardOutput (Join-Path $stateDir 'logs\sync.stdout.log') -RedirectStandardError (Join-Path $stateDir 'logs\sync.stderr.log')
    if ($sync.ExitCode -ne 0) {
        $detail = (Get-Content (Join-Path $stateDir 'logs\sync.stderr.log') -Raw).Trim()
        throw ('WeFlow account/API verification failed: ' + $detail + '. Open WeFlow settings; details: state/logs/sync.stderr.log')
    }
    if ($hookSender) {
        & $node (Join-Path $PSScriptRoot 'hook-onebot.mjs') --check
        if ($LASTEXITCODE -ne 0) { throw 'WeChat-Hook is not ready. Open Launch-Hook-WeChat.cmd, log in to the configured account, then start again. See state/logs/reader.stderr.log for receiver errors.' }
    }
    $env:SOCIAL_DSH_TOKEN = (Get-Content (Join-Path $stateDir 'social-dsh-token.txt') -Raw).Trim()
    $dshUrl = 'http://127.0.0.1:'+$config.ports.dshPlugin+'/health'
    if (-not (Test-Port ([int]$config.ports.dshPlugin)) -and $config.runtime.dshDesktop -and (Test-Path -LiteralPath $config.runtime.dshDesktop)) {
        Start-Process -FilePath $config.runtime.dshDesktop -WindowStyle Normal | Out-Null
        for($i=0;$i -lt 60 -and -not (Test-Port ([int]$config.ports.dshPlugin));$i++){Start-Sleep -Milliseconds 250}
    }
    $health = Invoke-RestMethod $dshUrl -Headers @{Authorization='Bearer '+$env:SOCIAL_DSH_TOKEN} -TimeoutSec 3
    if ($health.ok -ne $true -or $health.project -ne 'WeChatAgent' -or [IO.Path]::GetFullPath($health.projectRoot) -ne [IO.Path]::GetFullPath($root)) { throw 'Install the DSH plugin from this project packages directory, then fully reopen DSH.' }
    if ($health.contextMode -ne 'native-session-v1') { throw 'Fully exit DSH from the tray and reopen it to load the native-session plugin.' }
    if ($health.behaviorPolicy -ne 'local-config-only-v1') { throw 'Fully reopen DSH to load the local-only behavior policy before starting WeChatAgent.' }
    if ($ntReader -and $health.imageInput -ne 'native-attachment-v1') { throw 'Fully exit DSH from the tray and reopen it to load the image attachment plugin.' }
    $bridgeEntry = Join-Path $root 'components\qq-bridge\src\social-bridge.js'
    Start-ServiceProcess 'bridge' $node ('"'+$bridgeEntry+'" "'+(Join-Path $stateDir 'bridge-config.json')+'"') (Join-Path $root 'components\qq-bridge') $bridgeEntry ([int]$config.ports.onebot) $false
    $env:PYTHONUTF8='1'; $env:PYTHONUNBUFFERED='1'
    $env:WECHATAGENT_LOG_DIR=$null; $env:WECHATAGENT_STATE_DIR=$null
    $adapterEntry = Join-Path $PSScriptRoot 'hook-onebot.mjs'
    Start-ServiceProcess 'adapter' $node ('"'+$adapterEntry+'"') $root $adapterEntry ([int]$config.ports.adapter) $false
    for($i=0;$i -lt 20;$i++) {
        $status=Invoke-RestMethod ('http://127.0.0.1:'+$config.ports.adapter+'/status') -TimeoutSec 3
        if($status.ob_connected -and $status.reader_connected){break}; Start-Sleep -Milliseconds 250
    }
    Show-Status $config
} finally { foreach($name in $names){[Environment]::SetEnvironmentVariable($name,$previous[$name],'Process')} }
