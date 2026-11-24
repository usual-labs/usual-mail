#!/bin/zsh
# Makes the site's wallpaper layers and icons in public/ from the Mac app's wallpaper (3840 x 2160), with ImageMagick 7
# (AVIF through libheif) and cwebp. The hills and tree are cut out by colour (green minus blue), holes inside them
# filled; the sky layer is the wallpaper with the hills and a generous blob around the tree filled from the sky around
# them, so the sky can drift behind the hills without a ghost of either. Run from site/: zsh scripts/layers.sh
set -euo pipefail

src=../apps/Packages/UsualMailUI/Sources/UsualMailUI/Resources/Assets.xcassets/wallpaper.imageset/wallpaper.jpg
out=public/img
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$work"
cp "$OLDPWD/$src" src.jpg

# Green minus blue: high on grass and leaves, at or below zero on sky and cloud.
magick src.jpg \( -clone 0 -channel G -separate +channel \) \( -clone 0 -channel B -separate +channel \) \
  -delete 0 -compose Minus_Src -composite key.png
# Hard mask: the hills and tree, with every hole not joined to the sky filled.
magick key.png -threshold 4% -fill red -draw "color 10,10 floodfill" -fill white +opaque red -fill black -opaque red hard.png
# The tree as one closed blob, and the area the sky layer fills: the hills grown by 6 px plus the blob.
magick hard.png -crop 640x640+1610+400 +repage -morphology Close Disk:40 -morphology Dilate Disk:24 blob-crop.png
magick hard.png -fill black -draw "rectangle 0,0 3839,2159" blob-crop.png -geometry +1610+400 -compose Over -composite blob.png
magick hard.png -morphology Dilate Disk:6 blob.png -compose Lighten -composite fill.png
# Hills layer: a soft key at the edges, solid inside.
magick key.png -level 1.5%,7% soft.png
magick hard.png -morphology Erode Disk:5 inside.png
magick soft.png inside.png -compose Lighten -composite \( hard.png -morphology Dilate Disk:3 \) -compose Darken -composite alpha.png
magick src.jpg alpha.png -alpha off -compose CopyOpacity -composite -background '#808080' -alpha background hills.png
# Sky layer: the filled area made transparent, then filled from coarse to fine (push-pull).
magick src.jpg \( fill.png -negate \) -alpha off -compose CopyOpacity -composite holes.png
levels=()
for size in 2x1 4x2 8x5 15x9 30x17 60x34 120x68 240x135 480x270 960x540 1920x1080; do
  levels+=( \( -clone 0 -resize "$size!" -resize 3840x2160! \) )
done
magick holes.png \( -clone 0 -resize 1x1! -alpha off -resize 3840x2160! \) "${levels[@]}" \( -clone 0 \) -delete 0 \
  -background none -compose Over -layers flatten -alpha off sky.png

# Landscape sizes, and a 3:4 crop centred on the tree for tall screens.
for w in 2560 1920 1280; do
  h=$((w * 9 / 16))
  magick sky.png -resize ${w}x${h}! -strip sky-$w.png
  magick hills.png -resize ${w}x${h}! -strip hills-$w.png
done
for layer in sky hills; do
  magick $layer.png -crop 1620x2160+1125+0 +repage -strip $layer-p1620.png
  magick $layer-p1620.png -resize 1080x1440! $layer-p1080.png
done
for n in 2560 1920 1280 p1620 p1080; do
  magick sky-$n.png -quality 60 -define heic:speed=3 "$OLDPWD/$out/sky-$n.avif"
  magick hills-$n.png -quality 50 -define heic:speed=3 "$OLDPWD/$out/hills-$n.avif"
  cwebp -quiet -q 78 -m 6 sky-$n.png -o "$OLDPWD/$out/sky-$n.webp"
  cwebp -quiet -q 70 -m 6 -alpha_q 90 hills-$n.png -o "$OLDPWD/$out/hills-$n.webp"
done

# Icons: the tree on its hill.
for size in 180 64; do
  name=$([ $size = 180 ] && echo apple-touch-icon || echo favicon)
  magick src.jpg -crop 560x560+1655+400 +repage -resize ${size}x${size} -strip -depth 8 \
    -define png:compression-level=9 PNG24:"$OLDPWD/public/$name.png"
done
