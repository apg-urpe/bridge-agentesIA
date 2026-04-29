# reset.ps1 — DESTRUCTIVO: borra el volumen de datos del bridge, levanta de nuevo
# y registra los 5 agentes de prueba con keys frescas.
# Pierde TODO: agentes registrados, mensajes, hilos. Solo para testing local.

Import-Module (Join-Path $PSScriptRoot Office.psm1) -Force

Write-Host "ATENCION: esto borra el volumen 'rocky-bridge_bridge_data' (DB completa)." -ForegroundColor Red
Write-Host "Vas a perder todos los agentes registrados y mensajes." -ForegroundColor Red
$conf = Read-Host "Escribi 'reset' para confirmar"
if ($conf -ne 'reset') {
    Write-Host "Cancelado." -ForegroundColor Yellow
    exit 0
}

Write-Host "deteniendo container..." -ForegroundColor DarkGray
docker compose down | Out-Null
Write-Host "borrando volumen..." -ForegroundColor DarkGray
docker volume rm rocky-bridge_bridge_data 2>$null | Out-Null
Write-Host "levantando container..." -ForegroundColor DarkGray
docker compose up -d | Out-Null

# wait for health
$timeout = 30
$elapsed = 0
while ($elapsed -lt $timeout) {
    if (Test-Health) { break }
    Start-Sleep -Milliseconds 500
    $elapsed += 0.5
}
if (-not (Test-Health)) {
    Write-Host "El bridge no levanto en ${timeout}s." -ForegroundColor Red
    exit 1
}

# remove old keys file so setup re-creates it
$keysPath = Get-KeysPath
if (Test-Path $keysPath) { Remove-Item $keysPath -Force }

& (Join-Path $PSScriptRoot setup.ps1)
