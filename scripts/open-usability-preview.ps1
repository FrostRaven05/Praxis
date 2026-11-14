$ErrorActionPreference = 'Stop'
$praxisRoot = Split-Path $PSScriptRoot -Parent
$praxisRelease = Join-Path $praxisRoot '.tools/releases/desktop-usability'
$praxisPreview = Join-Path $praxisRelease 'preview'
$praxisExecutable = Join-Path $praxisRelease 'Praxis.exe'
if (-not (Test-Path -LiteralPath (Join-Path $praxisPreview 'client/praxis.db'))) {
    throw 'The isolated preview is not prepared. Original desktop data will not be opened.'
}
$praxisPreviousData = $env:PRAXIS_DATA_DIR
$praxisPreviousWebview = $env:WEBVIEW2_USER_DATA_FOLDER
$praxisPreviousArguments = $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
try {
    $env:PRAXIS_DATA_DIR = Join-Path $praxisPreview 'client'
    $env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $praxisPreview 'webview'
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9260 --remote-debugging-address=127.0.0.1'
    Start-Process -FilePath $praxisExecutable -WorkingDirectory $praxisRoot -WindowStyle Normal
} finally {
    $env:PRAXIS_DATA_DIR = $praxisPreviousData
    $env:WEBVIEW2_USER_DATA_FOLDER = $praxisPreviousWebview
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $praxisPreviousArguments
}
