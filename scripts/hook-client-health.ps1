function Open-HookClient([string]$Executable,[string]$BaseUrl,[ValidateRange(0,120)][int]$TimeoutSeconds=35) {
    $Executable=[IO.Path]::GetFullPath($Executable)
    $uri=[Uri]$BaseUrl
    if($uri.Scheme -ne 'http' -or $uri.Host -ne '127.0.0.1' -or $uri.UserInfo -or $uri.AbsolutePath -ne '/' -or $uri.Query -or $uri.Fragment -or $uri.Port -lt 1024 -or $uri.Port -gt 65535){throw 'HOOK_LOOPBACK_REQUIRED'}
    $clients=@(Get-CimInstance Win32_Process -Filter "Name='Weixin.exe'" | Where-Object {$_.CommandLine -notmatch '--type=|--crashpad-handler'})
    $matching=@($clients | Where-Object {$_.ExecutablePath -eq $Executable})
    if($matching.Count -gt 1){throw 'WECHAT_MULTIPLE_MATCHING_CLIENTS'}
    if(@($clients | Where-Object {$_.ExecutablePath -and $_.ExecutablePath -ne $Executable}).Count){throw 'WECHAT_OTHER_CLIENT_RUNNING: Exit the other WeChat normally before opening the configured client.'}
    if(@($clients | Where-Object {-not $_.ExecutablePath}).Count){throw 'WECHAT_CLIENT_PATH_UNAVAILABLE: Existing WeChat process identity is not available; retry after startup finishes.'}
    if(-not $matching.Count){
        if(@(Get-NetTCPConnection -LocalPort $uri.Port -State Listen -ErrorAction SilentlyContinue).Count){throw 'HOOK_PORT_OWNER_MISMATCH'}
        Write-Output 'Starting the configured WeChat client...'
        try{Start-Process -FilePath $Executable -WorkingDirectory (Split-Path -Parent $Executable) -WindowStyle Normal -PassThru -ErrorAction Stop | Out-Null}
        catch{throw 'WECHAT_LAUNCH_FAILED: '+$_.Exception.Message}
    }
    $watch=[Diagnostics.Stopwatch]::StartNew()
    do {
        $clients=@(Get-CimInstance Win32_Process -Filter "Name='Weixin.exe'" | Where-Object {$_.CommandLine -notmatch '--type=|--crashpad-handler'})
        if(@($clients | Where-Object {$_.ExecutablePath -and $_.ExecutablePath -ne $Executable}).Count){throw 'WECHAT_OTHER_CLIENT_RUNNING'}
        $unresolved=@($clients | Where-Object {-not $_.ExecutablePath})
        $matching=@($clients | Where-Object {$_.ExecutablePath -eq $Executable})
        if($matching.Count -eq 1 -and -not $unresolved.Count){
            try{
                $client=Get-Process -Id ([int]$matching[0].ProcessId) -ErrorAction Stop
                if(-not $client.HasExited -and $client.Path -eq $Executable -and @($client.Modules | Where-Object {$_.ModuleName -eq 'Weixin.dll'}).Count){
                    Write-Output 'Matching WeChat core is loaded; preparing its sender...'
                    return
                }
            }catch{}
        }
        if($watch.Elapsed.TotalSeconds -ge $TimeoutSeconds){break}
        Start-Sleep -Milliseconds 200
    }while($watch.Elapsed.TotalSeconds -lt $TimeoutSeconds)
    if($unresolved.Count){throw 'WECHAT_CLIENT_PATH_UNAVAILABLE: WeChat process identity did not become available before the startup deadline.'}
    throw 'WECHAT_STARTUP_TIMEOUT: The configured WeChat did not finish loading its core.'
}

# Health is independent of reader setup: the client can be healthy before login.
function Wait-HookClient([string]$Executable,[string]$BaseUrl,[string]$ExpectedVersion,[string]$TokenFile,[int]$TimeoutSeconds=35) {
    $token=(Get-Content -LiteralPath $TokenFile -Raw -Encoding UTF8).Trim()
    if($token -notmatch '^[a-f0-9]{64}$'){throw 'HOOK_TOKEN_MISSING'}
    $watch=[Diagnostics.Stopwatch]::StartNew();$missingSince=$null
    do {
        $matching=@(Get-CimInstance Win32_Process -Filter "Name='Weixin.exe'" | Where-Object { $_.ExecutablePath -eq $Executable -and $_.CommandLine -notmatch '--type=|--crashpad-handler' })
        if(-not $matching.Count){
            if($null -eq $missingSince){$missingSince=$watch.ElapsedMilliseconds}
            if($watch.ElapsedMilliseconds-$missingSince -ge 8000){throw 'WECHAT_LAUNCH_EXITED: No matching client survived the launcher handoff.'}
        } else {$missingSince=$null}
        $health=$null
        try {$health=Invoke-RestMethod -Uri ($BaseUrl.TrimEnd('/')+'/WeChatAgent/health') -Headers @{Authorization='Bearer '+$token} -TimeoutSec 1} catch {
            $status=$_.Exception.Response.StatusCode
            if($status -and [int]$status -eq 401){throw 'HOOK_AUTH_FAILED: Exit and reopen the matching client to refresh its local token.'}
        }
        if($health){
            if($health.integration -ne 'WeChatAgent-1' -or $health.backend -ne 'wechat-hook'){throw 'HOOK_HEALTH_INVALID_RESPONSE'}
            if($health.version -ne $ExpectedVersion){throw 'HOOK_VERSION_MISMATCH'}
            if($ExpectedVersion -eq '4.1.15.13' -and ($health.profile -notin @('4.1.15.13-text-v1','4.1.15.13-media-mentions-v2') -or $health.nativeTextSend -ne $true)){throw 'HOOK_PROFILE_MISMATCH'}
            if($ExpectedVersion -eq '4.2.0.12' -and ($health.profile -ne '4.2.0.12-experimental-v1' -or $health.nativeTextSend -ne $true)){throw 'HOOK_PROFILE_MISMATCH'}
            if([int]$health.pid -notin @($matching | ForEach-Object {[int]$_.ProcessId})){
                # The launcher can hand over between the snapshot and HTTP reply.
                $matching=@(Get-CimInstance Win32_Process -Filter "Name='Weixin.exe'" | Where-Object { $_.ExecutablePath -eq $Executable -and $_.CommandLine -notmatch '--type=|--crashpad-handler' })
                if([int]$health.pid -notin @($matching | ForEach-Object {[int]$_.ProcessId})){throw 'HOOK_PORT_OWNER_MISMATCH: The listener does not belong to this matching client.'}
            }
            if($health.startupState -eq 'ready'){return}
        }
        Start-Sleep -Milliseconds 400
    } while($watch.Elapsed.TotalSeconds -lt $TimeoutSeconds)
    throw 'HOOK_CLIENT_UNHEALTHY: Matching client exists but its sender is not ready. Use Repair WeChat connection, confirm restarting the matching client, then log in again. See state/logs/hook-init.log.'
}
