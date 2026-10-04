"""Converts the TAPE factory samples (16-bit 48 kHz stereo WAV) to lossless
FLAC for the web, and checks each one decodes back to the identical samples.

    python tools/make-tape-samples.py [path-to-card-profiles/tape-2.0]

Writes web/samples/tape/<name>.flac and web/samples/tape/index.json.
Only the single-speed files are converted; the engine's own FileCopier makes
the *_double.wav files at load time, as the hardware does at boot.
Needs: pip install soundfile numpy
"""
import glob
import json
import os
import sys

import numpy as np
import soundfile as sf

here = os.path.dirname(os.path.abspath(__file__))
src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, '..', 'upstream', 'firmware', 'card-profiles', 'tape-2.0')
out = os.path.join(here, '..', 'web', 'samples', 'tape')
os.makedirs(out, exist_ok=True)

index = {}
total_in = total_out = 0
for path in sorted(glob.glob(os.path.join(src, '*.wav'))):
    name = os.path.basename(path)
    if '_double' in name:
        continue
    data, sr = sf.read(path, dtype='int16', always_2d=True)
    assert sr == 48000 and data.shape[1] == 2, (name, sr, data.shape)
    dest = os.path.join(out, name[:-4] + '.flac')
    sf.write(dest, data, sr, format='FLAC', subtype='PCM_16')
    back, _ = sf.read(dest, dtype='int16', always_2d=True)
    assert np.array_equal(back, data), f'{name}: FLAC round trip differs'
    total_in += os.path.getsize(path)
    total_out += os.path.getsize(dest)
    # FNV-1a over the interleaved int16 samples, so the browser can check its
    # FLAC decode is bit-exact
    flat = data.reshape(-1).astype(np.int16).view(np.uint16).astype(np.uint32)
    hv = 2166136261
    for v in flat[::97].tolist():  # every 97th sample keeps it quick
        hv = ((hv ^ v) * 16777619) & 0xFFFFFFFF
    index[name[:-4]] = {'frames': int(data.shape[0]), 'bytes': os.path.getsize(dest), 'fnv97': hv}

with open(os.path.join(out, 'index.json'), 'w') as f:
    json.dump(index, f, indent=0, sort_keys=True)
print(f'{len(index)} samples, {total_in / 1e6:.1f} MB WAV -> {total_out / 1e6:.1f} MB FLAC, all bit-exact')
