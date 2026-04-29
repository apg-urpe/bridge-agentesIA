# scripts/

Tests y utilidades para correr desde PowerShell.

## Habilitar ejecución de scripts (una vez por usuario)

Por default Windows bloquea scripts `.ps1`. Si la primera vez que corres uno te dice "ejecución de scripts está deshabilitada", abrí PowerShell **una vez** y corré:

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

(`RemoteSigned` permite scripts locales sin firmar; los descargados de internet siguen bloqueados.)

Alternativa one-shot sin cambiar la policy:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\test.ps1 mitosis
```

## Setup (una vez)

Si el bridge ya está corriendo y los 5 agentes (rocky, pepper, nexus, loki, clawd) ya están registrados con keys que conocés:

```powershell
# las keys ya están en scripts/.test-keys.json (gitignored)
.\scripts\test.ps1 list
```

Si la DB está vacía:

```powershell
docker compose up -d
.\scripts\setup.ps1     # registra los 5 agentes y guarda las keys
```

Si los agentes existen pero perdiste las keys, hacé reset:

```powershell
.\scripts\reset.ps1     # DESTRUCTIVO: borra el volumen, re-crea agentes con keys frescas
```

## Escenarios visuales

Abrí `http://localhost:8000/office` en el browser y dispará:

```powershell
.\scripts\test.ps1 isolated      # rocky -> pepper, un solo mensaje
.\scripts\test.ps1 mitosis       # 4 mensajes desde rocky → spawnea 3 clones
.\scripts\test.ps1 convergence   # 4 walkers caminan a rocky a la vez
.\scripts\test.ps1 burst         # rocky en ráfaga (1 walk + 2 clones)
.\scripts\test.ps1 stack         # 5 mensajes hacia rocky (bubbles apilados)
.\scripts\test.ps1 crossfire     # 6 mensajes en distintas direcciones
.\scripts\test.ps1 all           # todos en secuencia con pausas (~1 min)
```

Para apuntar a un bridge remoto:

```powershell
$env:OFFICE_URL = "https://bridge.agustinynatalia.site"
.\scripts\test.ps1 isolated
```

## Tests unitarios (pytest)

Tests del API real con DB temporal por test:

```powershell
.\scripts\run-pytest.ps1
.\scripts\run-pytest.ps1 -Verbose
.\scripts\run-pytest.ps1 -Filter test_send       # solo tests con 'test_send' en el nombre
```

Lo que cubren:

- health, dashboard, /office sirve el HTML
- registro de agentes (open + gated)
- gate (/v1/gate/status, /v1/gate/check)
- send (auth, from_agent must match, to_agent debe existir)
- inbox (recipient-only, ack, unread filtering)
- threads (agrupación por thread_id)
- /v1/office/feed (auth gated, content-type, hello inicial)

Cada test corre con `DATABASE_URL` apuntando a una SQLite temporal — no toca tu DB real.

## Funciones reusables (Office.psm1)

Si querés escribir tu propio escenario:

```powershell
Import-Module .\scripts\Office.psm1 -Force
$keys = Import-Keys
Send-OfficeMessage -Keys $keys -From rocky -To pepper -Message "lo que sea"
```

Funciones exportadas:

- `Test-Health` → bool
- `Register-TestAgent -Id <id> -DisplayName <n> [-Platform <p>]` → `@{id, key}` o `$null` si 409
- `Save-Keys`, `Import-Keys` → manejo de `.test-keys.json`
- `Send-OfficeMessage -From -To -Message [-Keys] [-Quiet]` → respuesta del POST /v1/send
- `Get-RegisteredAgents` → lista de agentes
- `Get-OfficeUrl` → URL configurada (default `http://localhost:8000`, override con `$env:OFFICE_URL`)
