#!/bin/sh
# Refresh the tracked patch from the edit tree (rom/src vs the pinned pristine source).
cd "$(dirname "$0")"
diff -ruN pokeyellow-pristine src > patches/oakle.patch || true
wc -l patches/oakle.patch
