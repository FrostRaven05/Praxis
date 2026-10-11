$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $repoRoot '.tools/lan/process-id.txt'
if (-not (Test-Path -LiteralPath $pidFile)) { throw 'No managed LAN process recorded.' }
$lanProcessId = [int](Get-Content -LiteralPath $pidFile)
$process = Get-CimInstance Win32_Process -Filter "ProcessId=$lanProcessId"
$entryPath = Join-Path $repoRoot 'apps/api/dist/main.js'
if (-not $process) { Write-Output 'LAN process has already stopped.'; exit 0 }
if ($process.Name -ne 'node.exe' -or -not $process.CommandLine.Contains($entryPath)) { throw 'PID belongs to another process; refusing to stop it.' }
Stop-Process -Id $lanProcessId
Remove-Item -LiteralPath $pidFile
Write-Output 'Praxis LAN stopped. SQLite database and credentials retained.'
