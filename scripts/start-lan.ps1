param([Parameter(Mandatory=$true)][string]$LanAddress)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot
$runtimeRoot = Join-Path $repoRoot '.tools/lan'
New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
# Protect private TLS keys and device tokens before generating them.
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $runtimeRoot /inheritance:r /grant:r "${identity}:(OI)(CI)F" 'SYSTEM:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not protect the local credentials directory.' }
& node scripts/setup-lan.mjs $LanAddress
if ($LASTEXITCODE -ne 0) { throw 'LAN setup failed.' }
& pnpm --filter '@praxis/api' build
if ($LASTEXITCODE -ne 0) { throw 'API build failed.' }
$listener = Get-NetTCPConnection -LocalPort 4318 -State Listen -ErrorAction SilentlyContinue
if ($listener) { throw 'Port 4318 is already listening. Keep the existing process or stop it explicitly.' }
$nodePath = (Get-Command node).Source
$entryPath = Join-Path $repoRoot 'apps/api/dist/main.js'
$process = Start-Process -FilePath $nodePath -ArgumentList @('"' + $entryPath + '"') -WorkingDirectory $repoRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeRoot 'stdout.log') -RedirectStandardError (Join-Path $runtimeRoot 'stderr.log') -PassThru
Start-Sleep -Seconds 2
$process.Refresh()
if ($process.HasExited) { throw 'API stopped during startup. Check .tools/lan/stderr.log.' }
$process.Id | Set-Content -LiteralPath (Join-Path $runtimeRoot 'process-id.txt')
Write-Output "Praxis LAN started: https://${LanAddress}:4318 (PID $($process.Id))"
Write-Output 'TLS CA: .tools/lan/ca.crt; credentials: .tools/lan/clients.json. No automatic startup configured.'
