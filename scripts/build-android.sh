#!/usr/bin/env bash
# GhostWire Android — toolchain APK build (no Gradle required).
# Uses the Android SDK build-tools + a kotlinc fetched on demand.
# Works in GitHub Actions and locally (Linux/macOS/Termux-with-SDK).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/android/app/src/main"
OUT="$ROOT/android/app/build"
KT_VERSION="${KT_VERSION:-2.0.20}"
BUILD_TOOLS="${BUILD_TOOLS:-36.0.0}"
PLATFORM="${PLATFORM:-android-36}"
KEYSTORE="${KEYSTORE:-$OUT/ghostwire.keystore}"

SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$LOCALAPPDATA/Android/Sdk}}"
[ -d "$SDK" ] || SDK="$HOME/Android/Sdk"
[ -d "$SDK" ] || { echo "Android SDK not found (set ANDROID_HOME)"; exit 1; }
BT="$SDK/build-tools/$BUILD_TOOLS"
AJ="$SDK/platforms/$PLATFORM/android.jar"

for tool in "$BT/aapt2" "$BT/d8" "$BT/zipalign" "$BT/apksigner"; do
  [ -x "$tool" ] || { echo "Missing build tool: $tool"; exit 1; }
done
[ -f "$AJ" ] || { echo "Missing platform jar: $AJ"; exit 1; }

echo "[1/6] Compiling Kotlin..."
KOTLINC="$ROOT/.toolchain/kotlinc/bin/kotlinc"
if [ ! -x "$KOTLINC" ]; then
  echo "  downloading kotlin-compiler-$KT_VERSION..."
  mkdir -p "$ROOT/.toolchain"
  curl -fsSL "https://github.com/JetBrains/kotlin/releases/download/v$KT_VERSION/kotlin-compiler-$KT_VERSION.zip" \
    -o "$ROOT/.toolchain/kotlin.zip"
  unzip -q "$ROOT/.toolchain/kotlin.zip" -d "$ROOT/.toolchain"
  rm -f "$ROOT/.toolchain/kotlin.zip"
fi
mkdir -p "$OUT/classes"
"$KOTLINC" -classpath "$AJ" -d "$OUT/classes" \
  "$SRC/java/com/ghostwire/app/MainActivity.kt" 2>&1 | grep -v '^warning:' || true

echo "[2/6] Dexing (d8)..."
mkdir -p "$OUT/dex"
if [ -x "$BT/d8.bat" ] && [[ "$(uname -s)" == MINGW* || "$(uname -s)" == CYGWIN* ]]; then
  (cd "$OUT/classes" && "$BT/d8.bat" --min-api 24 --lib "$AJ" --output "$OUT/dex" $(find . -name '*.class'))
else
  (cd "$OUT/classes" && "$BT/d8" --min-api 24 --lib "$AJ" --output "$OUT/dex" $(find . -name '*.class'))
fi

echo "[3/6] Packaging resources (aapt2)..."
mkdir -p "$OUT/res-compiled" "$OUT/stage"
"$BT/aapt2" compile --dir "$SRC/res" -o "$OUT/res.zip"
"$BT/aapt2" link -o "$OUT/stage/ghostwire-unsigned.apk" \
  -I "$AJ" --manifest "$SRC/AndroidManifest.xml" \
  -A "$SRC/assets" 2>/dev/null || \
"$BT/aapt2" link -o "$OUT/stage/ghostwire-unsigned.apk" \
  -I "$AJ" --manifest "$SRC/AndroidManifest.xml" \
  "$OUT/res.zip"
# Add resources compiled from res.zip
"$BT/aapt2" link -o "$OUT/stage/base.apk" \
  -I "$AJ" --manifest "$SRC/AndroidManifest.xml" "$OUT/res.zip"
cp "$OUT/stage/base.apk" "$OUT/stage/ghostwire-unsigned.apk"

echo "[4/6] Adding classes.dex..."
(cd "$OUT/dex" && zip -q -j "$OUT/stage/ghostwire-unsigned.apk" classes.dex)

echo "[5/6] Aligning..."
"$BT/zipalign" -f 4 "$OUT/stage/ghostwire-unsigned.apk" "$OUT/stage/ghostwire-aligned.apk"

echo "[6/6] Signing..."
if [ ! -f "$KEYSTORE" ]; then
  keytool -genkeypair -keystore "$KEYSTORE" -alias ghostwire \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass ghostwire -keypass ghostwire \
    -dname "CN=GhostWire, OU=GhostWire, O=GhostWire, L=Internet, C=FR"
fi
"$BT/apksigner" sign --ks "$KEYSTORE" --ks-pass pass:ghostwire \
  --key-pass pass:ghostwire --out "$ROOT/android/GhostWire.apk" \
  "$OUT/stage/ghostwire-aligned.apk"

echo "OK: $ROOT/android/GhostWire.apk"
