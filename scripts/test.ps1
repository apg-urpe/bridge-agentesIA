# test.ps1 — dispara escenarios de animación contra http://localhost:8000.
#   .\scripts\test.ps1 isolated      # un solo mensaje (rocky -> pepper)
#   .\scripts\test.ps1 mitosis       # 4 mensajes desde rocky -> spawnea clones
#   .\scripts\test.ps1 convergence   # 4 walkers convergen en rocky
#   .\scripts\test.ps1 burst         # rocky en rafaga (camina + clones)
#   .\scripts\test.ps1 stack         # 5 mensajes a rocky para ver bubbles apilados
#   .\scripts\test.ps1 crossfire     # 6 mensajes en multiples direcciones
#   .\scripts\test.ps1 all           # corre todos en secuencia con pausas
#   .\scripts\test.ps1 list          # lista escenarios disponibles

param(
    [Parameter(Position = 0)]
    [ValidateSet('isolated','mitosis','convergence','burst','stack','crossfire','all','list')]
    [string]$Scenario = 'list'
)

Import-Module (Join-Path $PSScriptRoot Office.psm1) -Force

if (-not (Test-Health)) {
    Write-Host "El bridge no responde en $(Get-OfficeUrl). Corré 'docker compose up -d'." -ForegroundColor Red
    exit 1
}

if ($Scenario -eq 'list') {
    Write-Host "Escenarios disponibles:" -ForegroundColor Cyan
    Write-Host "  isolated     - un solo mensaje rocky -> pepper"
    Write-Host "  mitosis      - 4 mensajes simultaneos desde rocky (spawnea clones)"
    Write-Host "  convergence  - 4 walkers caminan a rocky al mismo tiempo"
    Write-Host "  burst        - rocky manda 3 en rafaga (1 walk + 2 clones)"
    Write-Host "  stack        - 5 mensajes hacia rocky para ver bubbles apilados"
    Write-Host "  crossfire    - 6 mensajes en distintas direcciones"
    Write-Host "  all          - corre todos en secuencia con pausas"
    Write-Host ""
    Write-Host "Antes de la primera vez: .\scripts\setup.ps1" -ForegroundColor Yellow
    exit 0
}

$keys = Import-Keys

function Run-Isolated {
    Write-Host "[isolated] rocky -> pepper" -ForegroundColor Cyan
    Send-OfficeMessage -Keys $keys -From rocky -To pepper -Message "rocky aislado va solo"
}

function Run-Mitosis {
    Write-Host "[mitosis] rocky manda a 4 destinos casi simultaneos" -ForegroundColor Cyan
    Send-OfficeMessage -Keys $keys -From rocky -To pepper -Message "msg a pepper (walk principal)"
    Start-Sleep -Milliseconds 200
    Send-OfficeMessage -Keys $keys -From rocky -To loki   -Message "msg a loki (clon)"
    Start-Sleep -Milliseconds 200
    Send-OfficeMessage -Keys $keys -From rocky -To nexus  -Message "msg a nexus (clon)"
    Start-Sleep -Milliseconds 200
    Send-OfficeMessage -Keys $keys -From rocky -To clawd  -Message "msg a clawd (clon)"
}

function Run-Convergence {
    Write-Host "[convergence] 4 agentes caminan a rocky" -ForegroundColor Cyan
    Send-OfficeMessage -Keys $keys -From pepper -To rocky -Message "soy pepper hola rocky"
    Send-OfficeMessage -Keys $keys -From nexus  -To rocky -Message "soy nexus, che rocky"
    Send-OfficeMessage -Keys $keys -From loki   -To rocky -Message "soy loki, rocky pasa esto"
    Send-OfficeMessage -Keys $keys -From clawd  -To rocky -Message "soy clawd, rocky tengo info"
}

function Run-Burst {
    Write-Host "[burst] rocky manda 3 mensajes en rafaga" -ForegroundColor Cyan
    Send-OfficeMessage -Keys $keys -From rocky -To pepper -Message "primer mensaje"
    Start-Sleep -Milliseconds 400
    Send-OfficeMessage -Keys $keys -From rocky -To loki   -Message "segundo (clon)"
    Start-Sleep -Milliseconds 400
    Send-OfficeMessage -Keys $keys -From rocky -To clawd  -Message "tercero (clon)"
}

function Run-Stack {
    Write-Host "[stack] 5 mensajes hacia rocky para ver bubbles apilados sobre cada emisor" -ForegroundColor Cyan
    Send-OfficeMessage -Keys $keys -From pepper -To rocky -Message "uno"
    Start-Sleep -Milliseconds 100
    Send-OfficeMessage -Keys $keys -From nexus  -To rocky -Message "dos"
    Start-Sleep -Milliseconds 100
    Send-OfficeMessage -Keys $keys -From loki   -To rocky -Message "tres"
    Start-Sleep -Milliseconds 100
    Send-OfficeMessage -Keys $keys -From clawd  -To rocky -Message "cuatro"
    Start-Sleep -Milliseconds 100
    Send-OfficeMessage -Keys $keys -From pepper -To rocky -Message "cinco otra vez"
}

function Run-Crossfire {
    Write-Host "[crossfire] 6 mensajes en distintas direcciones simultaneos" -ForegroundColor Cyan
    Send-OfficeMessage -Keys $keys -From rocky  -To pepper -Message "rocky a pepper"
    Send-OfficeMessage -Keys $keys -From pepper -To loki   -Message "pepper a loki"
    Send-OfficeMessage -Keys $keys -From loki   -To nexus  -Message "loki a nexus"
    Send-OfficeMessage -Keys $keys -From nexus  -To clawd  -Message "nexus a clawd"
    Send-OfficeMessage -Keys $keys -From clawd  -To rocky  -Message "clawd a rocky"
    Start-Sleep -Milliseconds 1500
    Send-OfficeMessage -Keys $keys -From pepper -To nexus  -Message "pepper a nexus tambien"
}

switch ($Scenario) {
    'isolated'    { Run-Isolated }
    'mitosis'     { Run-Mitosis }
    'convergence' { Run-Convergence }
    'burst'       { Run-Burst }
    'stack'       { Run-Stack }
    'crossfire'   { Run-Crossfire }
    'all' {
        Run-Isolated;    Start-Sleep -Seconds 9
        Run-Mitosis;     Start-Sleep -Seconds 12
        Run-Convergence; Start-Sleep -Seconds 9
        Run-Burst;       Start-Sleep -Seconds 9
        Run-Stack;       Start-Sleep -Seconds 9
        Run-Crossfire
    }
}
