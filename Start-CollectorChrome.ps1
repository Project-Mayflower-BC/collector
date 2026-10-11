[CmdletBinding()]
param(
    [string]$ChromePath,
    [string]$ProfileDirectory = (Join-Path $env:LOCALAPPDATA 'ColonistCollector\ChromeProfile')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $ChromePath) {
    $chromeRoots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)
    foreach ($chromeRoot in $chromeRoots) {
        if (-not $chromeRoot) { continue }
        $candidate = Join-Path $chromeRoot 'Google\Chrome\Application\chrome.exe'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $ChromePath = $candidate; break }
    }
}
if (-not $ChromePath -or -not (Test-Path -LiteralPath $ChromePath -PathType Leaf)) {
    throw 'Chrome was not found. Run again with -ChromePath pointing to chrome.exe.'
}
$ChromePath = (Resolve-Path -LiteralPath $ChromePath).Path
$profileRoot = [IO.Path]::GetFullPath($ProfileDirectory)

# Reusing a running profile can ignore new command-line flags. Never close it automatically.
$running = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($profileRoot) }
if ($running) {
    throw 'The collector Chrome profile is already running. Use that window, or close only its windows and run this launcher again.'
}
[void][IO.Directory]::CreateDirectory($profileRoot)
$profileArgument = '--user-data-dir="' + $profileRoot + '"'

# This is the visible browser the user will play in, using a separate local profile.
# The flag affects debugger warnings for every extension in this browser instance.
Start-Process -FilePath $ChromePath -ArgumentList @(
    $profileArgument,
    '--silent-debugger-extension-api',
    '--new-window',
    'https://colonist.io/'
)
Write-Host "Collector Chrome profile: $profileRoot"
Write-Host 'First run: enable Developer mode in chrome://extensions, then Load unpacked this directory:'
Write-Host $PSScriptRoot
Write-Host 'Sign in to Colonist in this separate profile. Start the collector, then refresh before joining a game.'
