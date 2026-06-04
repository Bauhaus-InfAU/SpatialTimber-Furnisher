# Builds the engine CLI + the Grasshopper plugin, then copies the .gha into the
# Grasshopper Libraries folder so Rhino 8 loads it on next start.
#
# Usage:  pwsh -ExecutionPolicy Bypass -File .\install.ps1

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

Write-Host "==> Building engine CLI (Node bundle)..." -ForegroundColor Cyan
Push-Location (Join-Path $root "engine-cli")
if (-not (Test-Path "node_modules")) { npm install }
npm run build
Pop-Location

Write-Host "==> Building Grasshopper plugin (.gha)..." -ForegroundColor Cyan
Push-Location (Join-Path $root "plugin")
dotnet build -c Release
Pop-Location

$gha = Join-Path $root "plugin\bin\Release\net7.0-windows\FurnisherForRhino.gha"
if (-not (Test-Path $gha)) { throw "Build did not produce $gha" }

$libs = Join-Path $env:APPDATA "Grasshopper\Libraries"
if (-not (Test-Path $libs)) { New-Item -ItemType Directory -Force $libs | Out-Null }

# Unblock so Rhino doesn't refuse to load a "downloaded" assembly.
Copy-Item $gha (Join-Path $libs "FurnisherForRhino.gha") -Force
Unblock-File (Join-Path $libs "FurnisherForRhino.gha")

# Point the plugin at the freshly built CLI regardless of repo location.
$cli = Join-Path $root "engine-cli\dist\furnisher-cli.cjs"
[Environment]::SetEnvironmentVariable("FURNISHER_CLI", $cli, "User")

Write-Host ""
Write-Host "Installed FurnisherForRhino.gha -> $libs" -ForegroundColor Green
Write-Host "FURNISHER_CLI (User env) -> $cli" -ForegroundColor Green
Write-Host "Restart Rhino 8 / Grasshopper to load the plugin." -ForegroundColor Yellow
