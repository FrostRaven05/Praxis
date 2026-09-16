$ErrorActionPreference = 'Stop'
$praxisRoot = Split-Path $PSScriptRoot -Parent
Push-Location $praxisRoot
try {
    . (Join-Path $PSScriptRoot 'native-env.ps1')
    pnpm --filter @praxis/desktop exec tauri build --debug --no-bundle
    if ($LASTEXITCODE -ne 0) { throw 'Desktop build failed' }
    # cargo test can replace target/debug with a dev-server-dependent binary.
    # Preserve this embedded-assets build separately before launching.
    $praxisPreview = Join-Path $praxisRoot ('.tools/desktop-preview/' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $praxisPreview -Force | Out-Null
    $praxisBinary = Join-Path $praxisPreview 'Praxis.exe'
    Copy-Item -LiteralPath (Join-Path $praxisRoot 'apps/desktop/src-tauri/target/debug/praxis-desktop.exe') -Destination $praxisBinary
    Write-Output ("Opening " + $praxisBinary)
    Start-Process -FilePath $praxisBinary -WorkingDirectory $praxisRoot -Wait
} finally {
    Pop-Location
}
