#!/bin/sh
# Reproducible Oakle Crystal ROM build: pinned pret/pokecrystal + rgbds 1.0.4 + patches/oakle-crystal.patch (if present).
# Edit the game in rom/crystal/src/, run rom/crystal/mkpatch.sh to refresh the tracked patch. ROMs never go into git.
# Needs: curl, make, a C compiler (for the ROM tools), patch, rsync, unzip (macOS) or xz (Linux x86_64).
set -e
cd "$(dirname "$0")"
SHA=3c813b0b4d82b39bf62185aceffb76fd6026c70b
RGBDS=1.0.4
TOOLS=../tools/rgbds-$RGBDS
if [ ! -x $TOOLS/rgbasm ]; then
  case "$(uname -s)-$(uname -m)" in
    Darwin-*)       ASSET=rgbds-macos.zip;           SUM=62d1669bbe3b2bf2cfc2e72076d3c8c00fc023a9cc15d458f0c723bd9d0312c4 ;;
    Linux-x86_64)   ASSET=rgbds-linux-x86_64.tar.xz; SUM=3e19e50ea602e316be709160acaf0a708b1fa6d32d219ec541f244442895dbb7 ;;
    *) echo "no prebuilt rgbds $RGBDS for $(uname -sm): build it from source and put it in rom/tools/rgbds-$RGBDS/" >&2; exit 1 ;;
  esac
  mkdir -p $TOOLS
  curl -fsSL "https://github.com/gbdev/rgbds/releases/download/v$RGBDS/$ASSET" -o "../tools/$ASSET"
  echo "$SUM  ../tools/$ASSET" | shasum -a 256 -c - >/dev/null || { echo "rgbds checksum mismatch" >&2; rm -f "../tools/$ASSET"; exit 1; }
  case $ASSET in *.zip) unzip -q "../tools/$ASSET" -d $TOOLS ;; *) tar -xJf "../tools/$ASSET" -C $TOOLS ;; esac
  rm "../tools/$ASSET"
fi
if [ ! -d pokecrystal-pristine ]; then
  curl -fsSL "https://github.com/pret/pokecrystal/archive/$SHA.tar.gz" | tar -xz
  mv "pokecrystal-$SHA" pokecrystal-pristine
fi
if [ ! -d src ]; then
  cp -R pokecrystal-pristine src
  [ ! -f patches/oakle-crystal.patch ] || patch -s -d src -p1 < patches/oakle-crystal.patch
fi
cp assets/elm.png src/gfx/trainers/elm.png # binary art: kept beside the patch, not in it
mkdir -p work && rsync -a src/ work/
make -C work -j8 pokecrystal11.gbc RGBDS="$PWD/$TOOLS/"
mkdir -p ../../public/rom
cp work/pokecrystal11.gbc ../../public/rom/crystal.gbc
echo "built public/rom/crystal.gbc, sha1 $(shasum work/pokecrystal11.gbc | cut -d' ' -f1)"
# OakleConfig file offset (ROMX bank N, address A -> N*0x4000 + A - 0x4000) for the page to patch; only once the patch adds it
line=$(grep ' OakleConfig$' work/pokecrystal11.sym || true)
if [ -n "$line" ]; then
  bank=${line%%:*}; addr=${line#*:}; addr=${addr%% *}
  echo "{\"config\":$(( 0x$bank * 16384 + 0x$addr - 16384 ))}" > ../../public/rom/crystal.json
  echo "config offset $(cat ../../public/rom/crystal.json)"
fi
