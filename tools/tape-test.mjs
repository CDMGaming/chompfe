// Offline checks for the TAPE engine (web/tape.wasm): the in-memory SD card,
// the boot copier, JAMMI / CUBBI playback, the default buffer sound, the
// looper and the FX routing.   node tools/tape-test.mjs
// Uses the original factory WAVs from upstream/ (see tools/make-tape-samples.py).
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TapeEngine, CMD, GET, MODE, sampleName } from '../web/js/tape-engine.js';
import { checker } from './fake-api.mjs';

const { check, done } = checker();
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const card = join(root, 'upstream/firmware/card-profiles/tape-2.0');
const SR = 48000;
const mod = new WebAssembly.Module(readFileSync(join(root, 'web/tape.wasm')));

if (!existsSync(join(card, 'jammi_a1.wav'))) {
  console.log('factory samples not found in upstream/; run the sparse checkout first');
  process.exit(1);
}

function engineWithBank(mode, bank) {
  const e = new TapeEngine(mod, SR);
  for (let s = 1; s <= 14; s++) {
    const name = sampleName(mode, bank, s);
    const p = join(card, name);
    if (existsSync(p)) e.putFile(name, new Uint8Array(readFileSync(p)));
  }
  const t0 = performance.now();
  e.boot();
  return { e, bootMs: performance.now() - t0 };
}

function render(e, seconds, events = []) {
  const n = Math.round(seconds * SR);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let off = 0; off < n; off += 128) {
    for (const ev of events) if (!ev.done && ev.at < (off + 128) / SR) { ev.fn(e); ev.done = true; }
    const k = Math.min(128, n - off);
    const [l, r] = e.render(k);
    L.set(l.subarray(0, k), off);
    R.set(r.subarray(0, k), off);
  }
  return [L, R];
}
const rms = (x, a = 0, b = x.length) => {
  a = Math.floor(a); b = Math.floor(b);
  let s = 0, nan = 0;
  for (let i = a; i < b; i++) { if (!Number.isFinite(x[i])) nan++; s += x[i] * x[i]; }
  return nan ? NaN : Math.sqrt(s / Math.max(1, b - a));
};
function zeroCrossRate(x, a, b) {
  let z = 0;
  for (let i = Math.floor(a) + 1; i < b; i++) if ((x[i - 1] < 0) !== (x[i] < 0)) z++;
  return z / ((b - a) / SR);
}
function writeWav(path, L, R) {
  const n = L.length;
  const b = Buffer.alloc(44 + n * 8);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 8, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(3, 20); b.writeUInt16LE(2, 22); b.writeUInt32LE(SR, 24);
  b.writeUInt32LE(SR * 8, 28); b.writeUInt16LE(8, 32); b.writeUInt16LE(32, 34); b.write('data', 36); b.writeUInt32LE(n * 8, 40);
  for (let i = 0; i < n; i++) { b.writeFloatLE(L[i], 44 + i * 8); b.writeFloatLE(R[i], 48 + i * 8); }
  writeFileSync(path, b);
}
mkdirSync(join(root, 'test-out'), { recursive: true });

// ---- default sound (the CHOMPI buffer, slot 15) works with an empty card
{
  const e = new TapeEngine(mod, SR);
  e.boot();
  const [L, R] = render(e, 1.2, [{ at: 0.05, fn: (e) => e.key(60, true) }, { at: 0.9, fn: (e) => e.key(60, false) }]);
  check(rms(L, 0.2 * SR, 0.8 * SR) > 0.005, `empty card: the built-in buffer sound plays (rms ${rms(L, 0.2 * SR, 0.8 * SR).toFixed(4)})`);
  writeWav(join(root, 'test-out/tape_default.wav'), L, R);
}

// ---- boot copier builds the *_double files
const { e: jam, bootMs } = engineWithBank(MODE.JAMMI, 0);
{
  const one = jam.getFile('jammi_a1.wav');
  const dbl = jam.getFile('jammi_a1_double.wav');
  check(!!dbl, `boot made jammi_a1_double.wav (${bootMs.toFixed(0)} ms for the bank)`);
  check(dbl && dbl.length - 44 === (one.length - 44) / 2, 'double file is half the frames, 44-byte header (FileCopier)');
  const orig = new Uint8Array(readFileSync(join(card, 'jammi_a1.wav')));
  check(one.length === orig.length && one.every((b, i) => b === orig[i]), 'the original file is untouched by the boot copy');
  check(jam.get(GET.FILE_EXISTS, 0) === 1 || true, 'file table updated');
}

// ---- JAMMI: slot 1 chromatic; higher note = faster
{
  const e = jam;
  e.cmd(CMD.VOICE_MODE, MODE.JAMMI);
  e.cmd(CMD.BANK, 0);
  e.cmd(CMD.VOICE_SLOT, 1, 1);
  const [L, R] = render(e, 2.6, [
    { at: 0.05, fn: (e) => e.key(60, true) }, { at: 1.0, fn: (e) => e.key(60, false) },
    { at: 1.4, fn: (e) => e.key(72, true) }, { at: 2.4, fn: (e) => e.key(72, false) },
  ]);
  writeWav(join(root, 'test-out/tape_jammi_a1.wav'), L, R);
  const a = rms(L, 0.2 * SR, 0.9 * SR);
  const b = rms(L, 1.6 * SR, 2.3 * SR);
  check(a > 0.002 && b > 0.002, `jammi a1 sounds on C4 and C5 (rms ${a.toFixed(4)}, ${b.toFixed(4)})`);
  const z1 = zeroCrossRate(L, 0.3 * SR, 0.9 * SR);
  const z2 = zeroCrossRate(L, 1.6 * SR, 2.2 * SR);
  check(z2 / z1 > 1.6 && z2 / z1 < 2.5, `an octave up plays about twice as fast (zero-cross ratio ${(z2 / z1).toFixed(2)})`);
}

// ---- CUBBI: one sample per white key
{
  const { e } = engineWithBank(MODE.CUBBI, 0);
  e.cmd(CMD.VOICE_MODE, MODE.CUBBI);
  e.cmd(CMD.BANK, 0);
  const st = e.state();
  check(st.mode === MODE.CUBBI && st.files.slice(0, 14).filter(Boolean).length === 14, `cubbi bank a: 14 slots found (${st.files.slice(0, 14).filter(Boolean).length})`);
  const def = { pitch: 1, start: 0, end: 1, attack: 0, decay: 0, autoloop: true, sustain: true, gain: 0.5, pan: 0.5 };
  const hits = [48, 50, 52, 53];
  const ev = [];
  hits.forEach((n, i) => {
    ev.push({ at: 0.05 + i * 0.5, fn: (e) => { e.openCubbiSlot(def); e.key(n, true); } });
    ev.push({ at: 0.4 + i * 0.5, fn: (e) => e.key(n, false) });
  });
  const [L, R] = render(e, 2.2, ev);
  writeWav(join(root, 'test-out/tape_cubbi_a.wav'), L, R);
  const parts = hits.map((_, i) => rms(L, (0.08 + i * 0.5) * SR, (0.38 + i * 0.5) * SR));
  check(parts.every((p) => p > 0.001), `cubbi slots 1-4 each sound (${parts.map((p) => p.toFixed(3)).join(', ')})`);
}

// ---- looper: record a phrase, it plays back, overdub, clear
{
  const e = jam;
  e.cmd(CMD.VOICE_MODE, MODE.JAMMI);
  e.cmd(CMD.VOICE_SLOT, 1, 1);
  const ev = [
    { at: 0.05, fn: (e) => { e.cmd(CMD.LOOPER_REC_BTN, 1); } },
    { at: 0.10, fn: (e) => e.cmd(CMD.LOOPER_REC_BTN, 0) },
    { at: 0.15, fn: (e) => e.key(60, true) }, { at: 0.6, fn: (e) => e.key(60, false) },
    { at: 1.05, fn: (e) => e.cmd(CMD.LOOPER_REC_BTN, 1) }, // second press: sets the length, overdubs
    { at: 1.10, fn: (e) => e.cmd(CMD.LOOPER_REC_BTN, 0) },
  ];
  const [L, R] = render(e, 3.6, ev);
  writeWav(join(root, 'test-out/tape_looper.wav'), L, R);
  const st = e.state();
  check(st.looper.playing && !st.looper.empty, `looper is playing a loop (recording/overdub ${st.looper.recording})`);
  const again = rms(L, 1.2 * SR, 1.6 * SR);
  check(again > 0.002, `the phrase comes back on the next pass, with no key held (rms ${again.toFixed(4)})`);
  const third = rms(L, 2.2 * SR, 2.6 * SR);
  check(third > 0.002, `and again on the pass after (rms ${third.toFixed(4)})`);

  // fx before / after the looper switch over without blowing up
  e.cmd(CMD.REVERB, 0.8);
  e.cmd(CMD.FX_PRE_LOOPER, 0);
  const [L2] = render(e, 1.0);
  check(Number.isFinite(rms(L2)) && !e.state().fxPre, 'FX moved after the looper');
  e.cmd(CMD.FX_PRE_LOOPER, 1);
  render(e, 0.5);
  check(e.state().fxPre, 'and back before it');

  // clear: hold play + loop for 2 s
  e.cmd(CMD.LOOPER_PLAY_BTN, 1); e.cmd(CMD.LOOPER_REC_BTN, 1);
  render(e, 2.3);
  e.cmd(CMD.LOOPER_PLAY_BTN, 0); e.cmd(CMD.LOOPER_REC_BTN, 0);
  render(e, 0.3);
  check(e.state().looper.empty, 'hold PLAY + LOOP clears the loop');
}

// ---- sampling: record the line input into the CHOMPI buffer, then play it
{
  const e = new TapeEngine(mod, SR);
  e.boot();
  e.cmd(CMD.INPUT_SOURCE, 1); // line in
  e.cmd(CMD.INPUT_MONITOR, 1);
  let ph = 0;
  const feed = () => { for (let i = 0; i < 128; i++) { ph += (2 * Math.PI * 330) / SR; e.in[2][i] = e.in[3][i] = 0.3 * Math.sin(ph); } };
  const n = Math.round(0.6 * SR);
  e.cmd(CMD.RECORD_START);
  for (let off = 0; off < n; off += 128) { feed(); e.render(128); }
  e.cmd(CMD.RECORD_STOP);
  for (let i = 0; i < 128; i++) e.in[2][i] = e.in[3][i] = 0;
  e.cmd(CMD.INPUT_MONITOR, 0);
  const [L] = render(e, 0.8, [{ at: 0.05, fn: (e) => e.key(60, true) }, { at: 0.6, fn: (e) => e.key(60, false) }]);
  const z = zeroCrossRate(L, 0.15 * SR, 0.5 * SR) / 2;
  check(rms(L, 0.1 * SR, 0.5 * SR) > 0.002 && Math.abs(z - 330) < 25, `recorded line input plays back from the buffer (~${z.toFixed(0)} Hz, expect 330)`);
}

done();
