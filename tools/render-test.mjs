// Offline smoke test: loads the factory tables into chompfe.wasm, plays notes,
// writes test-out/*.wav and prints level + pitch checks. No browser needed.
//   node tools/render-test.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ChompfeEngine, P } from '../web/js/engine.js';
import { wavToTable } from '../web/js/wavetable.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SR = 48000;
const mod = new WebAssembly.Module(readFileSync(join(root, 'web/chompfe.wasm')));

function newEngine() {
  const e = new ChompfeEngine(mod, SR);
  for (let s = 0; s < 7; s++) {
    const buf = readFileSync(join(root, `web/wavetables/wavetable0${s + 1}.wav`));
    const { table } = wavToTable(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    e.loadTable(s, table);
  }
  return e;
}

function render(e, seconds, events = []) {
  const n = Math.round(seconds * SR);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let off = 0; off < n; off += 128) {
    for (const ev of events) if (ev.at >= off / SR && ev.at < (off + 128) / SR && !ev.done) { ev.fn(e); ev.done = true; }
    const k = Math.min(128, n - off);
    const [l, r] = e.render(k);
    L.set(l.subarray(0, k), off);
    R.set(r.subarray(0, k), off);
  }
  return [L, R];
}

function writeWav(path, L, R) {
  const n = L.length;
  const b = Buffer.alloc(44 + n * 8);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 8, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(3, 20); b.writeUInt16LE(2, 22);
  b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 8, 28); b.writeUInt16LE(8, 32); b.writeUInt16LE(32, 34);
  b.write('data', 36); b.writeUInt32LE(n * 8, 40);
  for (let i = 0; i < n; i++) { b.writeFloatLE(L[i], 44 + i * 8); b.writeFloatLE(R[i], 48 + i * 8); }
  writeFileSync(path, b);
}

const stats = (x, a = 0, b = x.length) => {
  a = Math.floor(a); b = Math.floor(b);
  let pk = 0, ss = 0, nan = 0;
  for (let i = a; i < b; i++) { const v = x[i]; if (!Number.isFinite(v)) nan++; pk = Math.max(pk, Math.abs(v)); ss += v * v; }
  return { peak: pk, rms: Math.sqrt(ss / (b - a)), nan };
};

// Fundamental estimate: strongest DFT bin between 50 and 500 Hz (1 Hz steps)
// over a 1 s window. Slow but unambiguous.
function pitch(x, a) {
  const N = SR;
  let best = 0, bestF = 0;
  for (let f = 50; f <= 500; f++) {
    let re = 0, im = 0;
    const w = (2 * Math.PI * f) / SR;
    for (let i = 0; i < N; i++) { re += x[a + i] * Math.cos(w * i); im += x[a + i] * Math.sin(w * i); }
    const m = Math.hypot(re, im);
    if (m > best) { best = m; bestF = f; }
  }
  return bestF;
}

mkdirSync(join(root, 'test-out'), { recursive: true });
let fail = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fail++; };

// 1. single note per table, filter LFO off so pitch detection is clean
for (let s = 0; s < 7; s++) {
  const e = newEngine();
  e.setParam(P.TABLE, s);
  e.setParam(P.FILTER_LFO_ON, 0);
  e.setParam(P.PITCH_LFO_ON, 0);
  const [L, R] = render(e, 3.5, [
    { at: 0.05, fn: (e) => e.noteOn(69, 100) },
    { at: 2.0, fn: (e) => e.noteOff(69) },
  ]);
  const held = stats(L, 0.3 * SR, 1.9 * SR);
  const tail = stats(L, 3.4 * SR, 3.5 * SR);
  const f = pitch(L, Math.floor(0.5 * SR));
  writeWav(join(root, `test-out/table${s + 1}_a.wav`), L, R);
  check(held.nan === 0 && held.peak > 0.002 && held.peak < 1.01, `table ${s + 1}: sounding, peak ${held.peak.toFixed(3)} rms ${held.rms.toFixed(4)}`);
  // MIDI 69 -> nn 9 -> 440 * 2^((9+36-57)/12) = 220 Hz (the firmware plays an octave below concert)
  check(Math.abs(f - 220) / 220 < 0.02, `table ${s + 1}: pitch ~${f.toFixed(1)} Hz (expect 220 Hz fundamental)`);
  check(tail.peak < held.peak * 0.05, `table ${s + 1}: released, tail peak ${tail.peak.toExponential(2)}`);
}

// 2. chord + FX + frame scan
{
  const e = newEngine();
  e.setParam(P.FX, 0.85);      // reverb side
  e.setParam(P.CUTOFF, 0.35);  // low-pass
  e.setParam(P.FILTER_LFO_DEPTH, 0.3);
  const ev = [60, 64, 67, 71].map((n) => ({ at: 0.05, fn: (e) => e.noteOn(n, 110) }));
  for (let i = 0; i < 32; i++) ev.push({ at: 0.1 + i * 0.05, fn: (e) => e.setParam(P.FRAME, i) });
  [60, 64, 67, 71].forEach((n) => ev.push({ at: 2.0, fn: (e) => e.noteOff(n) }));
  const [L, R] = render(e, 4, ev);
  const s = stats(L);
  writeWav(join(root, 'test-out/chord_reverb_scan.wav'), L, R);
  check(s.nan === 0 && s.peak > 0.01 && s.peak <= 1.0, `chord + reverb + frame scan: peak ${s.peak.toFixed(3)}`);
  check(stats(L, 2.3 * SR, 2.6 * SR).rms > 1e-4, 'reverb tail present after release');
}

// 3. sequencer: 4 steps, one rest
{
  const e = newEngine();
  [48, 55, -1, 60].forEach((n, i) => e.seqSetStep(i, n));
  e.seqSetLength(4);
  e.setParam(P.TEMPO, 320); // 187.5 ms per step at the default division
  e.seqPlay(true);
  const [L, R] = render(e, 2);
  writeWav(join(root, 'test-out/sequencer.wav'), L, R);
  const midi = e.drainMidiOut();
  const ons = midi.filter((m) => (m[0] & 0xf0) === 0x90);
  check(ons.length >= 7 && ons.length <= 9, `sequencer: ${ons.length} note-ons in 2 s (expect ~8: 3 notes/4 steps @187.5ms)`);
  check(stats(L).peak > 0.01, 'sequencer audible');
}

// 4. record a loop the hardware way: tap LOOP, play keys (steps land on
//    release), rest key, tap LOOP, PLAY. Then hold LOOP to delete the last step.
{
  const e = newEngine();
  const ev = [];
  const at = (t, fn) => ev.push({ at: t, fn });
  at(0.00, (e) => e.loopButton(true));
  at(0.05, (e) => e.loopButton(false));          // release arms recording
  at(0.10, (e) => e.noteOn(60, 100)); at(0.20, (e) => e.noteOff(60));
  at(0.25, (e) => e.noteOn(64, 100)); at(0.35, (e) => e.noteOff(64));
  at(0.40, (e) => e.restButton(true)); at(0.45, (e) => e.restButton(false));
  at(0.50, (e) => e.noteOn(67, 100)); at(0.60, (e) => e.noteOff(67));
  at(0.70, (e) => e.loopButton(true)); at(0.75, (e) => e.loopButton(false)); // disarm
  render(e, 0.8, ev);
  let st = e.state();
  check(!st.seqRecording, 'record: LOOP tap disarms');
  check(st.seqLength === 4 && st.steps.slice(0, 4).join() === '60,64,-1,67',
    `record: steps ${st.steps.slice(0, st.seqLength).join(',')} (expect 60,64,-1,67)`);

  e.drainMidiOut();
  e.playButton(true); e.playButton(false);
  render(e, 1.5); // 8 steps at 187.5 ms
  const ons = e.drainMidiOut().filter((m) => (m[0] & 0xf0) === 0x90).map((m) => m[1]);
  check(ons.slice(0, 6).join() === '60,64,67,60,64,67', `playback order ${ons.join(',')}`);

  // hold LOOP > 1.25 s: deletes the last step, and the release must not re-arm
  const ev2 = [{ at: 0, fn: (e) => e.loopButton(true) }, { at: 1.5, fn: (e) => e.loopButton(false) }];
  render(e, 1.6, ev2);
  st = e.state();
  check(st.seqLength === 3 && !st.seqRecording, `hold LOOP deletes last step (len ${st.seqLength}, rec ${st.seqRecording})`);

  // hold PLAY + LOOP > 1.25 s: clears everything
  const ev3 = [
    { at: 0, fn: (e) => { e.playButton(true); e.loopButton(true); } },
    { at: 1.5, fn: (e) => { e.playButton(false); e.loopButton(false); } },
  ];
  render(e, 1.6, ev3);
  st = e.state();
  check(st.seqLength === 0 && !st.seqPlaying, `hold PLAY+LOOP clears (len ${st.seqLength}, playing ${st.seqPlaying})`);
}

// 5. recording while the loop plays overdubs at the playhead (rounded to the
//    nearest step) instead of appending; stopped, it still appends.
{
  const e = newEngine();
  [60, -1, -1, -1].forEach((n, i) => e.seqSetStep(i, n));
  e.seqSetLength(4);
  e.setParam(P.TEMPO, 320); // 187.5 ms steps; step k starts at ~k*187.5 ms
  e.seqRecord(true);
  e.seqPlay(true);
  render(e, 1.4, [
    { at: 0.20, fn: (e) => e.noteOn(67, 100) },  // early in step 2 -> step 2
    { at: 0.30, fn: (e) => e.noteOff(67) },
    { at: 0.53, fn: (e) => e.noteOn(64, 100) },  // late in step 3 (0.375..0.5625) -> step 4
    { at: 0.62, fn: (e) => e.noteOff(64) },
    { at: 0.77, fn: (e) => e.restButton(true) }, // early in step 1 of loop 2 -> rest there
    { at: 0.80, fn: (e) => e.restButton(false) },
  ]);
  const st = e.state();
  check(st.seqLength === 4, `live overdub keeps the loop length (${st.seqLength})`);
  check(st.steps.slice(0, 4).join() === '-1,67,-1,64', `live overdub: steps ${st.steps.slice(0, 4).join(',')} (expect -1,67,-1,64)`);
  e.drainMidiOut();
  render(e, 0.75);
  const ons = e.drainMidiOut().filter((m) => (m[0] & 0xf0) === 0x90).map((m) => m[1]);
  check(ons.includes(67) && ons.includes(64) && !ons.includes(60), `the next loop plays the overdubbed notes (${ons.join(',')})`);

  e.seqPlay(false);
  render(e, 0.05, [{ at: 0, fn: (e) => { e.noteOn(72, 100); } }, { at: 0.02, fn: (e) => e.noteOff(72) }]);
  check(e.state().seqLength === 5 && e.state().steps[4] === 72, 'stopped + recording still appends, like the hardware');
}

console.log(fail ? `\n${fail} check(s) failed` : '\nall checks passed');
process.exit(fail ? 1 : 0);
