param(
    [Parameter(Mandatory=$true)][string]$ScriptPath,
    [string]$ArgumentsBase64 = 'W10='
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$scriptArguments = @([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ArgumentsBase64)) | ConvertFrom-Json)
$positionals = @()
$switches = @{}
foreach ($argument in $scriptArguments) {
    if ($argument -match '^-[A-Za-z][A-Za-z0-9]*$') { $switches[$argument.Substring(1)] = $true }
    else { $positionals += [string]$argument }
}
& $ScriptPath @switches @positionals
if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }
