#Requires -Version 5.1
<#
  btc-analyzer — Avvio (Windows)

  Uso:
    start.bat              app completa in Docker su http://localhost:8010
                           (ricostruisce l'immagine solo se il codice è cambiato)
    start.bat -NoBuild     come sopra, senza ricostruire l'immagine
    start.bat -Dev         sviluppo: backend uvicorn su :8010 + Vite su :5173,
                           senza Docker (dati in backend\data, non nel volume Docker)
#>
param(
    [switch]$Dev,
    [switch]$NoBuild
)

$ScriptDir    = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
$PidFile      = Join-Path $ScriptDir '.btc.pids'
$LogsDir      = Join-Path $ScriptDir 'logs'
$BackendPort  = 8010
$FrontendPort = 5173
$LlmUrl       = 'http://localhost:1234/v1/models'
$Total        = 5

New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null

Write-Host ""
Write-Host "========================================================" -ForegroundColor Cyan
if ($Dev) { Write-Host "   btc-analyzer - Avvio ambiente di sviluppo" -ForegroundColor Cyan }
else      { Write-Host "   btc-analyzer - Avvio in Docker" -ForegroundColor Cyan }
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host ""

# ── [1/5] Verifica dipendenze ──
Write-Host "[1/$Total] Verifica dipendenze..." -ForegroundColor White

$ComposeCmd = $null
if (Get-Command docker -ErrorAction SilentlyContinue) {
    & docker compose version *> $null
    if ($LASTEXITCODE -eq 0) { $ComposeCmd = @('docker', 'compose') }
}
if (-not $ComposeCmd -and (Get-Command docker-compose -ErrorAction SilentlyContinue)) {
    $ComposeCmd = @('docker-compose')
}
function Invoke-Compose([string[]]$ComposeArgs) {
    Push-Location $ScriptDir
    if ($ComposeCmd.Length -gt 1) { & $ComposeCmd[0] $ComposeCmd[1..($ComposeCmd.Length - 1)] @ComposeArgs | Out-Host }
    else { & $ComposeCmd[0] @ComposeArgs | Out-Host }
    $code = $LASTEXITCODE
    Pop-Location
    return $code
}

$python = Join-Path $ScriptDir 'backend\.venv\Scripts\python.exe'
if ($Dev) {
    if (-not (Test-Path $python)) {
        Write-Host "  Ambiente Python non trovato (backend\.venv). Crealo con:" -ForegroundColor Red
        Write-Host "    cd backend; python -m venv .venv; .venv\Scripts\pip install -r requirements.txt" -ForegroundColor Red
        exit 1
    }
    Write-Host "  OK  $(& $python --version)" -ForegroundColor Green
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Host "  Node.js non trovato. Installalo prima di continuare." -ForegroundColor Red
        exit 1
    }
    Write-Host "  OK  Node $(node --version)" -ForegroundColor Green
} else {
    if (-not $ComposeCmd) {
        Write-Host "  Docker non trovato. Installa Docker Desktop prima di continuare." -ForegroundColor Red
        exit 1
    }
    & docker info *> $null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  Docker Desktop non è in esecuzione. Avvialo e riprova." -ForegroundColor Red
        exit 1
    }
    Write-Host "  OK  Runtime: $($ComposeCmd -join ' ')" -ForegroundColor Green
}

# LM Studio serve per traduzioni EN, sintesi dell'analista e chat: senza, l'app funziona ma in solo italiano e senza AI.
$llmOk = $false
try { $llmOk = (Invoke-WebRequest -Uri $LlmUrl -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200 } catch {}
if ($llmOk) { Write-Host "  OK  LM Studio raggiungibile (porta 1234)" -ForegroundColor Green }
else { Write-Host "  !   LM Studio non risponde sulla porta 1234: traduzioni EN e sintesi AI restano ferme finché non lo avvii" -ForegroundColor Yellow }
Write-Host ""

# ── [2/5] Arresto servizi esistenti ──
Write-Host "[2/$Total] Arresto servizi esistenti..." -ForegroundColor White
if (Test-Path $PidFile) {
    Get-Content $PidFile | ForEach-Object {
        if ($_ -match '^\d+$') { Stop-Process -Id ([int]$_) -Force -ErrorAction SilentlyContinue }
    }
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}
foreach ($port in @($BackendPort, $FrontendPort)) {
    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique |
        ForEach-Object {
            $p = Get-Process -Id $_ -ErrorAction SilentlyContinue
            if ($p -and $p.ProcessName -notmatch 'com\.docker|docker|vpnkit|wslrelay') {
                Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
            }
        }
}
if ($ComposeCmd) {
    Push-Location $ScriptDir
    if ($ComposeCmd.Length -gt 1) { & $ComposeCmd[0] $ComposeCmd[1..($ComposeCmd.Length - 1)] down --remove-orphans *> $null }
    else { & $ComposeCmd[0] down --remove-orphans *> $null }
    Pop-Location
}
Write-Host "  OK  Servizi fermati" -ForegroundColor Green
Write-Host ""

if ($Dev) {
    # ── [3/5] Dipendenze frontend ──
    Write-Host "[3/$Total] Verifica dipendenze frontend..." -ForegroundColor White
    $frontendDir = Join-Path $ScriptDir 'frontend'
    if (-not (Test-Path (Join-Path $frontendDir 'node_modules'))) {
        Push-Location $frontendDir
        npm ci --silent
        Pop-Location
    }
    Write-Host "  OK  Dipendenze frontend pronte" -ForegroundColor Green
    Write-Host ""

    # ── [4/5] Avvio backend e frontend ──
    Write-Host "[4/$Total] Avvio servizi..." -ForegroundColor White
    $backendDir    = Join-Path $ScriptDir 'backend'
    $backendLog    = Join-Path $LogsDir 'backend.log'
    $backendErrLog = Join-Path $LogsDir 'backend-err.log'
    # niente --reload: su Windows il reloader lascia worker orfani che servono codice vecchio
    $backendProc = Start-Process -FilePath $python -ArgumentList '-m', 'uvicorn', 'app.main:app', '--port', "$BackendPort" `
        -WorkingDirectory $backendDir `
        -RedirectStandardOutput $backendLog -RedirectStandardError $backendErrLog `
        -WindowStyle Hidden -PassThru
    $backendProc.Id | Out-File -Append -FilePath $PidFile -Encoding ascii
    Write-Host "  Backend avviato (PID: $($backendProc.Id), porta $BackendPort)"

    $frontendLog    = Join-Path $LogsDir 'frontend.log'
    $frontendErrLog = Join-Path $LogsDir 'frontend-err.log'
    $npmCmd = (Get-Command npm -ErrorAction SilentlyContinue).Source
    if (-not $npmCmd) {
        Write-Host "  npm non trovato nel PATH. Verifica l'installazione di Node." -ForegroundColor Red
        exit 1
    }
    $frontendProc = Start-Process -FilePath $npmCmd -ArgumentList 'run', 'dev', '--', '--port', "$FrontendPort", '--strictPort' `
        -WorkingDirectory $frontendDir `
        -RedirectStandardOutput $frontendLog -RedirectStandardError $frontendErrLog `
        -WindowStyle Hidden -PassThru
    $frontendProc.Id | Out-File -Append -FilePath $PidFile -Encoding ascii
    Write-Host "  Frontend avviato (PID: $($frontendProc.Id), porta $FrontendPort)"
    Write-Host ""
} else {
    # ── [3/5] Immagine ──
    if ($NoBuild) {
        Write-Host "[3/$Total] Immagine: uso quella esistente (-NoBuild)" -ForegroundColor White
    } else {
        Write-Host "[3/$Total] Build immagine (usa la cache se il codice non è cambiato)..." -ForegroundColor White
        if ((Invoke-Compose @('build')) -ne 0) {
            Write-Host "  Build dell'immagine fallita." -ForegroundColor Red
            exit 1
        }
    }
    Write-Host "  OK  Immagine pronta" -ForegroundColor Green
    Write-Host ""

    # ── [4/5] Avvio container ──
    Write-Host "[4/$Total] Avvio container..." -ForegroundColor White
    if ((Invoke-Compose @('up', '-d')) -ne 0) {
        Write-Host "  Avvio del container fallito. Log: docker compose logs btc-analyzer" -ForegroundColor Red
        exit 1
    }
    Write-Host "  OK  Container avviato" -ForegroundColor Green
    Write-Host ""
}

# ── [5/5] Health check ──
Write-Host "[5/$Total] Verifica..." -ForegroundColor White
$maxRetries = 90
$retry = 0
$backendUp = $false
do {
    Start-Sleep -Seconds 2
    try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$BackendPort/api/status" -UseBasicParsing -TimeoutSec 3
        if ($resp.StatusCode -eq 200) { $backendUp = $true }
    } catch {}
    $retry++
    Write-Host -NoNewline "`r  In attesa del backend... ($retry/$maxRetries)"
} while (-not $backendUp -and $retry -lt $maxRetries)
Write-Host ""
if ($backendUp) { Write-Host "  OK  Backend pronto" -ForegroundColor Green }
elseif ($Dev) { Write-Host "  Backend non raggiungibile. Log: $backendLog / $backendErrLog" -ForegroundColor Yellow }
else { Write-Host "  Backend non raggiungibile. Log: docker compose logs btc-analyzer" -ForegroundColor Yellow }

$AppUrl = "http://localhost:$BackendPort"
if ($Dev) {
    $AppUrl = "http://localhost:$FrontendPort"
    $retry = 0
    $frontendUp = $false
    do {
        Start-Sleep -Seconds 2
        try {
            $resp = Invoke-WebRequest -Uri $AppUrl -UseBasicParsing -TimeoutSec 2
            if ($resp.StatusCode -eq 200) { $frontendUp = $true }
        } catch {}
        $retry++
        Write-Host -NoNewline "`r  In attesa del frontend... ($retry/20)"
    } while (-not $frontendUp -and $retry -lt 20)
    Write-Host ""
    if ($frontendUp) { Write-Host "  OK  Frontend pronto" -ForegroundColor Green }
    else { Write-Host "  Frontend non raggiungibile. Log: $frontendLog / $frontendErrLog" -ForegroundColor Yellow }
}

Write-Host ""
Write-Host "========================================================" -ForegroundColor Green
Write-Host "   btc-analyzer avviato!" -ForegroundColor Green
Write-Host "========================================================" -ForegroundColor Green
Write-Host "   App:        $AppUrl"
Write-Host "   API:        http://localhost:$BackendPort/api"
if ($Dev) {
    Write-Host "   Modalità:   sviluppo (dati in backend\data)"
    Write-Host "   Log BE:     $backendLog"
    Write-Host "   Log FE:     $frontendLog"
} else {
    Write-Host "   Modalità:   Docker (dati nel volume btc-analyzer_btc-data)"
    Write-Host "   Log:        docker compose logs -f btc-analyzer"
}
Write-Host "   LM Studio:  $(if ($llmOk) { 'attivo' } else { 'spento (solo italiano, niente sintesi AI)' })"
Write-Host "   Stop:       scripts\windows\stop.bat"
Write-Host "========================================================" -ForegroundColor Green
Write-Host ""
