#!/usr/bin/env bash
# Builds web/chompfe.wasm from engine/src + engine/vendor.
# Needs Emscripten: either emcc on PATH, or EMSDK pointing at an emsdk checkout
# (default ~/emsdk).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"

if ! command -v em++ >/dev/null 2>&1; then
  EMSDK="${EMSDK:-$HOME/emsdk}"
  export PATH="$EMSDK/upstream/emscripten:$PATH"
fi

dsp="$here/vendor/DaisySP/Source"

em++ -O3 -std=c++17 -fno-exceptions -fno-rtti \
  -Wall -Wno-unused-variable -Wno-unused-private-field -Wno-unused-function \
  -I"$here/shim" \
  -I"$here/vendor/firmware" \
  -I"$here/vendor/libDaisy" \
  -I"$dsp" -I"$dsp/Control" -I"$dsp/Synthesis" -I"$dsp/Utility" \
  "$here/src/chompfe.cpp" \
  "$dsp/Control/adsr.cpp" \
  "$dsp/Synthesis/oscillator.cpp" \
  "$dsp/Utility/dcblock.cpp" \
  --no-entry -sSTANDALONE_WASM \
  -sINITIAL_MEMORY=16777216 -sALLOW_MEMORY_GROWTH=0 -sSTACK_SIZE=65536 \
  -sFILESYSTEM=0 \
  -o "$here/../web/chompfe.wasm"

ls -l "$here/../web/chompfe.wasm"
