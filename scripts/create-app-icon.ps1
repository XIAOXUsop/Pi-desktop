$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'create-app-icon.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Application icon generation failed.' }
