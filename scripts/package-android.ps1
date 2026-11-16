$ErrorActionPreference = 'Stop'
$praxisRoot = Split-Path $PSScriptRoot -Parent
foreach ($name in @('JAVA_HOME', 'PRAXIS_ANDROID_KEYSTORE', 'PRAXIS_ANDROID_STORE_PASSWORD', 'PRAXIS_ANDROID_KEY_ALIAS', 'PRAXIS_ANDROID_KEY_PASSWORD')) {
    if (-not [Environment]::GetEnvironmentVariable($name)) { throw "Set $name before packaging Android." }
}
Push-Location $praxisRoot
try {
    pnpm --filter @praxis/client build
    if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
    pnpm --filter @praxis/mobile sync
    if ($LASTEXITCODE -ne 0) { throw 'Capacitor sync failed.' }
    Push-Location 'apps/mobile/android'
    try {
        .\gradlew.bat assembleRelease --no-daemon
        if ($LASTEXITCODE -ne 0) { throw 'Android release build failed.' }
    } finally { Pop-Location }
    $version = (Get-Content 'apps/desktop/src-tauri/tauri.conf.json' -Raw | ConvertFrom-Json).version
    $source = Join-Path $praxisRoot 'apps/mobile/android/app/build/outputs/apk/release/app-release.apk'
    if (-not (Test-Path -LiteralPath $source)) { throw 'Signed Android APK was not generated.' }
    $output = Join-Path $praxisRoot ".tools/releases/$version"
    New-Item -ItemType Directory -Force -Path $output | Out-Null
    $destination = Join-Path $output "Praxis-$version-android.apk"
    Copy-Item -LiteralPath $source -Destination $destination
    Get-Item -LiteralPath $destination | Select-Object FullName, Length
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        [BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($destination))).Replace('-', '').ToLowerInvariant()
    } finally { $sha.Dispose() }
} finally { Pop-Location }
