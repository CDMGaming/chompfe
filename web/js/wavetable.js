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

// ---------------------------------------------------------------------------
// Importing your own sounds
// ---------------------------------------------------------------------------

/** Guess what a parsed WAV is: a wavetable (frames back to back) or a
 *  recording that needs converting. */
export function classify(wav) {
  const n = wav.samples.length;
  const seconds = n / wav.sampleRate;
  if (wav.clmFrameSize) return { kind: 'wavetable', frameSize: wav.clmFrameSize, frames: Math.floor(n / wav.clmFrameSize), seconds };
  if (n === TABLE_SIZE) return { kind: 'wavetable', frameSize: FRAME_SIZE, frames: FRAMES, seconds };
  if (n % FRAME_SIZE === 0 && n / FRAME_SIZE <= 256) return { kind: 'wavetable', frameSize: FRAME_SIZE, frames: n / FRAME_SIZE, seconds };
  return { kind: 'recording', seconds };
}

/** The factory tables have no DC and peak at exactly 0.9; match that so
 *  imported tables sit at the same level. Works in place. */
export function normalizeTable(table, peak = 0.9) {
  let max = 0;
  for (let f = 0; f < FRAMES; f++) {
    const o = f * FRAME_SIZE;
    let dc = 0;
    for (let i = 0; i < FRAME_SIZE; i++) dc += table[o + i];
    dc /= FRAME_SIZE;
    for (let i = 0; i < FRAME_SIZE; i++) {
      table[o + i] -= dc;
      max = Math.max(max, Math.abs(table[o + i]));
    }
  }
  if (max > 1e-9) for (let i = 0; i < table.length; i++) table[i] *= peak / max;
  return table;
}

// Normalised autocorrelation at one lag over [a, a+w)
function nac(x, a, w, lag) {
  let s = 0;
  let e0 = 0;
  let e1 = 0;
  for (let i = 0; i < w; i++) {
    const p = x[a + i];
    const q = x[a + i + lag];
    s += p * q;
    e0 += p * p;
    e1 += q * q;
  }
  return s / Math.sqrt(e0 * e1 + 1e-20);
}

/** Period (in samples, fractional) of the sound around `center`.
 *  Searches lags [lo, hi]; takes the first strong peak so it does not lock
 *  onto a multiple of the period. Returns { period, confidence } (0..1). */
export function detectPeriod(x, center, lo, hi) {
  const w = Math.min(2 * hi, 4096);
  const a = Math.max(0, Math.min(x.length - w - hi - 2, Math.round(center - w / 2)));
  if (x.length < w + hi + 2) return { period: 0, confidence: 0 };
  const c = new Float64Array(hi + 2);
  let best = 0;
  for (let lag = lo; lag <= hi + 1; lag++) {
    c[lag] = nac(x, a, w, lag);
    best = Math.max(best, c[lag]);
  }
  for (let lag = lo + 1; lag <= hi; lag++) {
    if (c[lag] >= 0.9 * best && c[lag] >= c[lag - 1] && c[lag] >= c[lag + 1]) {
      const d = c[lag - 1] - 2 * c[lag] + c[lag + 1]; // parabolic refinement
      const off = d < 0 ? (0.5 * (c[lag - 1] - c[lag + 1])) / d : 0;
      return { period: lag + off, confidence: Math.max(0, c[lag]) };
    }
  }
  return { period: 0, confidence: 0 };
}

const median = (a) => {
  const s = [...a].sort((p, q) => p - q);
  return s[Math.floor(s.length / 2)];
};

// In-place radix-2 complex FFT (inverse when inv is true; unscaled).
function fft(re, im, inv) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inv ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len / 2;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const br = re[i + k + half] * cr - im[i + k + half] * ci;
        const bi = re[i + k + half] * ci + im[i + k + half] * cr;
        re[i + k + half] = re[i + k] - br;
        im[i + k + half] = im[i + k] - bi;
        re[i + k] += br;
        im[i + k] += bi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

/**
 * Turn a recording into a 33-frame table, scanning from `start` to `end`
 * (fractions of the file). Two ways:
 *  - 'pitched': each frame is one real cycle of the sound, cut at the detected
 *    pitch and stretched to 2048 samples. Best for notes: voice, instruments,
 *    synths. Scanning the frames moves through how the note changes.
 *  - 'spectral': each frame is rebuilt from the spectrum of a short window
 *    (the first 255 partials). Works on anything, noise and drums included,
 *    and gives breathy, textural tables.
 * 'auto' picks pitched when a steady pitch is found.
 * Returns { table, mode, hz, confidence }.
 */
export function fromRecording(samples, sampleRate, { mode = 'auto', start = 0, end = 1 } = {}) {
  const n = samples.length;
  const a = Math.floor(Math.min(start, end) * n);
  const b = Math.floor(Math.max(start, end) * n);
  if (b - a < 4096) throw new Error('Pick a longer stretch of the recording (at least about 0.1 s).');
  const centers = Array.from({ length: FRAMES }, (_, f) => a + ((f + 0.5) / FRAMES) * (b - a));
  const lo = Math.max(2, Math.floor(sampleRate / 1200));
  const hi = Math.min(Math.floor(sampleRate / 45), 2000);

  // pitch survey at 9 points across the stretch
  const survey = [0, 4, 8, 12, 16, 20, 24, 28, 32].map((f) => detectPeriod(samples, centers[f], lo, hi));
  const good = survey.filter((s) => s.confidence > 0.75 && s.period > 0);
  const confidence = good.length / survey.length;
  const P = good.length ? median(good.map((s) => s.period)) : 0;
  if (mode === 'auto') mode = confidence >= 0.6 ? 'pitched' : 'spectral';

  const table = new Float32Array(TABLE_SIZE);
  const at = (i) => (i >= 0 && i < n ? samples[i] : 0);
  if (mode === 'pitched') {
    if (!P) throw new Error('No steady pitch found here. Try spectral, or a stretch with one held note.');
    const plo = Math.max(lo, Math.floor(P * 0.85));
    const phi = Math.min(hi, Math.ceil(P * 1.15));
    for (let f = 0; f < FRAMES; f++) {
      const est = detectPeriod(samples, centers[f], plo, phi);
      const per = est.confidence > 0.5 ? est.period : P;
      // start the cycle at an upward zero crossing near the centre
      let s0 = Math.max(1, Math.min(n - per - 2, Math.round(centers[f] - per / 2)));
      for (let k = 0; k < per; k++) {
        const i = s0 + k;
        if (at(i) <= 0 && at(i + 1) > 0) {
          s0 = i + at(i) / (at(i) - at(i + 1));
          break;
        }
      }
      for (let i = 0; i < FRAME_SIZE; i++) {
        const x = s0 + (i * per) / FRAME_SIZE;
        const i0 = Math.floor(x);
        const t = x - i0;
        table[f * FRAME_SIZE + i] = at(i0) + (at(i0 + 1) - at(i0)) * t;
      }
    }
  } else {
    const W = 4096;
    const H = 255;
    const hann = Float64Array.from({ length: W }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / W));
    for (let f = 0; f < FRAMES; f++) {
      const re = new Float64Array(W);
      const im = new Float64Array(W);
      const s = Math.max(0, Math.min(n - W, Math.round(centers[f] - W / 2)));
      for (let i = 0; i < W; i++) re[i] = at(s + i) * hann[i];
      fft(re, im, false);
      const cr = new Float64Array(FRAME_SIZE);
      const ci = new Float64Array(FRAME_SIZE);
      for (let h = 1; h <= H; h++) {
        cr[h] = re[h];
        ci[h] = im[h];
        cr[FRAME_SIZE - h] = re[h];
        ci[FRAME_SIZE - h] = -im[h];
      }
      fft(cr, ci, true);
      for (let i = 0; i < FRAME_SIZE; i++) table[f * FRAME_SIZE + i] = cr[i];
    }
  }
  normalizeTable(table);
  return { table, mode, hz: P ? sampleRate / P : 0, confidence };
}

/** A table as a Serum-style WAV, laid out byte for byte like the factory
 *  files (JUNK, fmt, clm, then data at offset 136), so hardware that reads
 *  raw from byte 136 can use it too. */
export function encodeSerumWav(table, sampleRate = 44100) {
  const dataBytes = table.length * 4;
  const buf = new ArrayBuffer(136 + dataBytes);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF');
  v.setUint32(4, buf.byteLength - 8, true);
  str(8, 'WAVE');
  str(12, 'JUNK');
  v.setUint32(16, 28, true); // 28 zero bytes follow
  str(48, 'fmt ');
  v.setUint32(52, 16, true);
  v.setUint16(56, 3, true); // IEEE float
  v.setUint16(58, 1, true); // mono
  v.setUint32(60, sampleRate, true);
  v.setUint32(64, sampleRate * 4, true);
  v.setUint16(68, 4, true);
  v.setUint16(70, 32, true);
  str(72, 'clm ');
  v.setUint32(76, 48, true);
  str(80, '<!>2048 11000000 wavetable (Chompfe)'); // remaining clm bytes stay 0
  str(128, 'data');
  v.setUint32(132, dataBytes, true);
  for (let i = 0; i < table.length; i++) v.setFloat32(136 + i * 4, table[i], true);
  return buf;
}
