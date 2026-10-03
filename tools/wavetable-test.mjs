// Offline checks for wavetable import/export.   node tools/wavetable-test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseWav, classify, toTable, fromRecording, encodeSerumWav, wavToTable, FRAME_SIZE, FRAMES, TABLE_SIZE,
} from '../web/js/wavetable.js';
import { ChompfeEngine, P } from '../web/js/engine.js';
import { checker } from './fake-api.mjs';

const { check, done } = checker();
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ab = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

const frame = (t, f) => t.subarray(f * FRAME_SIZE, (f + 1) * FRAME_SIZE);
const peakOf = (t) => t.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
const dcOf = (fr) => fr.reduce((s, x) => s + x, 0) / fr.length;
// energy in harmonic h of a single-cycle frame
const harm = (fr, h) => {
  let re = 0, im = 0;
  for (let i = 0; i < fr.length; i++) { const w = (2 * Math.PI * h * i) / fr.length; re += fr[i] * Math.cos(w); im += fr[i] * Math.sin(w); }
  return Math.hypot(re, im) / fr.length;
};

// ---- factory file
const factory = ab(readFileSync(join(root, 'web/wavetables/wavetable01.wav')));
const fw = parseWav(factory);
const fc = classify(fw);
check(fc.kind === 'wavetable' && fc.frames === 33 && fw.clmFrameSize === 2048, 'factory file classifies as a 33-frame wavetable');

// ---- a pitched "recording": 220 Hz at 44.1 kHz morphing from saw-like to sine, slight vibrato
{
  const sr = 44100, secs = 2, n = sr * secs;
  const x = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n; // 0..1 across the file
    ph += (2 * Math.PI * 220 * (1 + 0.003 * Math.sin((2 * Math.PI * 5 * i) / sr))) / sr;
    let s = 0;
    for (let h = 1; h <= 12; h++) s += ((h === 1 ? 1 : 1 - t) * Math.sin(h * ph)) / h;
    x[i] = 0.3 * s + 0.05; // plus some DC
  }
  const wav = { samples: x, sampleRate: sr, channels: 1, clmFrameSize: 0 };
  check(classify(wav).kind === 'recording', 'a 2 s recording classifies as a recording');
  const r = fromRecording(x, sr, { mode: 'auto' });
  check(r.mode === 'pitched', `auto picks pitched for a steady note (confidence ${r.confidence.toFixed(2)})`);
  check(Math.abs(r.hz - 220) < 2, `detected pitch ${r.hz.toFixed(1)} Hz (expect 220)`);
  check(Math.abs(peakOf(r.table) - 0.9) < 1e-6, 'normalised to peak 0.9 like the factory tables');
  check(Math.abs(dcOf(frame(r.table, 0))) < 1e-6, 'DC removed');
  const f0 = frame(r.table, 0), f32 = frame(r.table, 32);
  // one cycle per frame: the fundamental dominates bin 1, nothing at bin 0.5 multiples
  const h1 = harm(f0, 1), h2 = harm(f0, 2), h3 = harm(f0, 3);
  check(Math.abs(h2 / h1 - 0.5) < 0.05 && Math.abs(h3 / h1 - 1 / 3) < 0.05 && harm(f0, 13) < 0.02 * h1,
    `each frame is exactly one cycle: harmonics 1 : ${(h2 / h1).toFixed(2)} : ${(h3 / h1).toFixed(2)} (saw = 1 : 0.5 : 0.33)`);
  check(harm(f0, 3) > 5 * harm(f32, 3), 'frame 1 is bright, frame 33 is near-sine: the table follows the sound over time');
  const seam = Math.abs(f0[0] - f0[FRAME_SIZE - 1]);
  check(seam < 0.05, `cycle loops cleanly (seam step ${seam.toFixed(4)})`);

  // the table plays at the keyboard pitch, not the recording's pitch
  const mod = new WebAssembly.Module(readFileSync(join(root, 'web/chompfe.wasm')));
  const e = new ChompfeEngine(mod, 48000);
  e.loadTable(0, r.table);
  e.setParam(P.FILTER_LFO_ON, 0);
  e.setParam(P.PITCH_LFO_ON, 0);
  e.setParam(P.FRAME, 16);
  e.noteOn(69, 100);
  const N = 48000, L = new Float32Array(N + 24000);
  for (let o = 0; o < L.length; o += 128) L.set(e.render(128)[0].subarray(0, Math.min(128, L.length - o)), o);
  let best = 0, bestF = 0;
  for (let f = 150; f <= 300; f++) {
    let re = 0, im = 0;
    for (let i = 0; i < N; i++) { const w = (2 * Math.PI * f * i) / 48000; re += L[24000 + i] * Math.cos(w); im += L[24000 + i] * Math.sin(w); }
    const m = Math.hypot(re, im);
    if (m > best) { best = m; bestF = f; }
  }
  check(bestF === 220, `imported table through the engine: MIDI 69 plays ${bestF} Hz (expect 220)`);

  // pitched mode on part of the file only
  const half = fromRecording(x, sr, { mode: 'pitched', start: 0.5, end: 1 });
  check(harm(frame(half.table, 0), 3) < harm(f0, 3), 'start/end choose which part of the recording is scanned');
}

// ---- unpitched: noise -> spectral
{
  const sr = 48000, n = sr;
  let seed = 0x9e3779b9;
  const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296 * 2 - 1; };
  const x = Float32Array.from({ length: n }, rnd);
  const r = fromRecording(x, sr, { mode: 'auto' });
  check(r.mode === 'spectral', `auto picks spectral for noise (confidence ${r.confidence.toFixed(2)})`);
  check(r.table.every(Number.isFinite) && Math.abs(peakOf(r.table) - 0.9) < 1e-6, 'spectral table is finite and normalised');
  let tooTight = false;
  try { fromRecording(x.subarray(0, 2000), sr); } catch { tooTight = true; }
  check(tooTight, 'refuses a stretch shorter than the analysis window, with a message');
}

// ---- wavetable files with other frame counts
{
  const k = 8, fsz = 1024;
  const x = new Float32Array(k * fsz);
  for (let f = 0; f < k; f++) for (let i = 0; i < fsz; i++) x[f * fsz + i] = Math.sin((2 * Math.PI * i) / fsz) * (f + 1) / k;
  const { table, sourceFrames } = toTable(x, fsz);
  check(sourceFrames === 8 && table.length === TABLE_SIZE, '8 frames of 1024 spread over 33 rows of 2048');
  check(Math.abs(peakOf(frame(table, 0)) - 1 / 8) < 1e-3 && Math.abs(peakOf(frame(table, 32)) - 1) < 1e-3, 'first/last rows match first/last source frames');
}

// ---- export round trip, factory byte layout
{
  const { table } = wavToTable(factory);
  const out = encodeSerumWav(table);
  const back = parseWav(out);
  check(classify(back).kind === 'wavetable' && back.clmFrameSize === 2048, 'exported file reads back as a 2048-frame wavetable');
  check(back.samples.every((s, i) => s === table[i]), 'export round trip is bit exact');
  const a = new Uint8Array(factory), b = new Uint8Array(out);
  const same = (o, len) => a.subarray(o, o + len).every((x, i) => x === b[o + i]);
  check(b.length === a.length && same(12, 44) && same(72, 8) && same(128, 8) && same(136, 64),
    'export uses the factory layout: JUNK/fmt/clm chunks, sample data at byte 136');
  const clm = String.fromCharCode(...b.subarray(80, 80 + 36));
  check(clm.startsWith('<!>2048') && !/chompi/i.test(clm), `clm label "${clm}" (own name, not the original's)`);
}

done();
