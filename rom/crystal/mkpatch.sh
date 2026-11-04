#!/bin/sh
# Refresh the tracked patch from the edit tree (rom/crystal/src vs the pinned pristine source).
cd "$(dirname "$0")"
mkdir -p patches
diff -ruN -x elm.png pokecrystal-pristine src > patches/oakle-crystal.patch || true # elm.png is binary: assets/elm.png, copied in by build.sh
wc -l patches/oakle-crystal.patch
