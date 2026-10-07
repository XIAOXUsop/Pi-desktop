param([string]$ShortcutPath)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $ShortcutPath) { $ShortcutPath = Join-Path $projectRoot 'Pi-desktop.lnk' }
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$powershellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$launcherPath = Join-Path $PSScriptRoot 'launch-desktop.ps1'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut([System.IO.Path]::GetFullPath($ShortcutPath))
$shortcut.TargetPath = $powershellPath
$shortcut.Arguments = '-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -NodePath "{1}"' -f $launcherPath, $nodePath
$shortcut.WorkingDirectory = $projectRoot
$shortcut.WindowStyle = 7
$shortcut.Description = 'Open Pi-desktop desktop'
$shortcut.IconLocation = (Join-Path $projectRoot 'node_modules\electron\dist\electron.exe') + ',0'
$shortcut.Save()
Write-Output $ShortcutPath
