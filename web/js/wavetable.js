// WAV parsing and wavetable shaping. Pure functions, no DOM, so it also runs in
// Node (tools/render-test.mjs).
//
// The engine wants what the hardware read off the SD card: 33 frames x 2048
// float32 samples (the Serum layout). The firmware just read raw bytes from
// offset 136; here the RIFF chunks are parsed properly so other files work too.

export const FRAME_SIZE = 2048;
export const FRAMES = 33;
export const TABLE_SIZE = FRAME_SIZE * FRAMES;

/** Parse a RIFF/WAVE file into mono float samples. Supports PCM 8/16/24/32-bit
 *  and IEEE float 32/64, including WAVE_FORMAT_EXTENSIBLE. Multi-channel files
 *  are mixed to mono. Returns { sampleRate, channels, samples: Float32Array,
 *  clmFrameSize } where clmFrameSize is the frame size from a Serum 'clm '
 *  chunk if present. */
export function parseWav(arrayBuffer) {
  const v = new DataView(arrayBuffer);
  const tag = (o) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (arrayBuffer.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') {
    throw new Error('Not a WAV file');
  }
  let fmt = null;
  let dataOff = -1;
  let dataLen = 0;
  let clmFrameSize = 0;
  let pos = 12;
  while (pos + 8 <= v.byteLength) {
    const id = tag(pos);
    const size = v.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === 'fmt ') {
      let format = v.getUint16(body, true);
      const channels = v.getUint16(body + 2, true);
      const sampleRate = v.getUint32(body + 4, true);
      const bits = v.getUint16(body + 14, true);
      if (format === 0xfffe && size >= 26) format = v.getUint16(body + 24, true);
      fmt = { format, channels, sampleRate, bits };
    } else if (id === 'data') {
      dataOff = body;
      dataLen = Math.min(size, v.byteLength - body);
    } else if (id === 'clm ') {
      // Serum: "<!>2048 ..." - the number after <!> is the frame size
      let s = '';
      for (let i = 0; i < Math.min(size, 16); i++) s += String.fromCharCode(v.getUint8(body + i));
      const m = /<!>(\d+)/.exec(s);
      if (m) clmFrameSize = parseInt(m[1], 10);
    }
    pos = body + size + (size & 1);
  }
  if (!fmt) throw new Error('WAV has no fmt chunk');
  if (dataOff < 0) throw new Error('WAV has no data chunk');

  const { format, channels, bits, sampleRate } = fmt;
  const bytes = bits / 8;
  const frameBytes = bytes * channels;
  const n = Math.floor(dataLen / frameBytes);
  const out = new Float32Array(n);
  let read;
  if (format === 3 && bits === 32) read = (o) => v.getFloat32(o, true);
  else if (format === 3 && bits === 64) read = (o) => v.getFloat64(o, true);
  else if (format === 1 && bits === 8) read = (o) => (v.getUint8(o) - 128) / 128;
  else if (format === 1 && bits === 16) read = (o) => v.getInt16(o, true) / 32768;
  else if (format === 1 && bits === 24) read = (o) => {
    let x = v.getUint8(o) | (v.getUint8(o + 1) << 8) | (v.getUint8(o + 2) << 16);
    if (x & 0x800000) x -= 0x1000000;
    return x / 8388608;
  };
  else if (format === 1 && bits === 32) read = (o) => v.getInt32(o, true) / 2147483648;
  else throw new Error(`Unsupported WAV encoding (format ${format}, ${bits}-bit)`);

  for (let i = 0; i < n; i++) {
    let acc = 0;
    const base = dataOff + i * frameBytes;
    for (let c = 0; c < channels; c++) acc += read(base + c * bytes);
    out[i] = acc / channels;
  }
  return { sampleRate, channels, samples: out, clmFrameSize };
}

/** Shape mono samples into the engine's 33 x 2048 table.
 *  - Exactly 33 x 2048: copied as is (the factory/Serum case).
 *  - k whole frames of `frameSize` (from the Serum clm chunk, else 2048):
 *    each frame is resampled to 2048 and the 33 rows are spread across the k
 *    frames, crossfading between neighbours.
 *  Returns { table: Float32Array(TABLE_SIZE), sourceFrames }. */
export function toTable(samples, frameSize = FRAME_SIZE) {
  const table = new Float32Array(TABLE_SIZE);
  if (samples.length === TABLE_SIZE && frameSize === FRAME_SIZE) {
    table.set(samples);
    return { table, sourceFrames: FRAMES };
  }
  const fs = frameSize > 0 ? frameSize : FRAME_SIZE;
  const k = Math.floor(samples.length / fs);
  if (k < 1) throw new Error(`Too short for a wavetable: need at least ${fs} samples, got ${samples.length}`);

  const frame = (f, i) => {
    // sample i (0..2047) of source frame f, resampled from fs to 2048, cyclic
    const x = (i * fs) / FRAME_SIZE;
    const i0 = Math.floor(x);
    const t = x - i0;
    const a = samples[f * fs + (i0 % fs)];
    const b = samples[f * fs + ((i0 + 1) % fs)];
    return a + (b - a) * t;
  };
  for (let row = 0; row < FRAMES; row++) {
    const pos = k === 1 ? 0 : (row * (k - 1)) / (FRAMES - 1);
    const f0 = Math.floor(pos);
    const f1 = Math.min(f0 + 1, k - 1);
    const t = pos - f0;
    for (let i = 0; i < FRAME_SIZE; i++) {
      const a = frame(f0, i);
      table[row * FRAME_SIZE + i] = t === 0 ? a : a + (frame(f1, i) - a) * t;
    }
  }
  return { table, sourceFrames: k };
}

/** Convenience: WAV bytes -> engine table. */
export function wavToTable(arrayBuffer) {
  const w = parseWav(arrayBuffer);
  return { ...toTable(w.samples, w.clmFrameSize || FRAME_SIZE), wav: w };
}
