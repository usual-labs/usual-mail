#!/bin/sh
# Makes the iPhone app's icon, the tree on its hill, from the app's wallpaper (3840 x 2160), as the website's icons
# are made (site/scripts/layers.sh), with ImageMagick 7: a 720-pixel square around the tree, at 1024, no alpha.
# Check the result by eye. Usage: scripts/make-app-icon.sh
set -eu
cd "$(dirname "$0")/.."
magick Packages/UsualMailUI/Sources/UsualMailUI/Resources/Assets.xcassets/wallpaper.imageset/wallpaper.jpg \
    -crop 720x720+1575+330 +repage -filter Lanczos -resize 1024x1024 -strip -depth 8 \
    PNG24:AppPhone/Assets.xcassets/AppIcon.appiconset/icon-1024.png
