$ErrorActionPreference = 'Stop'
$praxisRoot = Split-Path $PSScriptRoot -Parent
if (Test-Path (Join-Path $praxisRoot '.tools\cargo\bin\cargo.exe')) {
    $env:CARGO_HOME = Join-Path $praxisRoot '.tools\cargo'
    $env:RUSTUP_HOME = Join-Path $praxisRoot '.tools\rustup'
    $env:PATH = (Join-Path $env:CARGO_HOME 'bin') + ';' + $env:PATH
}
$vswherePath = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (Test-Path $vswherePath) {
    $vsPath = & $vswherePath -latest -products '*' -property installationPath
    if (-not $vsPath) {
        $vsPath = & $vswherePath -all -products '*' -property installationPath | Select-Object -First 1
    }
    if ($vsPath) {
        $vcvarsPath = Join-Path $vsPath 'VC\Auxiliary\Build\vcvars64.bat'
        if (Test-Path $vcvarsPath) {
            # Import only the build environment of the detected Visual Studio installation.
            $buildEnv = & cmd.exe /d /c "call `"$vcvarsPath`" >nul && set"
            if ($LASTEXITCODE -ne 0) { throw 'Could not initialize the Visual C++ environment.' }
            foreach ($line in $buildEnv) {
                if ($line -match '^([^=]+)=(.*)$') {
                    [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
                }
            }
        }
    }
}
