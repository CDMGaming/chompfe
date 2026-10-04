#!/usr/bin/env bash
# Builds web/tape.wasm: the TAPE firmware's sampler/looper/FX engine from
# engine/vendor/tape (unmodified) + engine/shim-tape + engine/src/tape.cpp.
# Needs Emscripten (em++ on PATH, or $EMSDK / ~/emsdk).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"

if ! command -v em++ >/dev/null 2>&1; then
  EMSDK="${EMSDK:-$HOME/emsdk}"
  export PATH="$EMSDK/upstream/emscripten:$PATH"
fi

dsp="$here/vendor/DaisySP/Source"

# Stage vendor/tape (unmodified) and lay shim-tape/override/* on top, so the
# few portability overrides are explicit files and the vendored copy stays
# byte-identical. (Quoted includes resolve next to the including file first,
# so an -I path can't override a sibling header.)
gen="$here/build-tape-gen"
rm -rf "$gen"
cp -r "$here/vendor/tape" "$gen"
cp "$here/shim-tape/override/"* "$gen/"

em++ -O3 -std=c++17 -fno-exceptions -fno-rtti \
  -Wall -Wno-unused-variable -Wno-unused-private-field -Wno-unused-function \
  -Wno-unused-but-set-variable -Wno-tautological-constant-out-of-range-compare \
  -Wno-tautological-overlap-compare -Wno-reorder-ctor -Wno-missing-braces \
  -Wno-nonportable-include-path -Wno-unknown-attributes -Wno-vla-cxx-extension \
  -I"$here/shim-tape" \
  -I"$gen" \
  -I"$here/vendor/libDaisy" \
  -I"$here/vendor/coreJSON/source/include" \
  -I"$dsp" -I"$dsp/Control" -I"$dsp/Synthesis" -I"$dsp/Utility" \
  "$here/src/tape.cpp" \
  "$here/shim-tape/memfs.cpp" \
  "$gen/FileStreamingManager.cpp" \
  "$dsp/Control/adsr.cpp" \
  "$dsp/Synthesis/oscillator.cpp" \
  "$dsp/Utility/dcblock.cpp" \
  "$dsp/Filters/svf.cpp" \
  --no-entry -sSTANDALONE_WASM \
  -sINITIAL_MEMORY=134217728 -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=1073741824 \
  -sSTACK_SIZE=262144 -sFILESYSTEM=0 \
  -o "$here/../web/tape.wasm"

ls -l "$here/../web/tape.wasm"
