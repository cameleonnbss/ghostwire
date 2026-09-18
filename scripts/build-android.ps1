# GhostWire Android - toolchain APK build for Windows (no Gradle).
# Requires: Android SDK (ANDROID_HOME), JDK 17+, PowerShell 5+.
$ErrorActionPreference = 'Stop'
$Root = [System.IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $PSCommandPath) '..'))
$Src = [System.IO.Path]::GetFullPath((Join-Path $Root 'android/app/src/main'))
$Out = [System.IO.Path]::GetFullPath((Join-Path $Root 'android/app/build'))
$KtVersion = if ($env:KT_VERSION) { $env:KT_VERSION } else { '2.0.20' }
$BuildTools = if ($env:BUILD_TOOLS) { $env:BUILD_TOOLS } else { '36.0.0' }
$Platform = if ($env:PLATFORM) { $env:PLATFORM } else { 'android-36' }

$Sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME }
       elseif ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT }
       elseif ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Android/Sdk' }
       else { Join-Path $env:USERPROFILE 'Android/Sdk' }
$Bt = Join-Path $Sdk "build-tools/$BuildTools"
$Aj = Join-Path $Sdk "platforms/$Platform/android.jar"

if (-not (Test-Path "$Bt/aapt2.exe")) { Write-Error "Missing $Bt/aapt2.exe" }
if (-not (Test-Path $Aj)) { Write-Error "Missing $Aj" }

Write-Host '[1/6] Compiling Kotlin...'
$Kotlinc = Join-Path $Root '.toolchain/kotlinc/bin/kotlinc.bat'
if (-not (Test-Path $Kotlinc)) {
  Write-Host "  downloading kotlin-compiler-$KtVersion..."
  New-Item -ItemType Directory -Force -Path (Join-Path $Root '.toolchain') | Out-Null
  $zip = Join-Path $Root '.toolchain/kotlin.zip'
  Invoke-WebRequest -Uri "https://github.com/JetBrains/kotlin/releases/download/v$KtVersion/kotlin-compiler-$KtVersion.zip" -OutFile $zip
  Expand-Archive -Path $zip -DestinationPath (Join-Path $Root '.toolchain') -Force
  Remove-Item $zip
}
New-Item -ItemType Directory -Force -Path (Join-Path $Out 'classes') | Out-Null
# kotlinc prints progress/warnings on stderr; flatten to text so PS doesn't fail on them
$kotlinOut = & cmd /c "`"$Kotlinc`" -classpath `"$Aj`" -d `"$Out\classes`" `"$Src\java\com\ghostwire\app\MainActivity.kt`" 2>&1"
$kotlinErrors = $kotlinOut | Where-Object { $_ -match '^error:' -or $_ -match ': error:' }
if ($LASTEXITCODE -ne 0 -or $kotlinErrors) { $kotlinErrors | ForEach-Object { Write-Host $_ }; exit 1 }

Write-Host '[2/6] Dexing (d8)...'
New-Item -ItemType Directory -Force -Path (Join-Path $Out 'dex') | Out-Null
Push-Location (Join-Path $Out 'classes')
$classes = Get-ChildItem -Recurse -Filter '*.class' | ForEach-Object { $_.FullName.Substring((Get-Location).Path.Length + 1) }
& "$Bt/d8.bat" --min-api 24 --lib $Aj --output (Join-Path $Out 'dex') @classes
Pop-Location

Write-Host '[3/6] Packaging resources (aapt2)...'
New-Item -ItemType Directory -Force -Path (Join-Path $Out 'stage') | Out-Null
# aapt2 misbehaves on non-ASCII absolute paths -> run from repo root with relative paths
Push-Location $Root
& "$Bt/aapt2.exe" compile --dir 'android/app/src/main/res' -o 'android/app/build/res.zip'
& "$Bt/aapt2.exe" link -o 'android/app/build/stage/base.apk' -I $Aj --manifest 'android/app/src/main/AndroidManifest.xml' 'android/app/build/res.zip'
Pop-Location

Write-Host '[4/6] Adding classes.dex...'
Compress-Archive -Path (Join-Path $Out 'dex/classes.dex') -DestinationPath (Join-Path $Out 'stage/dex.zip') -Force
# Append classes.dex into the APK as STORED entry via zip manipulation
$apk = Join-Path $Out 'stage/base.apk'
Copy-Item $apk (Join-Path $Out 'stage/ghostwire-unsigned.apk') -Force
Push-Location (Join-Path $Out 'dex')
& jar uf (Join-Path $Out 'stage/ghostwire-unsigned.apk') classes.dex
Pop-Location

Write-Host '[5/6] Aligning...'
& "$Bt/zipalign.exe" -f 4 (Join-Path $Out 'stage/ghostwire-unsigned.apk') (Join-Path $Out 'stage/ghostwire-aligned.apk')

Write-Host '[6/6] Signing...'
$Keystore = Join-Path $Out 'ghostwire.keystore'
if (-not (Test-Path $Keystore)) {
  & keytool -genkeypair -keystore $Keystore -alias ghostwire -keyalg RSA -keysize 2048 -validity 10000 -storepass ghostwire -keypass ghostwire -dname 'CN=GhostWire, OU=GhostWire, O=GhostWire, L=Internet, C=FR'
}
& "$Bt/apksigner.bat" sign --ks $Keystore --ks-pass pass:ghostwire --key-pass pass:ghostwire --out (Join-Path $Root 'android/GhostWire.apk') (Join-Path $Out 'stage/ghostwire-aligned.apk')

Write-Host "OK: $(Join-Path $Root 'android/GhostWire.apk')"
