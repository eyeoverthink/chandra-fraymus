<#
.SYNOPSIS
Build or launch the harmless, explicitly named desktop UI Automation fixture.
.DESCRIPTION
Run -BuildOnly to compile without displaying or controlling a window. Normal
launch is operator-only and displays a synthetic Windows Forms test window.
No model should receive the reference nonce as an expected-text hint.
In no-argument executable mode it reads only an adjacent operator-created
reference.json {referenceNonce,instanceId}, at most 4096 UTF-8 bytes. The form
performs no writes/network/clipboard/shell actions. Build writes only the named
executable beneath this workspace's work/desktop-fixture folder. After -BuildOnly,
create that adjacent JSON and launch the executable through the approved UI API.
.EXAMPLE
powershell.exe -NoProfile -NonInteractive -File .\test\fixtures\desktop-window.ps1 -BuildOnly
.EXAMPLE
powershell.exe -NoProfile -NonInteractive -File .\test\fixtures\desktop-window.ps1 -ReferenceNonce <synthetic-nonce> -InstanceId <unique-safe-id>
#>
[CmdletBinding()]
param(
    [string] $ReferenceNonce,
    [string] $InstanceId = ([Guid]::NewGuid().ToString('N')),
    [switch] $BuildOnly
)

$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'The desktop fixture is Windows-only.' }
if (-not $BuildOnly -and $ReferenceNonce -notmatch '\A[A-Za-z0-9._-]{8,128}\z') {
    throw 'ReferenceNonce must be a synthetic 8-128 character letters/digits/._- value.'
}
if ($InstanceId -notmatch '\A[A-Za-z0-9._-]{2,64}\z') { throw 'InstanceId must be a safe unique 2-64 character value.' }
$fixtureWorkspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$fixtureDirectory = Join-Path $fixtureWorkspace 'work\desktop-fixture'
$fixtureExecutable = Join-Path $fixtureDirectory 'FraymusDesktopFixture.exe'
$fixtureSource = Join-Path $PSScriptRoot 'desktop-window.cs'
[IO.Directory]::CreateDirectory($fixtureDirectory) | Out-Null
if (Test-Path -LiteralPath $fixtureExecutable) {
    throw 'A fixture executable already exists. Reuse that exact executable, or explicitly remove it after its owned process is closed before rebuilding.'
}
Add-Type -Path $fixtureSource -ReferencedAssemblies 'System.Windows.Forms.dll','System.Drawing.dll','System.Web.Extensions.dll' `
    -OutputAssembly $fixtureExecutable -OutputType WindowsApplication
if ($BuildOnly) {
    Write-Output $fixtureExecutable
    return
}
# Direct executable invocation with separate arguments; no shell command string,
# process-wide input, app discovery, or user application control is performed.
& $fixtureExecutable --reference-nonce $ReferenceNonce --instance-id $InstanceId
if ($LASTEXITCODE -ne 0) { throw 'The desktop test fixture exited unsuccessfully.' }
