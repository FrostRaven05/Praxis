$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'native-env.ps1')
$praxisRoot = Split-Path $PSScriptRoot -Parent
Push-Location $praxisRoot
try {
    pnpm --filter @praxis/desktop tauri build --features tauri/custom-protocol --bundles nsis --config src-tauri/tauri.release.conf.json --ci
    if ($LASTEXITCODE -ne 0) { throw 'Windows installer build failed.' }
    $version = (Get-Content 'apps/desktop/src-tauri/tauri.conf.json' -Raw | ConvertFrom-Json).version
    $source = Join-Path $praxisRoot "apps/desktop/src-tauri/target/release/bundle/nsis/Praxis_${version}_x64-setup.exe"
    if (-not (Test-Path -LiteralPath $source)) { throw 'Windows installer was not generated.' }
    $output = Join-Path $praxisRoot ".tools/releases/$version"
    New-Item -ItemType Directory -Force -Path $output | Out-Null
    $destination = Join-Path $output "Praxis-$version-windows-x64-setup.exe"
    Copy-Item -LiteralPath $source -Destination $destination
    Get-Item -LiteralPath $destination | Select-Object FullName, Length
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        [BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($destination))).Replace('-', '').ToLowerInvariant()
    } finally { $sha.Dispose() }
} finally {
    Pop-Location
}
