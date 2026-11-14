$ErrorActionPreference = 'Stop'
$m0Root = Split-Path $PSScriptRoot -Parent
Push-Location $m0Root
$previousExport = [Environment]::GetEnvironmentVariable('PRAXIS_M0_EXPORT_DIR', 'Process')
try {
    $evidenceRoot = Join-Path $m0Root 'docs/evidence/m0-2026-11-10'
    $runRoot = Join-Path $m0Root ('.scratch/mvp-m0-baseline/run-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $runRoot | Out-Null
    $env:PRAXIS_M0_EXPORT_DIR = Join-Path $runRoot 'fixture'
    $utf8 = [Text.UTF8Encoding]::new($false)
    $steps = [Collections.Generic.List[object]]::new()
    function Invoke-M0Step([string]$Name, [string[]]$CommandArguments) {
        $ErrorActionPreference = 'Continue'
        $lines = [Collections.Generic.List[string]]::new()
        & pnpm.cmd @CommandArguments 2>&1 | ForEach-Object { $line = $_.ToString(); $lines.Add($line); Write-Host $line }
        $stepExit = $LASTEXITCODE
        [IO.File]::WriteAllText((Join-Path $runRoot ($Name + '.log')), ($lines -join "`n"), $utf8)
        $steps.Add([pscustomobject]@{name=$Name;command=('pnpm.cmd ' + ($CommandArguments -join ' '));exitCode=$stepExit})
    }
    Invoke-M0Step 'typecheck' @('typecheck')
    Invoke-M0Step 'typescript' @('test')
    Invoke-M0Step 'native' @('test:native')
    $baseline = Get-Content -LiteralPath (Join-Path $evidenceRoot 'pre-existing-files.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $changed = @($baseline.files | Where-Object { -not (Test-Path -LiteralPath $_.path -PathType Leaf) -or (Get-FileHash -LiteralPath $_.path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $_.sha256 } | ForEach-Object { $_.path })
    $fixture = Get-Content -LiteralPath 'docs/m0/fixtures.json' -Raw -Encoding UTF8 | ConvertFrom-Json
    $acceptance = Get-Content -LiteralPath 'docs/m0/acceptance-cases.json' -Raw -Encoding UTF8 | ConvertFrom-Json
    $caseIds = @($acceptance.cases | ForEach-Object { $_.id } | Sort-Object -Unique)
    $expectedIds = @(1..16 | ForEach-Object { 'AC{0:D2}' -f $_ })
    $badReferences = [Collections.Generic.List[string]]::new()
    foreach ($case in $acceptance.cases) {
        if (-not $case.steps.Count -or -not $case.expected.Count) { $badReferences.Add($case.id + ': empty procedure') }
        foreach ($pointer in $case.fixtureRefs) {
            $value = $fixture
            foreach ($part in $pointer.TrimStart('/').Split('/')) {
                if ($value -is [array]) {
                    $index = 0
                    if (-not [int]::TryParse($part, [ref]$index) -or $index -lt 0 -or $index -ge $value.Count) { $badReferences.Add($pointer); break }
                    $value = $value[$index]
                } elseif ($null -ne $value -and $value.PSObject.Properties.Name -contains $part) { $value = $value.$part }
                else { $badReferences.Add($pointer); break }
            }
        }
    }
    $tsText = Get-Content -LiteralPath (Join-Path $runRoot 'typescript.log') -Raw -Encoding UTF8
    $tsText = [regex]::Replace($tsText, '\x1B\[[0-?]*[ -/]*[@-~]', '')
    $tsCount = [regex]::Match($tsText, 'Tests\s+(\d+)\s+passed').Groups[1].Value
    $nativeText = Get-Content -LiteralPath (Join-Path $runRoot 'native.log') -Raw -Encoding UTF8
    $nativeCount = 0
    foreach ($match in [regex]::Matches($nativeText, 'test result: ok\. (\d+) passed')) { $nativeCount += [int]$match.Groups[1].Value }
    $fixtureManifestPath = Join-Path $env:PRAXIS_M0_EXPORT_DIR 'fixture-manifest.json'
    $fixtureManifest = if (Test-Path -LiteralPath $fixtureManifestPath) { Get-Content -LiteralPath $fixtureManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
    $fixturePassed = $null -ne $fixtureManifest -and $fixtureManifest.synthetic -eq $true -and $fixtureManifest.schemaVersion -eq 25 -and $fixtureManifest.allTablesEqualAfterRestore -eq $true -and $fixtureManifest.originalUnchanged -eq $true
    $allPassed = @($steps | Where-Object { $_.exitCode -ne 0 }).Count -eq 0 -and [int]$tsCount -gt 0 -and $nativeCount -gt 0 -and $changed.Count -eq 0 -and $badReferences.Count -eq 0 -and ($caseIds -join ',') -eq ($expectedIds -join ',') -and $acceptance.cases.Count -eq 16 -and $fixturePassed
    $results = [ordered]@{date='2026-11-10';stage='M0';passed=$allPassed;runDirectory=$runRoot.Substring($m0Root.Length + 1).Replace('\','/');steps=$steps.ToArray();typescriptTestsPassed=$tsCount;nativeTestsPassed=$nativeCount;protectedExistingFiles=$baseline.files.Count;changedExistingFiles=$changed;acceptanceCases=$caseIds;badFixtureReferences=$badReferences.ToArray();syntheticDatabase=$fixtureManifest;productAcceptance='M1-M5 pending; no real-user migration or UI release'}
    $resultJson = $results | ConvertTo-Json -Depth 10
    [IO.File]::WriteAllText((Join-Path $runRoot 'results.json'), $resultJson, $utf8)
    [IO.File]::WriteAllText((Join-Path $evidenceRoot 'results.json'), $resultJson, $utf8)
    $resultJson
    if (-not $allPassed) { throw 'M0 validation failed; inspect results and retained logs. Do not overwrite baseline hashes.' }
} finally {
    [Environment]::SetEnvironmentVariable('PRAXIS_M0_EXPORT_DIR', $previousExport, 'Process')
    Pop-Location
}
