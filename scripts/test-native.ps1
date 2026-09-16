$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'native-env.ps1')
Push-Location (Split-Path $PSScriptRoot -Parent)
try {
    cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
    Pop-Location
}
