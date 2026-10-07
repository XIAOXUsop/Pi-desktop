param([string]$NodePath)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$logDirectory = Join-Path $projectRoot '.agent\desktop-launch'
try {
    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
    $runId = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $buildLog = Join-Path $logDirectory "$runId-build.log"
    if (-not $NodePath) { $NodePath = (Get-Command node.exe -ErrorAction Stop).Source }
    if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw 'Node.js was not found. Recreate the shortcut after installing Node.js.' }
    $compiler = Join-Path $projectRoot 'node_modules\typescript\bin\tsc'
    $electron = Join-Path $projectRoot 'node_modules\electron\dist\electron.exe'
    if (-not (Test-Path -LiteralPath $compiler) -or -not (Test-Path -LiteralPath $electron)) { throw 'Desktop dependencies are missing. See docs/desktop.md for installation steps.' }
    Push-Location -LiteralPath $projectRoot
    try {
        & $NodePath $compiler -p tsconfig.json 2>&1 | Out-File -LiteralPath $buildLog -Encoding UTF8
        if ($LASTEXITCODE -ne 0) { throw "Build failed. Details: $buildLog" }
    } finally { Pop-Location }
    Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    $entry = Join-Path $projectRoot 'desktop\main.mjs'
    $process = Start-Process -FilePath $electron -ArgumentList ('"{0}"' -f $entry) -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDirectory "$runId-out.log") -RedirectStandardError (Join-Path $logDirectory "$runId-error.log") -PassThru
    $process.Id | Set-Content -LiteralPath (Join-Path $logDirectory 'latest-pid.txt') -Encoding ASCII
    Start-Sleep -Seconds 2
    $process.Refresh()
    if ($process.HasExited -and $process.ExitCode -ne 0) { throw "Desktop exited unexpectedly. Logs: $logDirectory" }
} catch {
    $message = $_.Exception.Message
    $popup = New-Object -ComObject WScript.Shell
    $popup.Popup($message, 0, 'Pi-desktop - Startup error', 16) | Out-Null
    exit 1
}
