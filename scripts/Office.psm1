# Office.psm1 — funciones reusables para tests del bridge.
# Usá: Import-Module .\scripts\Office.psm1 -Force

$Script:OfficeUrl = if ($env:OFFICE_URL) { $env:OFFICE_URL } else { "http://localhost:8000" }
$Script:KeysPath  = Join-Path $PSScriptRoot ".test-keys.json"

function Get-OfficeUrl { return $Script:OfficeUrl }
function Get-KeysPath  { return $Script:KeysPath }

function Test-Health {
    try {
        Invoke-RestMethod -Method Get -Uri "$Script:OfficeUrl/v1/health" -TimeoutSec 5 | Out-Null
        return $true
    } catch {
        return $false
    }
}

function Register-TestAgent {
    param(
        [Parameter(Mandatory)][string]$Id,
        [Parameter(Mandatory)][string]$DisplayName,
        [string]$Platform = "test"
    )
    $body = @{
        agent_id     = $Id
        display_name = $DisplayName
        platform     = $Platform
    } | ConvertTo-Json -Compress
    try {
        $r = Invoke-RestMethod -Method Post -Uri "$Script:OfficeUrl/v1/agents/register" `
            -ContentType "application/json" -Body $body -ErrorAction Stop
        return @{ id = $r.agent_id; key = $r.api_key }
    } catch {
        $resp = $_.Exception.Response
        if ($resp -and $resp.StatusCode -eq 409) {
            return $null  # already registered
        }
        throw
    }
}

function Save-Keys {
    param([Parameter(Mandatory)][hashtable]$Keys)
    $Keys | ConvertTo-Json | Out-File -FilePath $Script:KeysPath -Encoding utf8
}

function Import-Keys {
    if (-not (Test-Path $Script:KeysPath)) {
        throw "No existe $Script:KeysPath. Corré: .\scripts\setup.ps1"
    }
    $raw = Get-Content $Script:KeysPath -Raw | ConvertFrom-Json
    $h = @{}
    foreach ($p in $raw.PSObject.Properties) { $h[$p.Name] = $p.Value }
    return $h
}

function Send-OfficeMessage {
    param(
        [Parameter(Mandatory)][string]$From,
        [Parameter(Mandatory)][string]$To,
        [Parameter(Mandatory)][string]$Message,
        [hashtable]$Keys = $null,
        [switch]$Quiet
    )
    if (-not $Keys) { $Keys = Import-Keys }
    $key = $Keys[$From]
    if (-not $key) { throw "No hay api_key para '$From'. Corré .\scripts\setup.ps1 primero." }
    $body = @{
        from_agent = $From
        to_agent   = $To
        message    = $Message
    } | ConvertTo-Json -Compress
    try {
        $r = Invoke-RestMethod -Method Post -Uri "$Script:OfficeUrl/v1/send" `
            -ContentType "application/json" `
            -Headers @{ "X-API-Key" = $key } `
            -Body $body -ErrorAction Stop
        if (-not $Quiet) { Write-Host "  $From -> $To" -ForegroundColor DarkGray }
        return $r
    } catch {
        Write-Host "  ERROR $From -> $To : $($_.Exception.Message)" -ForegroundColor Red
    }
}

function Get-RegisteredAgents {
    Invoke-RestMethod -Method Get -Uri "$Script:OfficeUrl/v1/agents"
}

Export-ModuleMember -Function `
    Get-OfficeUrl, Get-KeysPath, Test-Health, `
    Register-TestAgent, Save-Keys, Import-Keys, `
    Send-OfficeMessage, Get-RegisteredAgents
