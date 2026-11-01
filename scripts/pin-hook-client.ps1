param([switch]$Unlock,[switch]$Status)
$ErrorActionPreference='Stop'

function Assert-PinDirectory([string]$Directory){
    $item=Get-Item -LiteralPath $Directory -Force
    if(-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'CLIENT_PIN_LINK_REFUSED: A real directory is required.'}
}
function New-PinDirectory([string]$Directory){
    if(Test-Path -LiteralPath $Directory){Assert-PinDirectory $Directory;return}
    $parent=Split-Path -Parent $Directory
    Assert-PinDirectory $parent
    New-Item -ItemType Directory -Path $Directory | Out-Null
    Assert-PinDirectory $Directory
}
function Get-PinFileVersion([string]$Executable){return [Diagnostics.FileVersionInfo]::GetVersionInfo($Executable).FileVersion}
function Get-PinHash([string]$File){return (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()}
function Initialize-PinSecurity {
    if('WeChatAgent.ClientPinNative' -as [type]){return}
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
namespace WeChatAgent {
    public static class ClientPinNative {
        [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        private static extern uint SetNamedSecurityInfoW(string name, int kind, uint information, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
        public static void SetDacl(string name, byte[] acl, bool protect) {
            var handle=GCHandle.Alloc(acl, GCHandleType.Pinned);
            try {
                uint information=4u | (protect ? 0x80000000u : 0x20000000u);
                uint code=SetNamedSecurityInfoW(name, 1, information, IntPtr.Zero, IntPtr.Zero, handle.AddrOfPinnedObject(), IntPtr.Zero);
                if(code!=0) throw new Win32Exception((int)code);
            } finally { handle.Free(); }
        }
    }
}
'@
}
function Write-PinJson([string]$File,$Value){
    $temporary=$File+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
    [IO.File]::WriteAllText($temporary,($Value | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $File -Force
}
function Write-PinRootAcl([string]$Directory,[string]$Sddl,[string]$File){
    $name=Split-Path -Leaf $Directory
    if($name -match '[\\/\r\n]' -or $name -in @('.','..')){throw 'CLIENT_PIN_INVALID_PATH'}
    $descriptor=[Security.AccessControl.RawSecurityDescriptor]::new($Sddl)
    $dacl=$descriptor.GetSddlForm([Security.AccessControl.AccessControlSections]::Access)
    [IO.File]::WriteAllText($File,($name+"`r`n"+$dacl+"`r`n"),[Text.Encoding]::Unicode)
}
function Restore-PinRootAcl([string]$Directory,[string]$File){
    $lines=[IO.File]::ReadAllLines($File,[Text.Encoding]::Unicode)
    if($lines.Count -ne 2 -or $lines[0] -ne (Split-Path -Leaf $Directory) -or $lines[1] -notmatch '^D:'){throw 'CLIENT_PIN_BACKUP_CHANGED: Invalid root ACL backup.'}
    $descriptor=[Security.AccessControl.RawSecurityDescriptor]::new($lines[1])
    if(-not $descriptor.DiscretionaryAcl){throw 'CLIENT_PIN_BACKUP_CHANGED: Missing DACL.'}
    $bytes=[byte[]]::new($descriptor.DiscretionaryAcl.BinaryLength)
    $descriptor.DiscretionaryAcl.GetBinaryForm($bytes,0)
    $protect=[bool]($descriptor.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected)
    try{[WeChatAgent.ClientPinNative]::SetDacl($Directory,$bytes,$protect)}catch{throw ('CLIENT_PIN_ACL_FAILED: '+$_.Exception.Message)}
}
function Get-PinTarget([string]$Root){
    $Root=[IO.Path]::GetFullPath($Root).TrimEnd('\')
    $config=Get-Content -LiteralPath (Join-Path $Root 'config\wechatagent.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $configured=[string]$config.hook.wechatExecutable
    if(-not $configured -or $configured -match '["\r\n\x00]'){throw 'CLIENT_PIN_INVALID_PATH'}
    $exe=if([IO.Path]::IsPathRooted($configured)){[IO.Path]::GetFullPath($configured)}else{[IO.Path]::GetFullPath((Join-Path $Root $configured))}
    $directory=Split-Path -Parent $exe;$scope=Join-Path $Root 'state\hook';$store=Join-Path $scope 'client-pins'
    if(-not $directory.StartsWith($scope+'\',[StringComparison]::OrdinalIgnoreCase) -or $directory -eq $store -or $directory.StartsWith($store+'\',[StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $exe) -ne 'Weixin.exe'){throw 'CLIENT_PIN_SCOPE_REQUIRED: Only an independent client below this project state/hook may be protected.'}
    $ancestor=$directory
    while($ancestor.Length -ge $Root.Length){Assert-PinDirectory $ancestor;if($ancestor -eq $Root){break};$ancestor=Split-Path -Parent $ancestor}
    if((Get-Item -LiteralPath $exe -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'CLIENT_PIN_LINK_REFUSED'}
    if(@(Get-ChildItem -LiteralPath $directory -Recurse -Force -Attributes ReparsePoint).Count){throw 'CLIENT_PIN_LINK_REFUSED: Linked client content found.'}
    $sha=[Security.Cryptography.SHA256]::Create()
    try{$key=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($directory.ToLowerInvariant())))).Replace('-','').Substring(0,20).ToLowerInvariant()}finally{$sha.Dispose()}
    return [pscustomobject]@{root=$Root;scope=$scope;store=$store;key=$key;directory=$directory;exe=$exe;version=[string]$config.hook.expectedVersion;sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value}
}
function Assert-PinRecord($Target,$Record,[string]$KeyDirectory){
    if($Record.schemaVersion -ne 2 -or $Record.path -ne $Target.directory -or $Record.sid -ne $Target.sid -or $Record.version -notin @('4.1.10.27','4.1.15.13','4.2.0.12') -or $Record.generation -notmatch '^[a-f0-9]{32}$'){throw 'CLIENT_PIN_BACKUP_CHANGED: Backup identity mismatch.'}
    Assert-PinDirectory (Join-Path $KeyDirectory $Record.generation)
}
function Get-PinUpdaterPaths($Target,$Record){
    $original=Join-Path $Target.directory ($Record.version+'\WeixinUpdate.exe')
    return [pscustomobject]@{original=$original;disabled=($original+'.disabled')}
}
function Restore-ClientPin($Target,$Record,[string]$KeyDirectory,[string]$StateFile){
    Assert-PinRecord $Target $Record $KeyDirectory
    $generation=Join-Path $KeyDirectory $Record.generation
    $Record.status='unlocking';$Record.updatedAt=[DateTime]::UtcNow.ToString('o');Write-PinJson $StateFile $Record
    Restore-PinRootAcl $Target.directory (Join-Path $generation 'root.acl')
    $paths=Get-PinUpdaterPaths $Target $Record
    if($Record.updaterMoved){
        if(Test-Path -LiteralPath $paths.original){
            if((Get-PinHash $paths.original) -ne $Record.updaterSha256){throw 'CLIENT_PIN_RESTORE_CONFLICT: Existing updater differs from the saved original.'}
        }elseif(Test-Path -LiteralPath $paths.disabled){
            if((Get-PinHash $paths.disabled) -ne $Record.updaterSha256){throw 'CLIENT_PIN_BACKUP_CHANGED: Disabled updater changed.'}
            Move-Item -LiteralPath $paths.disabled -Destination $paths.original
        }else{
            $copy=Join-Path $generation 'updater.bin'
            if(-not (Test-Path -LiteralPath $copy) -or (Get-PinHash $copy) -ne $Record.updaterSha256){throw 'CLIENT_PIN_BACKUP_CHANGED: Updater recovery copy is unavailable.'}
            Copy-Item -LiteralPath $copy -Destination $paths.original
        }
    }
    $Record.status='unlocked';$Record.updatedAt=[DateTime]::UtcNow.ToString('o')
    Write-PinJson $StateFile $Record
}
function Invoke-ClientPin([string]$Root,[switch]$Unlock,[switch]$Status){
    $target=Get-PinTarget $Root
    if(-not $Unlock -and -not $Status){
        if($target.version -notin @('4.1.10.27','4.1.15.13','4.2.0.12') -or (Get-PinFileVersion $target.exe) -ne $target.version){throw 'CLIENT_PIN_VERSION_MISMATCH'}
        $signature=Get-AuthenticodeSignature -LiteralPath $target.exe
        if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Tencent'){throw 'CLIENT_PIN_SIGNATURE_INVALID'}
    }
    New-PinDirectory $target.store
    $keyDirectory=Join-Path $target.store $target.key;New-PinDirectory $keyDirectory
    $stateFile=Join-Path $keyDirectory 'pin.json';$lockFile=Join-Path $keyDirectory 'operation.lock'
    try{$lock=[IO.File]::Open($lockFile,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}catch{throw 'CLIENT_PIN_BUSY'}
    try{
        $record=$null
        if(Test-Path -LiteralPath $stateFile){$record=Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json;Assert-PinRecord $target $record $keyDirectory}
        if($Status){
            [pscustomobject]@{version=$target.version;path=$target.directory;status=$(if($record){$record.status}else{'unprotected'});record=$stateFile} | ConvertTo-Json -Compress
            return
        }
        Initialize-PinSecurity
        if($Unlock -and $record){
            if($record.status -ne 'unlocked'){Restore-ClientPin $target $record $keyDirectory $stateFile}
            Write-Output ('Client '+$record.version+' protection released; updater and permissions restored for this protection cycle.')
            return
        }
        $legacy=$null;$legacyFile=Join-Path $target.scope 'client-pin-acl.json'
        if(-not $record -and (Test-Path -LiteralPath $legacyFile)){
            $candidate=Get-Content -LiteralPath $legacyFile -Raw -Encoding UTF8 | ConvertFrom-Json
            if($candidate.path -and [IO.Path]::GetFullPath($candidate.path) -eq $target.directory){$legacy=$candidate}
        }
        if($Unlock){
            if($legacy){
                $generation=[guid]::NewGuid().ToString('N');$folder=Join-Path $keyDirectory $generation;New-PinDirectory $folder
                Write-PinRootAcl $target.directory $legacy.sddl (Join-Path $folder 'root.acl')
                Restore-PinRootAcl $target.directory (Join-Path $folder 'root.acl')
                $record=[pscustomobject]@{schemaVersion=2;path=$target.directory;sid=$target.sid;version=$target.version;generation=$generation;status='unlocked';updaterMoved=$false;updaterSha256='';legacyImported=$true;createdAt=[DateTime]::UtcNow.ToString('o');updatedAt=[DateTime]::UtcNow.ToString('o')}
                Write-PinJson $stateFile $record
            }
            Write-Output 'No active client protection remains for this directory.';return
        }
        $updater=Join-Path $target.directory ($target.version+'\WeixinUpdate.exe')
        $disabled=$updater+'.disabled'
        if(@(Get-CimInstance Win32_Process -Filter "Name='WeixinUpdate.exe'" | Where-Object {$_.ExecutablePath -eq $updater -or $_.ExecutablePath -eq $disabled}).Count){throw 'CLIENT_PIN_UPDATER_RUNNING: Exit this client updater before modifying protection.'}
        if($record -and $record.status -eq 'pinned'){
            if($record.version -ne $target.version){throw 'CLIENT_PIN_VERSION_MISMATCH'}
            if(Test-Path -LiteralPath $updater){throw 'CLIENT_PIN_RESTORE_CONFLICT: Updater reappeared while protection was active.'}
            if($record.updaterSha256 -and (-not (Test-Path -LiteralPath $disabled) -or (Get-PinHash $disabled) -ne $record.updaterSha256)){throw 'CLIENT_PIN_BACKUP_CHANGED'}
            $rights=[Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles
            $denied=0
            $requiredInheritance=[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
            foreach($rule in (Get-Acl -LiteralPath $target.directory).GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier])){if($rule.IdentityReference.Value -eq $target.sid -and $rule.AccessControlType -eq 'Deny' -and ($rule.InheritanceFlags -band $requiredInheritance) -eq $requiredInheritance -and $rule.PropagationFlags -eq [Security.AccessControl.PropagationFlags]::None){$denied=$denied -bor [int]$rule.FileSystemRights}}
            if(($denied -band [int]$rights) -ne [int]$rights){throw 'CLIENT_PIN_BACKUP_CHANGED: Program-directory protection was changed.'}
            Write-Output ('Client '+$target.version+' is already protected.');return
        }
        if($record -and $record.status -ne 'unlocked'){Restore-ClientPin $target $record $keyDirectory $stateFile}
        $children=@(Get-ChildItem -LiteralPath $target.directory -Recurse -Force)
        foreach($child in $children){if((Get-Acl -LiteralPath $child.FullName).AreAccessRulesProtected){throw 'CLIENT_PIN_PROTECTED_CHILD: A child item does not inherit program-directory protection.'}}
        if((Test-Path -LiteralPath $updater) -and (Test-Path -LiteralPath $disabled)){throw 'CLIENT_PIN_RESTORE_CONFLICT: Both updater names already exist.'}
        $generation=[guid]::NewGuid().ToString('N');$folder=Join-Path $keyDirectory $generation;New-PinDirectory $folder
        $rootAcl=Get-Acl -LiteralPath $target.directory
        $originalSddl=if($legacy){$legacy.sddl}else{$rootAcl.Sddl}
        Write-PinRootAcl $target.directory $originalSddl (Join-Path $folder 'root.acl')
        $tree=@(@(Get-Item -LiteralPath $target.directory -Force)+$children | ForEach-Object {[pscustomobject]@{path=$_.FullName.Substring($target.directory.Length).TrimStart('\');sddl=(Get-Acl -LiteralPath $_.FullName).Sddl}})
        Write-PinJson (Join-Path $folder 'tree-acls.json') $tree
        $updaterPresent=Test-Path -LiteralPath $updater
        $updaterHash=if($updaterPresent){Get-PinHash $updater}elseif(Test-Path -LiteralPath $disabled){Get-PinHash $disabled}else{''}
        if($updaterHash){
            $updaterCopy=Join-Path $folder 'updater.bin'
            Copy-Item -LiteralPath $(if($updaterPresent){$updater}else{$disabled}) -Destination $updaterCopy
            if((Get-PinHash $updaterCopy) -ne $updaterHash){throw 'CLIENT_PIN_BACKUP_CHANGED: Updater changed during backup.'}
        }
        $permissionCheck=Join-Path $folder 'permission-check.acl'
        Write-PinRootAcl $target.directory $rootAcl.Sddl $permissionCheck
        Restore-PinRootAcl $target.directory $permissionCheck
        $record=[pscustomobject]@{schemaVersion=2;path=$target.directory;sid=$target.sid;version=$target.version;generation=$generation;status='pinning';updaterMoved=[bool]$updaterPresent;updaterSha256=$updaterHash;legacyImported=[bool]$legacy;createdAt=[DateTime]::UtcNow.ToString('o');updatedAt=[DateTime]::UtcNow.ToString('o')}
        Write-PinJson $stateFile $record
        try{
            if($updaterPresent){Move-Item -LiteralPath $updater -Destination $disabled;if((Get-PinHash $disabled) -ne $updaterHash){throw 'CLIENT_PIN_BACKUP_CHANGED: Updater changed during protection.'}}
            $rights=[Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles
            $sid=[Security.Principal.SecurityIdentifier]::new($target.sid)
            $inherit=[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
            $rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,$rights,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Deny)
            $rootAcl.AddAccessRule($rule)
            $activeAcl=Join-Path $folder 'pinned.acl';Write-PinRootAcl $target.directory $rootAcl.Sddl $activeAcl
            Restore-PinRootAcl $target.directory $activeAcl
            $record.status='pinned';$record.updatedAt=[DateTime]::UtcNow.ToString('o');Write-PinJson $stateFile $record
        }catch{
            $pinFailure=$_
            try{Restore-ClientPin $target $record $keyDirectory $stateFile}catch{throw ('CLIENT_PIN_RECOVERY_REQUIRED: '+$_.Exception.Message)}
            throw $pinFailure
        }
        Write-Output ('Client '+$target.version+' protected: updater disabled and current-user program writes blocked; backups are outside the client directory.')
    }finally{$lock.Dispose()}
}

if($MyInvocation.InvocationName -ne '.'){
    Invoke-ClientPin -Root (Split-Path -Parent $PSScriptRoot) -Unlock:$Unlock -Status:$Status
}
