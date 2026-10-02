param([switch]$Unlock)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot)).TrimEnd('\')
$config = Get-Content -LiteralPath (Join-Path $root 'config\wechatagent.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$exe = if ([IO.Path]::IsPathRooted($config.hook.wechatExecutable)) { [IO.Path]::GetFullPath($config.hook.wechatExecutable) } else { [IO.Path]::GetFullPath((Join-Path $root $config.hook.wechatExecutable)) }
$directory = Split-Path -Parent $exe
$scope = Join-Path $root 'state\hook'
if (-not $directory.StartsWith($scope+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Client pinning is restricted to this project state/hook directory.' }
$item = Get-Item -LiteralPath $directory -Force
if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Client directory is a link; refusing permission changes.' }
$links = @(Get-ChildItem -LiteralPath $directory -Recurse -Force -Attributes ReparsePoint)
if ($links.Count) { throw 'Linked client content found; inspect before permission changes.' }
$backupFile = Join-Path $scope 'client-pin-acl.json'
if ($Unlock) {
    if (Test-Path -LiteralPath $backupFile) {
        $saved = Get-Content -LiteralPath $backupFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if ([IO.Path]::GetFullPath($saved.path) -ne $directory) { throw 'Saved pin permissions belong to a different client directory.' }
        $acl = Get-Acl -LiteralPath $directory
        $acl.SetSecurityDescriptorSddlForm($saved.sddl)
        Set-Acl -LiteralPath $directory -AclObject $acl
        Write-Output 'Project client write protection released.'
    }
    exit 0
}
if ((Get-Item -LiteralPath $exe).VersionInfo.FileVersion -ne '4.1.10.27') { throw 'Restore the matching 4.1.10.27 client before pinning.' }
$updater = Join-Path $directory '4.1.10.27\WeixinUpdate.exe'
if (Test-Path -LiteralPath $updater) {
    $disabled = $updater+'.disabled'
    if (Test-Path -LiteralPath $disabled) { throw 'Updater backup already exists; inspect before replacement.' }
    Move-Item -LiteralPath $updater -Destination $disabled
}
$acl = Get-Acl -LiteralPath $directory
if (-not (Test-Path -LiteralPath $backupFile)) {
    @{path=$directory;sddl=$acl.Sddl} | ConvertTo-Json | Set-Content -LiteralPath $backupFile -Encoding UTF8
}
$saved = Get-Content -LiteralPath $backupFile -Raw -Encoding UTF8 | ConvertFrom-Json
if ([IO.Path]::GetFullPath($saved.path) -ne $directory) { throw 'Saved pin permissions belong to a different client directory.' }
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$rights = [Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles
$inherit = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
$rule = [Security.AccessControl.FileSystemAccessRule]::new($sid,$rights,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Deny)
$acl.SetAccessRule($rule)
Set-Acl -LiteralPath $directory -AclObject $acl
Write-Output 'Project client pinned: updater disabled and current-user writes blocked in its program directory.'
