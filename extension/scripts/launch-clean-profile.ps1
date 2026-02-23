param(
  [string]$ChromePath = "",
  [switch]$ResetProfile
)

$extensionRoot = Split-Path -Parent $PSScriptRoot
$distPath = Join-Path $extensionRoot "dist"
$profilePath = Join-Path $env:TEMP "bugsnap-clean-profile"

if (-not (Test-Path $distPath)) {
  throw "Build output not found at '$distPath'. Run 'npm run build' in the extension folder first."
}

if ($ResetProfile -and (Test-Path $profilePath)) {
  Remove-Item -Path $profilePath -Recurse -Force
}

New-Item -ItemType Directory -Path $profilePath -Force | Out-Null

$chromeCandidates = @(
  $ChromePath,
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "$env:ProgramFiles(x86)\Google\Chrome\Application\chrome.exe"
) | Where-Object { $_ -and $_.Trim().Length -gt 0 }

$chromeExecutable = $chromeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $chromeExecutable) {
  throw "Could not locate Chrome. Provide -ChromePath with the full path to chrome.exe."
}

& $chromeExecutable `
  "--user-data-dir=$profilePath" `
  "--disable-extensions-except=$distPath" `
  "--load-extension=$distPath"
