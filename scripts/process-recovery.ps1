param([ValidateSet('Inspect','Stop')][string]$Mode,[string]$RequestBase64)
$ErrorActionPreference='Stop'
$stopped=@()
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
try {
    $request=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($RequestBase64))|ConvertFrom-Json
    Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class RecoveryProcess {
 [DllImport("kernel32.dll",SetLastError=true)] public static extern IntPtr OpenProcess(uint access,bool inherit,int id);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool GetProcessTimes(IntPtr handle,out long created,out long exited,out long kernel,out long user);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool QueryFullProcessImageName(IntPtr handle,int flags,StringBuilder path,ref int size);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool IsProcessCritical(IntPtr handle,out bool critical);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool TerminateProcess(IntPtr handle,uint code);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool GetExitCodeProcess(IntPtr handle,out uint code);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
}
'@ | Out-Null
    $userSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    function Identity($processId,[bool]$terminate=$false) {
        $rights=0x1000;if($terminate){$rights=$rights -bor 1 -bor 0x100000}
        $handle=[RecoveryProcess]::OpenProcess($rights,$false,$processId)
        if($handle -eq [IntPtr]::Zero){return $null}
        try {
            $created=0L;$exited=0L;$kernel=0L;$user=0L;$critical=$true
            $buffer=[Text.StringBuilder]::new(32768);$length=32768
            if(-not [RecoveryProcess]::GetProcessTimes($handle,[ref]$created,[ref]$exited,[ref]$kernel,[ref]$user) -or -not [RecoveryProcess]::QueryFullProcessImageName($handle,0,$buffer,[ref]$length) -or -not [RecoveryProcess]::IsProcessCritical($handle,[ref]$critical)){return $null}
            $value=@{start=$created.ToString();path=$buffer.ToString();critical=$critical}
            if($terminate){$value.handle=$handle;$handle=[IntPtr]::Zero}
            return $value
        } finally {if($handle -ne [IntPtr]::Zero){[RecoveryProcess]::CloseHandle($handle)|Out-Null}}
    }
    function Command-Hash($value) {
        $sha=[Security.Cryptography.SHA256]::Create()
        try{return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes([string]$value)))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
    }
    if($Mode -eq 'Inspect') {
        $owners=@{}
        foreach($port in @($request.ports)) {
            $listeners=@(Get-NetTCPConnection -LocalPort ([int]$port) -ErrorAction SilentlyContinue | Where-Object {
                $_.LocalAddress -in @('127.0.0.1','0.0.0.0','::') -and (
                    [string]$_.State -in @('Listen','Bound') -or
                    ([string]::IsNullOrEmpty([string]$_.State) -and [int]$_.RemotePort -eq 0)
                )
            })
            foreach($listener in $listeners) {
                $key=[string]$listener.OwningProcess
                if(-not $owners.ContainsKey($key)){$owners[$key]=@()};$owners[$key]+=[int]$port
            }
        }
        $wechat=@(Get-CimInstance Win32_Process -Filter "Name='Weixin.exe' OR Name='WeChat.exe'"|Where-Object {
            if($request.matchingWeChatOnly){$_.ExecutablePath -eq $request.wechatExecutable}
            else {$_.CommandLine -notmatch '--type=|--crashpad-handler' -and ($request.includeMatchingWeChat -or $_.ExecutablePath -ne $request.wechatExecutable)}
        })
        foreach($entry in $wechat){if(-not $owners.ContainsKey([string]$entry.ProcessId)){$owners[[string]$entry.ProcessId]=@()}}
        $items=@()
        foreach($key in $owners.Keys) {
            $entry=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$key)
            if(-not $entry){continue}
            if($request.matchingWeChatOnly -and $entry.ExecutablePath -ne $request.wechatExecutable){continue}
            if(-not $request.includeMatchingWeChat -and $entry.ExecutablePath -eq $request.wechatExecutable){continue}
            $identity=Identity ([int]$key);$owner=Invoke-CimMethod -InputObject $entry -MethodName GetOwnerSid -ErrorAction SilentlyContinue
            $allowed=$null -ne $identity -and $owner.Sid -eq $userSid -and -not $identity.critical -and $entry.CommandLine -and [int]$key -gt 4 -and [int]$key -ne $PID -and [int]$key -notin @($request.protectedPids)
            if($identity -and $identity.path.StartsWith([IO.Path]::GetFullPath($env:WINDIR)+'\',[StringComparison]::OrdinalIgnoreCase)){$allowed=$false}
            $ports=@($owners[$key]|Sort-Object -Unique)
            $items+=@{pid=[int]$key;name=$entry.Name;path=if($identity){$identity.path}else{[string]$entry.ExecutablePath};start=if($identity){$identity.start}else{''};commandHash=(Command-Hash $entry.CommandLine);ports=$ports;reason=if($request.matchingWeChatOnly){'配置中的匹配微信，确认后停止并重新打开'}elseif($ports.Count){'占用或绑定配置端口 '+($ports -join '、')}else{'另一个微信客户端正在运行'};canStop=[bool]$allowed;blockedReason=if($allowed){''}else{'系统进程、其他用户进程或身份无法核实；请手动处理。'}}
        }
        @{items=$items}|ConvertTo-Json -Depth 5 -Compress
    } else {
        $opened=@();$stopped=@()
        try {
            if(@($request.items).Count -lt 1 -or @($request.items).Count -gt 16){throw 'PROCESS_CHANGED'}
            foreach($item in $request.items) {
                $entry=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$item.pid)
                if(-not $entry -or (Command-Hash $entry.CommandLine) -ne $item.commandHash){throw 'PROCESS_CHANGED'}
                if($request.matchingWeChatOnly -and $entry.ExecutablePath -ne $request.wechatExecutable){throw 'PROCESS_CHANGED'}
                $owner=Invoke-CimMethod -InputObject $entry -MethodName GetOwnerSid
                if($owner.Sid -ne $userSid -or [int]$item.pid -in @($request.protectedPids) -or [int]$item.pid -le 4){throw 'PROCESS_CHANGED'}
                $identity=Identity ([int]$item.pid) $true
                if(-not $identity){throw 'PROCESS_CHANGED'}
                $opened+=@{item=$item;identity=$identity}
                if($identity.critical -or $identity.start -ne $item.start -or $identity.path -ne $item.path -or $identity.path.StartsWith([IO.Path]::GetFullPath($env:WINDIR)+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'PROCESS_CHANGED'}
            }
            foreach($entry in $opened){
                if(-not [RecoveryProcess]::TerminateProcess($entry.identity.handle,0)){
                    $exitCode=[uint32]259
                    if(-not [RecoveryProcess]::GetExitCodeProcess($entry.identity.handle,[ref]$exitCode) -or $exitCode -eq 259){throw 'STOP_FAILED'}
                }
                $stopped+=[int]$entry.item.pid
            }
            foreach($entry in $opened){if([RecoveryProcess]::WaitForSingleObject($entry.identity.handle,1000) -ne 0){throw 'STOP_FAILED'}}
            @{stopped=$stopped}|ConvertTo-Json -Compress
        } finally {foreach($entry in $opened){[RecoveryProcess]::CloseHandle($entry.identity.handle)|Out-Null}}
    }
} catch {
    @{error=if($_.Exception.Message -eq 'PROCESS_CHANGED'){'PROCESS_CHANGED'}else{'PROCESS_OPERATION_FAILED'};stopped=@($stopped)}|ConvertTo-Json -Compress
    exit 1
}
