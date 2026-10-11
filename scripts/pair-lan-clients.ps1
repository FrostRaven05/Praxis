param(
  [string]$DesktopDataDirectory = (Join-Path $env:APPDATA 'com.praxis.desktop'),
  [string]$AndroidSerial = 'emulator-5554',
  [switch]$DesktopOnly,
  [switch]$MobileOnly
)
$ErrorActionPreference = 'Stop'
if ($DesktopOnly -and $MobileOnly) { throw 'Choose at most one target restriction.' }
$repoRoot = Split-Path -Parent $PSScriptRoot
$lanDirectory = Join-Path $repoRoot '.tools/lan'
$clients = Get-Content -Raw -LiteralPath (Join-Path $lanDirectory 'clients.json') | ConvertFrom-Json
$caPem = Get-Content -Raw -LiteralPath (Join-Path $lanDirectory 'ca.crt')
function Get-PairingJson($label) {
  $device = @($clients.devices | Where-Object { $_.label -eq $label })
  if ($device.Count -ne 1) { throw 'Expected exactly one configured development device.' }
  return @{ baseUrl=$clients.baseUrl; ownerId=$device[0].ownerId; deviceId=$device[0].deviceId; token=$device[0].token; caPem=$caPem } | ConvertTo-Json -Compress
}
if (-not $MobileOnly) {
  New-Item -ItemType Directory -Force -Path $DesktopDataDirectory | Out-Null
  Add-Type -AssemblyName System.Security.Cryptography.ProtectedData
  $plainBytes = [System.Text.Encoding]::UTF8.GetBytes((Get-PairingJson 'desktop-dev'))
  try {
    $protected = [System.Security.Cryptography.ProtectedData]::Protect($plainBytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    [System.IO.File]::WriteAllBytes((Join-Path $DesktopDataDirectory 'lan-sync.dpapi'), $protected)
  } finally { [Array]::Clear($plainBytes, 0, $plainBytes.Length) }
  Write-Output 'Desktop pairing saved using Windows current-user DPAPI.'
}
if (-not $DesktopOnly) {
  $adbPath = Join-Path $env:LOCALAPPDATA 'Android/Sdk/platform-tools/adb.exe'
  if (-not (Test-Path -LiteralPath $adbPath)) { throw 'Android platform-tools adb was not found.' }
  # Stream directly into the app-private directory. No plaintext file on sdcard or /data/local/tmp.
  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $adbPath
  foreach ($argument in @('-s',$AndroidSerial,'shell','run-as','com.praxis.mobile','sh','-c',"'cat > files/lan-provision.json'")) { $startInfo.ArgumentList.Add($argument) }
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardInput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.RedirectStandardOutput = $true
  $process = [System.Diagnostics.Process]::Start($startInfo)
  $process.StandardInput.Write((Get-PairingJson 'android-dev'))
  $process.StandardInput.Close()
  $process.WaitForExit()
  if ($process.ExitCode -ne 0) { throw 'Android pairing failed. Verify a debuggable Praxis APK and selected emulator are available.' }
  Write-Output 'Android debug provisioning saved in app-private storage; next app start consumes it into Android Keystore encryption.'
}
Write-Output 'Pairing prepared. Restart the selected apps. Tokens were not printed.'
