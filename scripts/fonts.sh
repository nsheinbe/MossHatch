#!/bin/sh
# Subset the two typefaces (both OFL) to Basic Latin plus the punctuation the copy uses. Needs fonttools + brotli.
set -e
U="U+0020-007E,U+00A0,U+00B7,U+2018,U+2019,U+201C,U+201D,U+2026,U+2013,U+2014"
out=apps/web/public/fonts
for f in young-serif-latin-400-normal atkinson-hyperlegible-latin-400-normal atkinson-hyperlegible-latin-700-normal; do
  src=$(ls node_modules/@fontsource/*/files/$f.woff2)
  pyftsubset "$src" --unicodes="$U" --flavor=woff2 --layout-features='kern,liga' --output-file="$out/$f.woff2"
done
