param([Parameter(Mandatory=$true)][string]$LanAddress)
$ErrorActionPreference = 'Stop'
$address = Get-NetIPAddress -AddressFamily IPv4 -IPAddress $LanAddress
if (-not $address -or $LanAddress -notmatch '^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)') { throw 'Choose a private IPv4 address assigned to this computer.' }
$nodePath = (Get-Command node).Source
$ruleName = 'Praxis-LAN-HTTPS-4318'
$existing = Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue
if ($existing) { throw 'A Praxis LAN rule already exists. Inspect it before changing the address.' }
New-NetFirewallRule -Name $ruleName -DisplayName 'Praxis LAN HTTPS 4318 (local subnet only)' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 4318 -LocalAddress $LanAddress -RemoteAddress LocalSubnet -InterfaceAlias $address.InterfaceAlias -Program $nodePath -Profile Any -ErrorAction Stop | Out-Null
$created = Get-NetFirewallRule -Name $ruleName -ErrorAction Stop
if ($created.Enabled -ne 'True') { throw 'Firewall rule was not enabled.' }
Write-Output "Allowed TCP 4318 on $LanAddress, interface $($address.InterfaceAlias), local subnet only."
