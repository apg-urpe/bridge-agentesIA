# run-pytest.ps1 — corre los tests unitarios dentro del container del bridge.
# Instala pytest+httpx temporalmente si no están en la imagen.

param(
    [string]$Filter = "",
    [switch]$Verbose
)

$verboseFlag = if ($Verbose) { "-v" } else { "" }
$filterFlag  = if ($Filter)  { "-k $Filter" } else { "" }

# Verifica que el container este corriendo
$running = docker compose ps --status running --quiet bridge 2>$null
if (-not $running) {
    Write-Host "El container bridge no esta corriendo. 'docker compose up -d'" -ForegroundColor Red
    exit 1
}

# Instalar deps de test si faltan, y correr pytest. Las deps son livianas.
$cmd = "pip install -q pytest httpx 2>/dev/null && python -m pytest tests/ $verboseFlag $filterFlag --color=yes"
docker compose exec -T bridge sh -c $cmd
exit $LASTEXITCODE
