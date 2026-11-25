#!/bin/sh
# Makes both apps' icon, the tree on its hill, from the app's wallpaper (3840 x 2160), as the website's icons are made
# (site/scripts/layers.sh), with ImageMagick 7: a 720-pixel square around the tree, no alpha. The iPhone's is one
# 1024; the Mac's are the same square at each size its icon set lists, full-bleed, since macOS 26 gives every app
# icon its rounded shape. Check the result by eye. Usage: scripts/make-app-icon.sh
set -eu
cd "$(dirname "$0")/.."
wallpaper=Packages/UsualMailUI/Sources/UsualMailUI/Resources/Assets.xcassets/wallpaper.imageset/wallpaper.jpg
square() {
    magick "$wallpaper" -crop 720x720+1575+330 +repage -filter Lanczos -resize "$1x$1" -strip -depth 8 "PNG24:$2"
}
square 1024 AppPhone/Assets.xcassets/AppIcon.appiconset/icon-1024.png
for size in 16 32 64 128 256 512 1024; do
    square "$size" "App/Assets.xcassets/AppIcon.appiconset/icon-$size.png"
done
