#!/bin/sh
# Reproducible Oakle ROM build: pinned pret/pokeyellow + rgbds 1.0.3 + patches/oakle.patch.
# Edit the game in rom/src/, run rom/mkpatch.sh to refresh the tracked patch. ROMs never go into git.
# Needs: curl, make, a C compiler (for the ROM tools), patch, rsync, unzip (macOS) or xz (Linux x86_64).
set -e
cd "$(dirname "$0")"
SHA=e89ead154b9968aa50eed9328ff2b38b6c194382
RGBDS=1.0.3
if [ ! -x tools/rgbds-$RGBDS/rgbasm ]; then
  case "$(uname -s)-$(uname -m)" in
    Darwin-*)       ASSET=rgbds-macos.zip;           SUM=dc1804b187895c4e1b730ba9d4b476052979607e613113b72dc7a494f88c898e ;;
    Linux-x86_64)   ASSET=rgbds-linux-x86_64.tar.xz; SUM=280a52061a0c516999bee75ac357628d6d50784309e0486cef25f7460e6f330b ;;
    *) echo "no prebuilt rgbds $RGBDS for $(uname -sm): build it from source and put it in rom/tools/rgbds-$RGBDS/" >&2; exit 1 ;;
  esac
  mkdir -p tools/rgbds-$RGBDS
  curl -fsSL "https://github.com/gbdev/rgbds/releases/download/v$RGBDS/$ASSET" -o "tools/$ASSET"
  echo "$SUM  tools/$ASSET" | shasum -a 256 -c - >/dev/null || { echo "rgbds checksum mismatch" >&2; rm -f "tools/$ASSET"; exit 1; }
  case $ASSET in *.zip) unzip -q "tools/$ASSET" -d tools/rgbds-$RGBDS ;; *) tar -xJf "tools/$ASSET" -C tools/rgbds-$RGBDS ;; esac
  rm "tools/$ASSET"
fi
if [ ! -d pokeyellow-pristine ]; then
  curl -fsSL "https://github.com/pret/pokeyellow/archive/$SHA.tar.gz" | tar -xz
  mv "pokeyellow-$SHA" pokeyellow-pristine
fi
if [ ! -d src ]; then
  cp -R pokeyellow-pristine src
  patch -s -d src -p1 < patches/oakle.patch
fi
mkdir -p work && rsync -a src/ work/
make -C work -j8 yellow RGBDS="$PWD/tools/rgbds-$RGBDS/"
mkdir -p ../public/rom
cp work/pokeyellow.gbc ../public/rom/oakle.gbc
# OakleConfig file offset (ROMX bank N, address A -> N*0x4000 + A - 0x4000) for the page to patch
line=$(grep ' OakleConfig$' work/pokeyellow.sym)
bank=${line%%:*}; addr=${line#*:}; addr=${addr%% *}
echo "{\"config\":$(( 0x$bank * 16384 + 0x$addr - 16384 ))}" > ../public/rom/oakle.json
echo "built public/rom/oakle.gbc, config offset $(cat ../public/rom/oakle.json)"
