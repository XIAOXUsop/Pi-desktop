param(
  [string]$InstallDirectory = (Join-Path $env:USERPROFILE 'AppData\Local\Programs\Pi-desktop')
)
$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path $PSScriptRoot -Parent
$package = Get-Content -LiteralPath (Join-Path $projectDirectory 'package.json') -Raw | ConvertFrom-Json
$installer = Join-Path $projectDirectory ("release\Pi-desktop-Setup-{0}-x64.exe" -f $package.version)
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw 'Build the installer with npm run package:win first.' }
$profileDirectory = Join-Path $env:APPDATA 'Pi-desktop'
$developmentProfile = Join-Path $projectDirectory '.agent\desktop-profile'
# Preserve the source profile and never overwrite an existing installed profile.
if (-not (Test-Path -LiteralPath (Join-Path $profileDirectory 'settings.json')) -and (Test-Path -LiteralPath (Join-Path $developmentProfile 'settings.json'))) {
  New-Item -ItemType Directory -Path $profileDirectory -Force | Out-Null
  foreach ($entry in @('settings.json','models.json','keys.json','pi')) {
    $source = Join-Path $developmentProfile $entry
    $destination = Join-Path $profileDirectory $entry
    if ((Test-Path -LiteralPath $source) -and -not (Test-Path -LiteralPath $destination)) {
      Copy-Item -LiteralPath $source -Destination $destination -Recurse
    }
  }
  @{ source = $developmentProfile; migratedAt = [DateTime]::UtcNow.ToString('o'); draftsRemainInSourceProfile = $true } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $profileDirectory 'migration-from-development.json') -Encoding UTF8
  Write-Output 'Existing settings and Pi resources copied; the source profile remains available.'
}
# NSIS requires /D to be the final argument and unquoted, even for paths with spaces.
$installProcess = Start-Process -FilePath $installer -ArgumentList @('/S',("/D=" + [IO.Path]::GetFullPath($InstallDirectory))) -WindowStyle Hidden -Wait -PassThru
if ($installProcess.ExitCode -ne 0) { throw ("Installer failed: {0}" -f $installProcess.ExitCode) }
$application = Join-Path $InstallDirectory 'Pi-desktop.exe'
if (-not (Test-Path -LiteralPath $application -PathType Leaf)) { throw 'Installed application is missing.' }
Write-Output ("Installed Pi-desktop: {0}" -f $application)
