$ErrorActionPreference = 'Stop'
$projectDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$record = Join-Path $projectDir 'data\local-services.json'
if (-not (Test-Path -LiteralPath $record)) { Write-Output 'No launcher-owned services recorded.'; return }
$workers = @(Get-Content -LiteralPath $record -Raw | ConvertFrom-Json)
foreach ($worker in $workers) {
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$worker.pid)"
  if (-not $process) { continue }
  if ($process.ExecutablePath -ne $worker.executable -or -not $process.CommandLine.Contains($worker.entry)) {
    throw "Process ID $($worker.pid) no longer matches the recorded $($worker.name) worker; it was left running."
  }
  Stop-Process -Id $worker.pid
  Write-Output "Stopped $($worker.name) (PID $($worker.pid))."
}
Remove-Item -LiteralPath $record
