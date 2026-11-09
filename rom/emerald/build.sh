#!/bin/sh
# Reproducible Oakle Emerald ROM build: pinned pret/pokeemerald + pret/agbcc + Arm GNU binutils + patches/oakle-emerald.patch (if present).
# Edit the game in rom/emerald/src/, run rom/emerald/mkpatch.sh to refresh the tracked patch. ROMs never go into git.
# Needs: curl, make, a C compiler and libpng (brew install libpng; apt install libpng-dev), patch, rsync, tar with xz.
# BASELINE=1: build the unpatched game and print its sha1 (must equal the real Emerald, f3ae088181bf583e55daf962a92bb46f4f1d07b7).
set -e
cd "$(dirname "$0")"
SHA=731ad5bfd6e6f265508d0efcca0ba42f9dcf5881
AGBCC=da598c1d918402c42c0c0d7128ba14567f3175e9
ARM=13.3.rel1
TOOLS=../tools/arm-gnu-$ARM
if [ ! -x $TOOLS/bin/arm-none-eabi-as ]; then
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64)   ASSET=arm-gnu-toolchain-$ARM-darwin-arm64-arm-none-eabi.tar.xz; SUM=fb6921db95d345dc7e5e487dd43b745e3a5b4d5c0c7ca4f707347148760317b4 ;;
    Linux-x86_64)   ASSET=arm-gnu-toolchain-$ARM-x86_64-arm-none-eabi.tar.xz;       SUM=95c011cee430e64dd6087c75c800f04b9c49832cc1000127a92a97f9c8d83af4 ;;
    *) echo "no pinned Arm toolchain for $(uname -sm): install arm-none-eabi binutils yourself and put them in rom/tools/arm-gnu-$ARM/bin/" >&2; exit 1 ;;
  esac
  mkdir -p ../tools
  curl -fsSL "https://developer.arm.com/-/media/Files/downloads/gnu/$ARM/binrel/$ASSET" -o "../tools/$ASSET"
  echo "$SUM  ../tools/$ASSET" | shasum -a 256 -c - >/dev/null || { echo "Arm toolchain checksum mismatch" >&2; rm -f "../tools/$ASSET"; exit 1; }
  mkdir -p $TOOLS && tar -xJf "../tools/$ASSET" -C $TOOLS --strip-components=1
  rm "../tools/$ASSET"
fi
export PATH="$PWD/$TOOLS/bin:$PATH"
if [ ! -d pokeemerald-pristine ]; then
  curl -fsSL "https://github.com/pret/pokeemerald/archive/$SHA.tar.gz" | tar -xz
  mv "pokeemerald-$SHA" pokeemerald-pristine
fi
[ -z "$FETCH_ONLY" ] || { echo "fetched pokeemerald-pristine"; exit 0; } # CI: the day data only needs the decomp's constants
# agbcc, the compiler the original game was built with: built once, installed into the pristine tree's tools/agbcc
if [ ! -x pokeemerald-pristine/tools/agbcc/bin/agbcc ]; then
  rm -rf agbcc-src && mkdir agbcc-src
  curl -fsSL "https://github.com/pret/agbcc/archive/$AGBCC.tar.gz" | tar -xz -C agbcc-src --strip-components=1
  (cd agbcc-src && sh build.sh >/dev/null && sh install.sh ../pokeemerald-pristine >/dev/null)
  rm -rf agbcc-src
fi
if [ -n "$BASELINE" ]; then
  rm -rf baseline && cp -R pokeemerald-pristine baseline
  make -C baseline -j8 pokeemerald.gba
  echo "baseline sha1 $(shasum baseline/pokeemerald.gba | cut -d' ' -f1)"
  exit 0
fi
if [ ! -d src ]; then
  cp -R pokeemerald-pristine src
  [ ! -f patches/oakle-emerald.patch ] || patch -s -d src -p1 < patches/oakle-emerald.patch
fi
[ ! -d assets ] || cp -R assets/. src/ # binary art kept beside the patch (assets/<path inside the decomp>), not in it
mkdir -p work && rsync -a --exclude=.git src/ work/
# Birch has no battle picture in any Gen 3 game: his intro-speech portrait (same 64x64 4bpp format) takes the unused Leaf trainer slot
cp work/graphics/birch_speech/birch.png work/graphics/trainers/front_pics/leaf.png
make -C work -j8 pokeemerald.gba
mkdir -p ../../public/rom
cp work/pokeemerald.gba ../../public/rom/emerald.gba
echo "built public/rom/emerald.gba, sha1 $(shasum work/pokeemerald.gba | cut -d' ' -f1)"
# OakleConfig file offset (ROM address - 0x08000000) for the page to patch; only once the patch adds it
line=$(grep -E ' OakleConfig$' work/pokeemerald.map | head -1 || true)
if [ -n "$line" ]; then
  addr=$(echo "$line" | grep -o '0x[0-9a-fA-F]\{8,16\}' | head -1)
  echo "{\"config\":$(( addr - 0x08000000 ))}" > ../../public/rom/emerald.json
  echo "config offset $(cat ../../public/rom/emerald.json)"
fi
