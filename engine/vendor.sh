#!/usr/bin/env bash
# Copies the DSP sources Chompfe uses out of a checkout of the upstream
# firmware repo (MIT, (c) CHOMPI Club) into engine/vendor/, UNMODIFIED.
# Hardware/UI files (hardware.h, encoder.*, FileStreamingManager.*, pages, LEDs)
# are deliberately not copied: engine/shim/ replaces what the DSP needs from them.
#
#   engine/vendor.sh [path-to-upstream-checkout]   (default: ./upstream)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
up="${1:-$here/../upstream}"
fw="$up/firmware/chompi-wave"
src="$fw/code/src"
dsp="$fw/code/libs/DaisySP"
day="$fw/code/libs/libDaisy"
out="$here/vendor"

rm -rf "$out"
mkdir -p "$out/firmware" "$out/DaisySP" "$out/libDaisy/util" "$here/../web/wavetables"

for f in subtractiveEngine.h WavetableManager.h DJFilter.h BasicMMF.h reverb.h \
         fx_engine.h limiter.h InterpolatedDelayLine.h EnvFollower.h \
         Sequencer.h clockManager.h; do
  cp "$src/$f" "$out/firmware/$f"
done

# DaisySP: full header tree (daisysp.h includes all of it) + LICENSE.
# Only adsr/oscillator/dcblock .cpp are compiled (see build.sh).
cp -r "$dsp/Source" "$out/DaisySP/Source"
cp "$dsp/LICENSE" "$out/DaisySP/LICENSE"
find "$out/DaisySP/Source" -type f ! -name '*.h' ! -name '*.cpp' -delete

cp "$day/src/util/FIFO.h" "$out/libDaisy/util/FIFO.h"
cp "$day/LICENSE" "$out/libDaisy/LICENSE"

cp "$up/LICENSE" "$out/LICENSE.upstream"
cp "$up/THIRD_PARTY.md" "$out/THIRD_PARTY.upstream.md"

for i in 1 2 3 4 5 6 7; do
  cp "$fw/wavetables/wavetable0$i.wav" "$here/../web/wavetables/wavetable0$i.wav"
done

sha="$(git -C "$up" rev-parse HEAD 2>/dev/null || echo unknown)"
cat > "$out/UPSTREAM.txt" <<EOF
Source: https://github.com/CHOMPI-Club/CHOMPI (MIT, (c) 2026 CHOMPI Club)
Commit: $sha
Path:   firmware/chompi-wave
Files in firmware/ are byte-identical copies of firmware/chompi-wave/code/src.
DaisySP and libDaisy/util/FIFO.h come from firmware/chompi-wave/code/libs (MIT, Electrosmith).
EOF
echo "vendored from $sha"
