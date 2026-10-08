param([Parameter(Mandatory=$true)][string]$FixtureProfile,[string]$PreviousVersion='0.1.3',[switch]$IsolateExistingRegistration)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
$version=(Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
$guid='352a7e81-c4be-5d38-9e4d-190da074a7b6'
$registryPaths=@("Software\$guid","Software\Microsoft\Windows\CurrentVersion\Uninstall\$guid")
# By default require a clean account. Isolation explicitly preserves the two
# current-user application keys by renaming them, never unregistering other apps.
$registered=@{}
foreach($view in @([Microsoft.Win32.RegistryView]::Registry32,[Microsoft.Win32.RegistryView]::Registry64)){
  foreach($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryHive]::LocalMachine)){
    $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey($hive,$view)
    try{foreach($path in $registryPaths){$entry=$base.OpenSubKey($path);if($entry){$entry.Dispose();if(-not $IsolateExistingRegistration -or $hive -ne [Microsoft.Win32.RegistryHive]::CurrentUser){throw 'Pi-desktop is already registered. Use a clean account or explicit current-user registration isolation.'};$registered[$path]=$true}}}finally{$base.Dispose()}
  }
}
if(Get-Process 'Pi-desktop' -ErrorAction SilentlyContinue){throw 'Close the test application before verifying installation.'}
$testRoot=Join-Path $root ('.agent\verification\installation\run-'+[guid]::NewGuid().ToString())
$install=[IO.Path]::GetFullPath((Join-Path $testRoot 'application'))
if(-not $install.StartsWith($root+'\.agent\verification\installation\',[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe installation destination'}
New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
$profile=Join-Path $testRoot 'profile'
New-Item -ItemType Directory -Path $profile | Out-Null
$sourceProfile=[IO.Path]::GetFullPath($FixtureProfile)
if(-not $sourceProfile.StartsWith($root+'\.agent\verification\',[StringComparison]::OrdinalIgnoreCase) -and -not $sourceProfile.StartsWith($root+'\.agent\desktop-smoke-profile\',[StringComparison]::OrdinalIgnoreCase)){throw 'Use a test-generated profile, never a real user profile'}
foreach($name in @('settings.json','models.json','keys.json','Local State','pi')){Copy-Item -LiteralPath (Join-Path $sourceProfile $name) -Destination (Join-Path $profile $name) -Recurse}
$settingsFile=Join-Path $profile 'settings.json'
$settings=Get-Content -LiteralPath $settingsFile -Raw -Encoding UTF8 | ConvertFrom-Json
$settings.preferences.theme='dark'
[IO.File]::WriteAllText($settingsFile,($settings | ConvertTo-Json -Depth 40),[Text.UTF8Encoding]::new($false))
$keysHash=(Get-FileHash -LiteralPath (Join-Path $profile 'keys.json') -Algorithm SHA256).Hash
$modelHash=(Get-FileHash -LiteralPath (Join-Path $profile 'models.json') -Algorithm SHA256).Hash
$journal=$settings.lastSession
if(-not ([IO.Path]::GetFullPath($journal)).StartsWith($root+'\.agent\',[StringComparison]::OrdinalIgnoreCase)){throw 'Fixture session is outside the test directory'}
$journalHash=(Get-FileHash -LiteralPath $journal -Algorithm SHA256).Hash
$originalJournal=[IO.File]::ReadAllBytes($journal)
[IO.File]::WriteAllBytes((Join-Path $testRoot 'original-session.jsonl'),$originalJournal)
$resourceFile=Join-Path $profile 'pi\resources.json'
$resourceData=Get-Content -LiteralPath $resourceFile -Raw -Encoding UTF8 | ConvertFrom-Json
$enabled=@($resourceData.overrides.global.PSObject.Properties | Where-Object Value | Select-Object -ExpandProperty Name)
if($enabled.Count -lt 2){throw 'Fixture must contain two enabled extensions'}
$disabled=$enabled[0];$retained=$enabled[1];$resourceData.overrides.global.$disabled=$false
[IO.File]::WriteAllText($resourceFile,($resourceData | ConvertTo-Json -Depth 40),[Text.UTF8Encoding]::new($false))
$shortcuts=@((Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'Pi-desktop.lnk'),(Join-Path ([Environment]::GetFolderPath('Programs')) 'Pi-desktop.lnk'))
$copies=@{}
foreach($path in $shortcuts){if(Test-Path -LiteralPath $path){$backup=Join-Path $testRoot ('shortcut-'+$copies.Count+'.lnk');Copy-Item -LiteralPath $path -Destination $backup;$copies[$path]=$backup}else{$copies[$path]=$null}}
$oldEnv=$env:ELECTRON_RUN_AS_NODE;Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
function Run-Checked([string]$file,[string[]]$arguments){$p=Start-Process -FilePath $file -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru;if($p.ExitCode -ne 0){throw ('Verification process failed: '+$p.ExitCode)}}
function Verify-Preserved {
  if((Get-FileHash -LiteralPath (Join-Path $profile 'keys.json')).Hash -ne $keysHash){throw 'Encrypted key data changed'}
  if((Get-FileHash -LiteralPath (Join-Path $profile 'models.json')).Hash -ne $modelHash){throw 'Model configuration changed'}
  $currentJournal=[IO.File]::ReadAllBytes($journal)
  if($currentJournal.Length -lt $originalJournal.Length){throw 'Canonical conversation truncated'}
  $hasher=[Security.Cryptography.SHA256]::Create()
  try{$prefixHash=[BitConverter]::ToString($hasher.ComputeHash($currentJournal,0,$originalJournal.Length)).Replace('-','')}finally{$hasher.Dispose()}
  if($prefixHash -ne $journalHash){throw 'Existing canonical conversation bytes changed'}
  $extra=[Text.Encoding]::UTF8.GetString($currentJournal,$originalJournal.Length,$currentJournal.Length-$originalJournal.Length)
  foreach($line in ($extra -split "`n")){if(-not $line.Trim()){continue};$entry=$line | ConvertFrom-Json;if($entry.type -ne 'entry' -or $entry.data.kind -ne 'model'){throw 'Startup unexpectedly appended non-model conversation content'}}
  $value=Get-Content -LiteralPath $settingsFile -Raw -Encoding UTF8 | ConvertFrom-Json
  if($value.preferences.theme -ne 'dark' -or $value.lastSession -ne $journal){throw 'Preferences or selected conversation lost'}
  $r=Get-Content -LiteralPath $resourceFile -Raw -Encoding UTF8 | ConvertFrom-Json
  if($r.overrides.global.$disabled -ne $false -or $r.overrides.global.$retained -ne $true){throw 'Extension enable state lost'}
}
$checks=[Collections.Generic.List[string]]::new()
$registrationBackups=@{}
try {
  foreach($path in $registered.Keys){$literal='Registry::HKEY_CURRENT_USER\'+$path;$backupName=(Split-Path $path -Leaf)+'-test-backup-'+[guid]::NewGuid().ToString();$backup='Registry::HKEY_CURRENT_USER\'+(Split-Path $path -Parent)+'\'+$backupName;Rename-Item -LiteralPath $literal -NewName $backupName;$registrationBackups[$literal]=$backup}
  $previous=Join-Path $root ("release\Pi-desktop-Setup-$PreviousVersion-x64.exe")
  $candidate=Join-Path $root ("release\Pi-desktop-Setup-$version-x64.exe")
  Run-Checked $previous @('/S','/NoDesktopShortcut',('/D='+$install))
  $exe=Join-Path $install 'Pi-desktop.exe'
  if((Get-Item -LiteralPath $exe).VersionInfo.FileVersion -ne $PreviousVersion){throw 'Previous installer version mismatch'}
  Run-Checked $exe @('--startup-benchmark','--test-profile',('"'+$profile+'"'))
  Verify-Preserved;$checks.Add('previous installed application restores isolated fixture')
  Run-Checked $candidate @('/S','/NoDesktopShortcut',('/D='+$install))
  if((Get-Item -LiteralPath $exe).VersionInfo.FileVersion -ne $version){throw 'Upgrade version mismatch'}
  Run-Checked $exe @('--startup-benchmark','--test-profile',('"'+$profile+'"'))
  Verify-Preserved
  $startup=Get-Content -LiteralPath (Join-Path $profile 'startup-result.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if($startup.ui.error -or $startup.validation.keyLoadError -or $startup.validation.resourceErrors -ne 0){throw 'Installed application has a restoration error'}
  $models=Get-Content -LiteralPath (Join-Path $profile 'models.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $persisted=Get-Content -LiteralPath (Join-Path $profile 'keys.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach($provider in $models.providers){if($persisted.PSObject.Properties.Name -contains $provider.apiKeyEnv -and -not $startup.validation.keyStatus.($provider.id)){throw 'Persisted fixture key did not decrypt'}}
  $checks.Add('upgraded application starts with expected version')
  $checks.Add('encrypted key decrypts; ciphertext and model configuration retained')
  $checks.Add('existing conversation bytes retained; only startup model metadata appended')
  $checks.Add('selected session and preferences retained')
  $checks.Add('enabled and disabled extension state retained')
  Run-Checked (Join-Path $root 'scripts\..\release\win-unpacked\resources\runtime\node.exe') @(('"'+(Join-Path $root 'scripts\verify-package.mjs')+'"'),('"'+$exe+'"'))
  $checks.Add('installed application passes packaged behavior verification')
} finally {
  try{$uninstaller=Join-Path $install 'Uninstall Pi-desktop.exe';if(Test-Path -LiteralPath $uninstaller){Run-Checked $uninstaller @('/S',('_?='+$install))}}
  finally{
    foreach($literal in $registrationBackups.Keys){if(Test-Path -LiteralPath $literal){$entry=Get-Item -LiteralPath $literal;$location=$entry.GetValue('InstallLocation');$uninstall=$entry.GetValue('UninstallString');if($location -ne $install -and -not ($uninstall -and $uninstall.Contains($install))){throw 'Unexpected installation key. Original registration is retained under its backup name.'};if($entry.SubKeyCount){throw 'Unexpected installation registration child key'};Remove-Item -LiteralPath $literal};Rename-Item -LiteralPath $registrationBackups[$literal] -NewName (Split-Path $literal -Leaf)}
    foreach($path in $shortcuts){if($copies[$path]){Copy-Item -LiteralPath $copies[$path] -Destination $path -Force}elseif(Test-Path -LiteralPath $path){Remove-Item -LiteralPath $path}}
    if($null -ne $oldEnv){$env:ELECTRON_RUN_AS_NODE=$oldEnv}
  }
}
Verify-Preserved
if(Test-Path -LiteralPath (Join-Path $install 'Pi-desktop.exe')){throw 'Isolated uninstall did not remove application'}
$checks.Add('uninstall retains isolated settings, keys and conversation')
$report=@{version=$version;previousVersion=$PreviousVersion;profile=$profile;checks=$checks;status='passed'}
[IO.File]::WriteAllText((Join-Path $testRoot 'result.json'),($report | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
$report | ConvertTo-Json -Depth 8
