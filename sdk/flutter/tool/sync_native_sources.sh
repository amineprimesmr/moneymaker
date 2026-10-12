#!/usr/bin/env bash
# Copies the MoneyMaker Swift SDK into the plugin's pod (CocoaPods cannot reference
# files outside the pod directory, and pub.dev packages must be self-contained).
# Run after any change in sdk/ios/Sources/MoneyMaker, and before `flutter pub publish`.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
src="$here/../ios/Sources/MoneyMaker"
dst="$here/ios/Classes/MoneyMakerCore"
rm -rf "$dst" && mkdir -p "$dst"
cp "$src"/*.swift "$dst/"
echo "Synced $(ls "$dst" | wc -l | tr -d ' ') files into $dst"
