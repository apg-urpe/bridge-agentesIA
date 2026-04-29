# setup.ps1 — registra los 5 agentes de prueba y guarda sus API keys.
# Si los agentes ya existen (DB con datos previos), avisa qué hacer.

Import-Module (Join-Path $PSScriptRoot Office.psm1) -Force

if (-not (Test-Health)) {
    Write-Host "El bridge no responde en $(Get-OfficeUrl)/v1/health" -ForegroundColor Red
    Write-Host "Levantalo primero con: docker compose up -d" -ForegroundColor Yellow
    exit 1
}

$keysPath = Get-KeysPath
if (Test-Path $keysPath) {
    Write-Host "Las keys ya estan guardadas en $keysPath" -ForegroundColor Cyan
    Write-Host "Para regenerar: borra ese archivo, o usa .\scripts\reset.ps1 (reset destructivo)" -ForegroundColor Cyan
    exit 0
}

$agentsToCreate = @(
    @{ id = 'rocky';  name = 'Rocky';  platform = 'Telegram' },
    @{ id = 'pepper'; name = 'Pepper'; platform = 'WhatsApp' },
    @{ id = 'nexus';  name = 'NEXUS';  platform = 'core'     },
    @{ id = 'loki';   name = 'Loki';   platform = 'Discord'  },
    @{ id = 'clawd';  name = 'Clawd';  platform = 'Slack'    }
)

$keys = @{}
$alreadyRegistered = @()
foreach ($a in $agentsToCreate) {
    $r = Register-TestAgent -Id $a.id -DisplayName $a.name -Platform $a.platform
    if ($r) {
        $keys[$r.id] = $r.key
        Write-Host "  + $($a.id) registrado" -ForegroundColor Green
    } else {
        $alreadyRegistered += $a.id
        Write-Host "  ! $($a.id) ya existe (skip)" -ForegroundColor Yellow
    }
}

if ($alreadyRegistered.Count -gt 0) {
    Write-Host ""
    Write-Host "Algunos agentes ya estaban en la DB: $($alreadyRegistered -join ', ')" -ForegroundColor Yellow
    Write-Host "No puedo recuperar las api_keys de agentes ya registrados (solo se muestran al crearlos)." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Opciones:" -ForegroundColor Yellow
    Write-Host "  1) Pega manualmente las keys que ya tengas en $keysPath (formato JSON: { rocky: '...', pepper: '...', ... })" -ForegroundColor Yellow
    Write-Host "  2) Reset destructivo: .\scripts\reset.ps1 (borra la DB y re-registra todo)" -ForegroundColor Yellow
    exit 1
}

Save-Keys $keys
Write-Host ""
Write-Host "OK. Keys guardadas en $keysPath" -ForegroundColor Green
Write-Host "Probá: .\scripts\test.ps1 isolated" -ForegroundColor Green
