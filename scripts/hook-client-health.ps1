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
            if($ExpectedVersion -eq '4.1.15.13' -and ($health.profile -ne '4.1.15.13-text-v1' -or $health.nativeTextSend -ne $true)){throw 'HOOK_PROFILE_MISMATCH'}
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
