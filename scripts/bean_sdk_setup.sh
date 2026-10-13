#!/bin/sh
# Put the Anker 录音豆 Android SDK where app/build.gradle.kts looks for it (gitignored), so the build includes
# SoundcoreBeanLink. The toolkit ships the AAR already unpacked; this zips it back.
#   scripts/bean_sdk_setup.sh [path to the unpacked module_spplink-release-v* folder]
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SRC=${1:-$(ls -d "$ROOT"/【黑客松智能录音赛道】工具资料包/sdk/module_spplink-release-v* 2>/dev/null | grep -v '\.zip$' | tail -1)}
[ -f "$SRC/classes.jar" ] || { echo "找不到 SDK 目录（需要包含 classes.jar）：$SRC" >&2; exit 1; }
DEST="$ROOT/android/app/libs/soundcore"
mkdir -p "$DEST"
OUT="$DEST/$(basename "$SRC").aar"
rm -f "$OUT"
(cd "$SRC" && zip -qr "$OUT" AndroidManifest.xml classes.jar R.txt META-INF)
echo "已放好：$OUT"
