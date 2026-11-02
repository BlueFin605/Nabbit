# Start Nabbit's local stack (Aspire AppHost): LocalStack, Cognito Local, MailHog, init-db, backend, frontend.
# Works in Windows PowerShell 5.1 and PowerShell 7. Run via `npm run dev` or directly.
#
# Host ports default to the values below and can be overridden with env vars, e.g. to run
# beside another project that holds 3000 / 4566 / 9229 / 15888:
#   NABBIT_BACKEND_PORT, NABBIT_LOCALSTACK_PORT, NABBIT_COGNITO_PORT, NABBIT_MAILHOG_UI_PORT,
#   NABBIT_MAILHOG_SMTP_PORT, NABBIT_FRONTEND_PORT, NABBIT_DASHBOARD_PORT,
#   NABBIT_OTLP_GRPC_PORT, NABBIT_OTLP_HTTP_PORT

$ErrorActionPreference = "Stop"

function Get-PortSetting([string]$Name, [int]$Default) {
    $value = [Environment]::GetEnvironmentVariable($Name)
    if ($value -match '^\d+$') { return [int]$value }
    return $Default
}

function Test-PortInUse([int]$Port) {
    $listener = $null
    try {
        $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $Port)
        $listener.Start()
        return $false
    } catch {
        return $true
    } finally {
        if ($listener) { $listener.Stop() }
    }
}

Write-Host "Starting Nabbit Aspire..." -ForegroundColor Cyan
Write-Host ""

# Docker must be running (LocalStack, Cognito Local and MailHog are containers)
cmd /c "docker info >nul 2>&1"
if ($LASTEXITCODE -ne 0) {
    Write-Host "X Docker is not running. Start Docker Desktop and try again." -ForegroundColor Red
    exit 1
}

$ports = [ordered]@{
    "Backend (NABBIT_BACKEND_PORT)"            = Get-PortSetting "NABBIT_BACKEND_PORT" 3000
    "LocalStack (NABBIT_LOCALSTACK_PORT)"      = Get-PortSetting "NABBIT_LOCALSTACK_PORT" 4566
    "Cognito Local (NABBIT_COGNITO_PORT)"      = Get-PortSetting "NABBIT_COGNITO_PORT" 9229
    "MailHog UI (NABBIT_MAILHOG_UI_PORT)"      = Get-PortSetting "NABBIT_MAILHOG_UI_PORT" 8025
    "MailHog SMTP (NABBIT_MAILHOG_SMTP_PORT)"  = Get-PortSetting "NABBIT_MAILHOG_SMTP_PORT" 1025
    "Frontend (NABBIT_FRONTEND_PORT)"          = Get-PortSetting "NABBIT_FRONTEND_PORT" 5173
    "Dashboard (NABBIT_DASHBOARD_PORT)"        = Get-PortSetting "NABBIT_DASHBOARD_PORT" 15888
    "OTLP gRPC (NABBIT_OTLP_GRPC_PORT)"        = Get-PortSetting "NABBIT_OTLP_GRPC_PORT" 4317
    "OTLP HTTP (NABBIT_OTLP_HTTP_PORT)"        = Get-PortSetting "NABBIT_OTLP_HTTP_PORT" 4318
}

# Warn only: another project may legitimately hold a default port. Nothing is stopped or reused.
$busy = @()
foreach ($entry in $ports.GetEnumerator()) {
    if (Test-PortInUse $entry.Value) { $busy += $entry }
}
if ($busy.Count -gt 0) {
    Write-Host "! These ports are already in use (another project?):" -ForegroundColor Yellow
    foreach ($entry in $busy) {
        Write-Host ("    {0} -> {1}" -f $entry.Key, $entry.Value) -ForegroundColor Yellow
    }
    Write-Host "  Set the named env var to a free port, e.g. `$env:NABBIT_BACKEND_PORT = 3100" -ForegroundColor Yellow
    Write-Host ""
}

# Pass resolved values through so the AppHost and the dashboard agree
$env:NABBIT_BACKEND_PORT = $ports["Backend (NABBIT_BACKEND_PORT)"]
$env:NABBIT_LOCALSTACK_PORT = $ports["LocalStack (NABBIT_LOCALSTACK_PORT)"]
$env:NABBIT_COGNITO_PORT = $ports["Cognito Local (NABBIT_COGNITO_PORT)"]
$env:NABBIT_MAILHOG_UI_PORT = $ports["MailHog UI (NABBIT_MAILHOG_UI_PORT)"]
$env:NABBIT_MAILHOG_SMTP_PORT = $ports["MailHog SMTP (NABBIT_MAILHOG_SMTP_PORT)"]
$env:NABBIT_FRONTEND_PORT = $ports["Frontend (NABBIT_FRONTEND_PORT)"]

# Set environment variables for Aspire
$env:ASPIRE_ALLOW_UNSECURED_TRANSPORT = "true"
$env:DOTNET_DASHBOARD_OTLP_ENDPOINT_URL = "http://localhost:$($ports['OTLP gRPC (NABBIT_OTLP_GRPC_PORT)'])"
$env:DOTNET_DASHBOARD_OTLP_HTTP_ENDPOINT_URL = "http://localhost:$($ports['OTLP HTTP (NABBIT_OTLP_HTTP_PORT)'])"
$env:ASPNETCORE_URLS = "http://localhost:$($ports['Dashboard (NABBIT_DASHBOARD_PORT)'])"
$env:ASPNETCORE_ENVIRONMENT = "Development"

Write-Host "This will start the following:" -ForegroundColor Gray
Write-Host "  - LocalStack (S3 + DynamoDB) on port $($env:NABBIT_LOCALSTACK_PORT)" -ForegroundColor Gray
Write-Host "  - Cognito Local (authentication) on port $($env:NABBIT_COGNITO_PORT)" -ForegroundColor Gray
Write-Host "  - MailHog (SMTP testing) on ports $($env:NABBIT_MAILHOG_SMTP_PORT) (SMTP) and $($env:NABBIT_MAILHOG_UI_PORT) (UI)" -ForegroundColor Gray
Write-Host "  - init-db (creates the DynamoDB table and image bucket, then exits)" -ForegroundColor Gray
Write-Host "  - backend (Express wrapper around the Lambda handlers) on port $($env:NABBIT_BACKEND_PORT)" -ForegroundColor Gray
Write-Host "  - frontend (ng serve) on port $($env:NABBIT_FRONTEND_PORT)" -ForegroundColor Gray
Write-Host "  - Aspire dashboard on $($env:ASPNETCORE_URLS)" -ForegroundColor Gray
Write-Host ""

# --no-launch-profile: the env above is authoritative (launchSettings.json is for IDE runs)
$appHostProject = Join-Path $PSScriptRoot "aspire/Nabbit.AppHost/Nabbit.AppHost.csproj"
dotnet run --no-launch-profile --project $appHostProject
exit $LASTEXITCODE
