#!/bin/zsh
# Builds "Wi-Fi Spot Finder.app" and installs it into /Applications (or ~/Applications).
set -e
cd "$(dirname "$0")"
NAME="Wi-Fi Spot Finder"
BUILD="build"
APP="$BUILD/$NAME.app"
rm -rf "$BUILD"; mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

echo "Compiling…"
swiftc -O app/main.swift -o "$APP/Contents/MacOS/WiFiSpotFinder"
swiftc -O wifisampler.swift -o "$APP/Contents/Resources/wifisampler"
swiftc -O app/icon.swift -o "$BUILD/icon"

echo "Drawing icon…"
"$BUILD/icon" "$BUILD/AppIcon.iconset"
iconutil -c icns "$BUILD/AppIcon.iconset" -o "$APP/Contents/Resources/AppIcon.icns"
cp "$BUILD/AppIcon.iconset/icon_256x256.png" assets/logo.png

cp server.py index.html "$APP/Contents/Resources/"
cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>$NAME</string>
  <key>CFBundleDisplayName</key><string>$NAME</string>
  <key>CFBundleIdentifier</key><string>local.wifispotfinder</string>
  <key>CFBundleExecutable</key><string>WiFiSpotFinder</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
EOF
codesign --force --deep --sign - "$APP" >/dev/null 2>&1

DEST=/Applications
[ -w "$DEST" ] || { DEST="$HOME/Applications"; mkdir -p "$DEST"; }
rm -rf "$DEST/$NAME.app"
cp -R "$APP" "$DEST/"
touch "$DEST/$NAME.app"
echo "Installed: $DEST/$NAME.app"
