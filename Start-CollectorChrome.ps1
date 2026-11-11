[CmdletBinding(SupportsShouldProcess)]
param(
    [Alias('ChromePath')]
    [string]$BrowserPath,
    [string]$ProfileDirectory,
    [ValidateSet('Auto', 'Chrome', 'Brave')]
    [string]$Browser = 'Auto'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$browserNames = if ($Browser -eq 'Auto') { @('Chrome', 'Brave') } else { @($Browser) }
$browserLocations = @{
    Chrome = 'Google\Chrome\Application\chrome.exe'
    Brave = 'BraveSoftware\Brave-Browser\Application\brave.exe'
}
if (-not $BrowserPath) {
    $browserRoots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)
    foreach ($browserName in $browserNames) {
        foreach ($browserRoot in $browserRoots) {
            if (-not $browserRoot) { continue }
            $candidate = Join-Path $browserRoot $browserLocations[$browserName]
            if (Test-Path -LiteralPath $candidate -PathType Leaf) { $BrowserPath = $candidate; break }
        }
        if ($BrowserPath) { break }
    }
}
if (-not $BrowserPath -or -not (Test-Path -LiteralPath $BrowserPath -PathType Leaf)) {
    throw "$Browser browser was not found. Looked for $($browserNames -join ' / '). Run again with -BrowserPath pointing to chrome.exe or brave.exe."
}
$BrowserPath = (Resolve-Path -LiteralPath $BrowserPath).Path
$processName = [IO.Path]::GetFileName($BrowserPath)
$selectedBrowser = switch ($processName.ToLowerInvariant()) {
    'chrome.exe' { 'Chrome' }
    'brave.exe' { 'Brave' }
    default { throw 'BrowserPath must point to chrome.exe or brave.exe.' }
}
if ($Browser -ne 'Auto' -and $selectedBrowser -ne $Browser) {
    throw "BrowserPath points to $selectedBrowser, but -Browser requested $Browser."
}
$extensionsUrl = if ($selectedBrowser -eq 'Brave') { 'brave://extensions' } else { 'chrome://extensions' }
$profileRoot = if ($ProfileDirectory) { [IO.Path]::GetFullPath($ProfileDirectory) } else { $null }

# Reusing a running profile can ignore new command-line flags. Never close it automatically.
$running = if ($profileRoot) {
    Get-CimInstance Win32_Process -Filter "Name = '$processName'" -ErrorAction Stop |
        Where-Object { $_.CommandLine -and $_.CommandLine.Contains($profileRoot) }
} else {
    Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($processName)) -ErrorAction SilentlyContinue
}
if ($running) {
    $runningMessage = if ($profileRoot) {
        "This $selectedBrowser profile is already running. Fully exit its browser windows before running this launcher again so the startup flag can apply."
    } else {
        "$selectedBrowser is already running. Save your work and fully exit $selectedBrowser (including the empty collector window), then run this launcher again so the startup flag can apply."
    }
    if ($WhatIfPreference) { Write-Warning $runningMessage } else { throw $runningMessage }
}
$profileDescription = if ($profileRoot) { $profileRoot } else { 'regular browser profile' }
if (-not $PSCmdlet.ShouldProcess("$BrowserPath (profile: $profileDescription)", 'Launch collector browser with --silent-debugger-extension-api')) { return }
$launchArguments = @('--silent-debugger-extension-api', '--new-window', 'https://colonist.io/')
if ($profileRoot) {
    [void][IO.Directory]::CreateDirectory($profileRoot)
    $launchArguments = @('--user-data-dir="' + $profileRoot + '"') + $launchArguments
}

# Omit --user-data-dir by default so the browser uses its normal profile selection.
# The flag affects debugger warnings for every extension in this browser instance.
Start-Process -FilePath $BrowserPath -ArgumentList $launchArguments
Write-Host "Collector $selectedBrowser profile: $profileDescription"
Write-Host "Your existing extensions stay with their browser profile. If the collector is missing, enable Developer mode in $extensionsUrl and Load unpacked this directory:"
Write-Host $PSScriptRoot
Write-Host 'Start the collector, then refresh Colonist before joining a game.'
