#!/bin/sh
# Refresh the tracked patch from the edit tree (rom/emerald/src vs the pinned pristine source).
cd "$(dirname "$0")"
mkdir -p patches
diff -ruN pokeemerald-pristine src > patches/oakle-emerald.patch || true
wc -l patches/oakle-emerald.patch
