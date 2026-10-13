#Requires -Version 5.1
<#
  btc-analyzer — Arresto servizi (Windows)
  Ferma sia il container Docker sia l'eventuale ambiente di sviluppo (-Dev). I dati restano nel volume.
#>

$ScriptDir    = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
$PidFile      = Join-Path $ScriptDir '.btc.pids'
$LogsDir      = Join-Path $ScriptDir 'logs'
$BackendPort  = 8000
$FrontendPort = 5173

Write-Host ""
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "   btc-analyzer - Arresto servizi" -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host ""

function Stop-ProcTree($procId, $label) {
    $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if (-not $p) { return }
    $children = Get-CimInstance Win32_Process -Filter "ParentProcessId=$procId" -ErrorAction SilentlyContinue
    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    Write-Host "  OK  $label (PID $procId) fermato" -ForegroundColor Green
    foreach ($c in $children) {
        Stop-Process -Id $c.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

if (Test-Path $PidFile) {
    Write-Host "-> Arresto processi dal PID file..." -ForegroundColor Yellow
    Get-Content $PidFile | ForEach-Object {
        if ($_ -match '^\d+$') { Stop-ProcTree -procId ([int]$_) -label "Processo" }
    }
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

Write-Host "-> Arresto container..." -ForegroundColor Yellow
$ComposeCmd = $null
if (Get-Command docker -ErrorAction SilentlyContinue) {
    & docker compose version *> $null
    if ($LASTEXITCODE -eq 0) { $ComposeCmd = @('docker', 'compose') }
}
if (-not $ComposeCmd -and (Get-Command docker-compose -ErrorAction SilentlyContinue)) {
    $ComposeCmd = @('docker-compose')
}
if ($ComposeCmd) {
    Push-Location $ScriptDir
    if ($ComposeCmd.Length -gt 1) { & $ComposeCmd[0] $ComposeCmd[1..($ComposeCmd.Length - 1)] down --remove-orphans *> $null }
    else { & $ComposeCmd[0] down --remove-orphans *> $null }
    Pop-Location
    Write-Host "  OK  Container fermato (i dati restano nel volume)" -ForegroundColor Green
} else {
    Write-Host "  Nessun runtime Docker trovato" -ForegroundColor Yellow
}

Write-Host "-> Verifica porte $BackendPort e $FrontendPort..." -ForegroundColor Yellow
foreach ($port in @($BackendPort, $FrontendPort)) {
    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique |
        ForEach-Object {
            $p = Get-Process -Id $_ -ErrorAction SilentlyContinue
            if ($p -and $p.ProcessName -notmatch 'com\.docker|docker|vpnkit|wslrelay') {
                Stop-ProcTree -procId $_ -label "Porta $port - $($p.ProcessName)"
            }
        }
}

Remove-Item (Join-Path $LogsDir 'backend.log'), (Join-Path $LogsDir 'backend-err.log'), `
            (Join-Path $LogsDir 'frontend.log'), (Join-Path $LogsDir 'frontend-err.log') `
            -Force -ErrorAction SilentlyContinue

Write-Host ""
$beListening = Get-NetTCPConnection -LocalPort $BackendPort -State Listen -ErrorAction SilentlyContinue
$feListening = Get-NetTCPConnection -LocalPort $FrontendPort -State Listen -ErrorAction SilentlyContinue

if (-not $beListening -and -not $feListening) {
    Write-Host "========================================================" -ForegroundColor Green
    Write-Host "   Tutti i servizi sono stati fermati" -ForegroundColor Green
    Write-Host "========================================================" -ForegroundColor Green
} else {
    Write-Host "========================================================" -ForegroundColor Red
    Write-Host "   Alcuni processi potrebbero essere ancora attivi" -ForegroundColor Red
    Write-Host "========================================================" -ForegroundColor Red
}
Write-Host ""
