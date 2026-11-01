param([switch]$Build, [switch]$NoVoice)
$ErrorActionPreference = 'Stop'
$projectDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$workspaceDir = (Resolve-Path (Join-Path $projectDir '..')).Path
$dataDir = Join-Path $projectDir 'data'
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
$nodeCommand = (Get-Command node -ErrorAction Stop).Source
$npmCommand = (Get-Command npm.cmd -ErrorAction Stop).Source
$partnerDir = if ($env:CHANDRA_PARTNER_DIR) { $env:CHANDRA_PARTNER_DIR } else { Join-Path $workspaceDir 'MyAIPartner' }
$partnerDist = Join-Path $partnerDir 'dist'
$partnerIndex = Join-Path $partnerDist 'index.html'
$fallbackPartnerDist = Join-Path $projectDir 'client\dist'
$fallbackPartnerIndex = Join-Path $fallbackPartnerDist 'index.html'
$voiceEntry = if ($env:FRAYMUS_VOICE_ENTRY) { $env:FRAYMUS_VOICE_ENTRY } else { Join-Path $workspaceDir 'fraymus-voice\bin\local-voice-server.py' }
function Invoke-Npm([string]$Directory, [string[]]$Arguments) {
  Push-Location -LiteralPath $Directory
  try { & $npmCommand @Arguments; if ($LASTEXITCODE -ne 0) { throw "npm failed in $Directory" } }
  finally { Pop-Location }
}
if (-not (Test-Path -LiteralPath (Join-Path $projectDir 'node_modules'))) { Invoke-Npm $projectDir @('ci','--include=dev') }
if ($Build -or -not (Test-Path -LiteralPath $partnerIndex) -or -not (Test-Path -LiteralPath $fallbackPartnerIndex)) {
  # The root build compiles the canonical companion and the optional Vite
  # development handoff. Install both frontends before that single build.
  Invoke-Npm (Join-Path $projectDir 'client') @('ci','--include=dev')
  if (Test-Path -LiteralPath $partnerDir) {
    Invoke-Npm $partnerDir @('ci','--include=dev')
    if ($Build -or -not (Test-Path -LiteralPath $partnerIndex)) { Invoke-Npm $partnerDir @('run','build') }
  } elseif ($Build) {
    Write-Warning "Companion repo not found at $partnerDir. Launcher will defer to server/static.js lookup (vendored partner-dist before client fallback)."
  }
  Invoke-Npm $projectDir @('run','build')
}
if (-not $env:CHANDRA_PARTNER_DIST -and (Test-Path -LiteralPath $partnerIndex)) {
  $env:CHANDRA_PARTNER_DIST = $partnerDist
}
$owned = @()
function Start-LocalWorker([string]$Executable, [string]$Entry, [string]$Name, [string]$Directory) {
  $process = Start-Process -FilePath $Executable -ArgumentList @('"' + $Entry + '"') -WorkingDirectory $Directory -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $dataDir "$Name.stdout.log") -RedirectStandardError (Join-Path $dataDir "$Name.stderr.log")
  return [pscustomobject]@{ pid=$process.Id; executable=$Executable; entry=$Entry; name=$Name }
}
function Read-Health([string]$Url) { try { return Invoke-RestMethod $Url -TimeoutSec 2 } catch { return $null } }
try {
  $existing = Read-Health 'http://127.0.0.1:8787/api/health'
  if ($existing) {
    if ($existing.app -ne 'Chandra / Fraymus' -or $existing.workspace -ne $workspaceDir) { throw 'Port 8787 belongs to another application or workspace.' }
    Write-Output 'Chandra is already running for this workspace.'
    return
  }
  if (Get-NetTCPConnection -State Listen -LocalPort 8787 -ErrorAction SilentlyContinue) { throw 'Port 8787 is already occupied.' }
  if (-not $NoVoice) {
    $voiceHealth = Read-Health 'http://127.0.0.1:9099/health'
    if ($voiceHealth) {
      if (-not $voiceHealth.capabilities.local_memory -or $voiceHealth.capabilities.cloud_memory) { throw 'Port 9099 is not the expected local voice service.' }
    } else {
      if (Get-NetTCPConnection -State Listen -LocalPort 9099 -ErrorAction SilentlyContinue) { throw 'Port 9099 is already occupied.' }
      if (-not (Test-Path -LiteralPath $voiceEntry)) {
        Write-Warning "Voice entry not found at $voiceEntry. Starting Chandra without local voice worker."
      } else {
        $pythonCommand = (Get-Command python -ErrorAction Stop).Source
        $owned += Start-LocalWorker $pythonCommand $voiceEntry 'voice' (Split-Path -Parent (Split-Path -Parent $voiceEntry))
      }
    }
  }
  $owned += Start-LocalWorker $nodeCommand (Join-Path $projectDir 'server\start.js') 'chandra' $projectDir
  $ready = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    $health = Read-Health 'http://127.0.0.1:8787/api/health'
    if ($health -and $health.workspace -eq $workspaceDir) { $ready = $true; break }
    Start-Sleep -Milliseconds 250
  }
  if (-not $ready) { throw 'Chandra did not become healthy; inspect data/*.stderr.log.' }
  $owned | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $dataDir 'local-services.json') -Encoding utf8
  Write-Output 'Chandra: http://127.0.0.1:8787/'
  Write-Output 'Partner: http://127.0.0.1:8787/partner/'
  Write-Output 'Logs and owned process IDs: Chandra/data/'
} catch {
  foreach ($worker in $owned) { Stop-Process -Id $worker.pid -ErrorAction SilentlyContinue }
  throw
}
