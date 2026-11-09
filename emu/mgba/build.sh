#!/bin/sh
# Rebuilds public/emu/mgba.{js,wasm}: mGBA 0.10.5 (MPL-2.0, https://github.com/mgba-emu/mgba) + shim.c, compiled with a
# pinned Emscripten in Docker. The output is committed (like binjgb), so this only runs when the emulator itself changes.
# Needs: curl, tar, docker (running).
set -e
cd "$(dirname "$0")"
MGBA=26b7884bc25a5933960f3cdcd98bac1ae14d42e2 # tag 0.10.5
IMAGE=emscripten/emsdk:6.0.12
if [ ! -d src ]; then
  mkdir src
  curl -fsSL "https://github.com/mgba-emu/mgba/archive/$MGBA.tar.gz" | tar -xz -C src --strip-components=1
fi
mkdir -p ../../public/emu
docker run --rm -v "$PWD:/w" -v "$PWD/../../public/emu:/out" -w /w "$IMAGE" sh -ec '
  emcmake cmake -S src -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_STATIC=ON -DBUILD_SHARED=OFF \
    -DDISABLE_DEPS=ON -DDISABLE_FRONTENDS=ON -DM_CORE_GB=OFF -DM_CORE_GBA=ON -DUSE_DEBUGGERS=OFF -DENABLE_SCRIPTING=OFF \
    -DBUILD_GL=OFF -DBUILD_GLES2=OFF -DBUILD_GLES3=OFF -DBUILD_LTO=OFF "-DCMAKE_C_FLAGS=-O3 -D_GNU_SOURCE" >/dev/null
  cmake --build build -j4 >/dev/null
  emcc -O3 shim.c build/libmgba.a -Isrc/include -Ibuild/include -o /out/mgba.js \
    -sMODULARIZE=1 -sEXPORT_NAME=Mgba -sENVIRONMENT=web,worker,node -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=67108864 \
    -sEXPORTED_RUNTIME_METHODS=HEAP8,HEAPU8 -sEXPORTED_FUNCTIONS=_malloc,_free
'
ls -l ../../public/emu/mgba.js ../../public/emu/mgba.wasm
