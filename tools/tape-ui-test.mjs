// Checks for the TAPE control layer (web/js/panel/tape-ui.js) driving the real
// TAPE engine: shift-layer sound / bank / input / FX selection, per-slot
// settings, recording a sound, saving / copying / erasing it on the card,
// copying a sound onto the tape, and the looper keys.
//   node tools/tape-ui-test.mjs
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TapeEngine, CMD, MODE, INPUT, sampleName, NOTE_TO_BUTTON } from '../web/js/tape-engine.js';
import { checker } from './fake-api.mjs';

// TapeUI times things with performance.now(); run it on the engine's clock
let clock = 0;
Object.defineProperty(globalThis, 'performance', { value: { now: () => clock }, configurable: true, writable: true });
const { TapeUI } = await import('../web/js/panel/tape-ui.js');

const { check, done } = checker();
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const card = join(root, 'upstream/firmware/card-profiles/tape-2.0');
const SR = 48000;
if (!existsSync(join(card, 'jammi_a1.wav'))) {
  console.log('factory samples not found in upstream/; run the sparse checkout first');
  process.exit(1);
}

const e = new TapeEngine(new WebAssembly.Module(readFileSync(join(root, 'web/tape.wasm'))), SR, { monitorMode: 1 });
for (const [mode, bank] of [[0, 0], [1, 0]]) {
  for (let s = 1; s <= 14; s++) {
    const name = sampleName(mode, bank, s);
    if (existsSync(join(card, name))) e.putFile(name, new Uint8Array(readFileSync(join(card, name))));
  }
}
e.boot();

let state = e.state();
let lineHz = 0; // a sine on the line input when set
let phase = 0;
const out = [];
const ui = new TapeUI({
  cmd: (op, a = 0, b = 0) => e.cmd(op, a, b),
  ask: async (op, a = 0, b = 0) => e.cmd(op, a, b),
  key: (n, down, v, b) => {
    if (b !== undefined) e.x.tp_key(b, n, down ? 1 : 0, v);
    else e.key(n, down, v);
  },
  cubbi: (p) => e.openCubbiSlot(p),
  copy: (r) => { e.x.tp_copy_setup(r.srcBank, r.srcMode, r.destBank, r.destMode, r.set ? 1 : 0, r.chompi, r.looper); e.cmd(CMD.COPY, r.src, r.dest); },
  state: () => state,
});
ui.init();

/** Run the engine (and the UI's frame tick) for `ms`, keeping the output. */
async function run(ms) {
  const blocks = Math.ceil((ms / 1000) * SR / 128);
  for (let i = 0; i < blocks; i++) {
    for (let k = 0; k < 128; k++) {
      const v = lineHz ? 0.05 * Math.sin(phase) : 0;
      phase += (2 * Math.PI * lineHz) / SR;
      e.in[2][k] = v;
      e.in[3][k] = v;
    }
    const [l] = e.render(128);
    out.push(...l.subarray(0, 128));
    clock += (128 / SR) * 1000;
    if (i % 6 === 0) { state = e.state(); ui.tick(clock); }
    await ui.queue;
  }
  state = e.state();
}
const mark = () => out.length;
const rmsFrom = (a) => { let s = 0; for (let i = a; i < out.length; i++) s += out[i] * out[i]; return Math.sqrt(s / Math.max(1, out.length - a)); };
const idx = (note) => note - 48; // keybed index
const BLACK = { JAMMI: 49, CUBBI: 51, MIC: 54, LINE: 56, RESAMPLE: 58, FX_PRE: 61, FX_POST: 63, ERASE: 66, COPY: 68, SAVE: 70 };
const WHITE = [48, 50, 52, 53, 55, 57, 59, 60, 62, 64, 65, 67, 69, 71, 72]; // slots 1..15

async function shiftKey(note) {
  ui.setKbdShift(true);
  await run(20);
  ui.keyDown(idx(note));
  await run(20);
  ui.keyUp(idx(note));
  ui.setKbdShift(false);
  await run(30);
}
async function tap(note, ms = 200) {
  const a = mark();
  ui.keyDown(idx(note), 127);
  await run(ms);
  ui.keyUp(idx(note));
  await run(20);
  return rmsFrom(a);
}
async function star(ms) { ui.star(true); await run(ms); ui.star(false); await run(30); }
async function settle(ms = 1300) { ui.setKbdShift(false); await run(ms); }

// ---- the shift page opens with the star key and closes again
ui.star(true);
await run(400);
check(ui.menuOpen, 'holding the star key (switch down) opens the shift page');
ui.star(false);
await run(1100);
check(!ui.menuOpen && !ui.latched, 'letting go closes it again');
// a quick tap latches shift; another tap unlatches (a Chompfe convenience)
await star(40);
check(ui.latched && ui.menuOpen, 'a tap latches it');
await star(40);
await run(1100);
check(!ui.latched && !ui.menuOpen, 'another tap lets go');

// ---- JAMMI: pick a sound with shift + white key
await shiftKey(WHITE[2]);
check(state.mode === MODE.JAMMI && state.slot === 3, `shift + third white key picks JAMMI sound 3 (slot ${state.slot})`);
check(ui.soundLabel() === 'jammi a3', `the display names it (${ui.soundLabel()})`);
{ const r = await tap(60); check(r > 0.002, `it plays (${r.toFixed(4)})`); }

// ---- the speed knob changes the speed; per-slot settings follow the slot
const p0 = state.pitch;
ui.turn(0, -40);
await run(30);
check(state.pitch < p0 - 0.05, `speed knob slows the sample (${p0.toFixed(2)} -> ${state.pitch.toFixed(2)})`);
ui.turn(1, 30); // start point
await run(30);
const start3 = ui.ev[0][1];
check(start3 > 0.05, `start knob moves the start point (${start3.toFixed(3)})`);
await shiftKey(WHITE[4]);
check(state.slot === 5 && ui.ev[0][1] === 0, 'another slot comes with its own (default) settings');
await shiftKey(WHITE[2]);
check(Math.abs(ui.ev[0][1] - start3) < 1e-6 && Math.abs(state.pitch - (ui.ev[0][0] === 0.83 ? 1 : state.pitch)) < 1, 'and slot 3 gets its start point back');

// shift + start knob slides start and end together
const [s0, e0] = [ui.ev[0][1], ui.ev[0][2]];
ui.setKbdShift(true);
await run(20);
ui.turn(1, -2);
await run(20);
ui.setKbdShift(false);
await run(1100);
check(ui.ev[0][1] < s0 && ui.ev[0][2] < e0 && Math.abs((e0 - s0) - (ui.ev[0][2] - ui.ev[0][1])) < 1e-6, 'shift + start knob slides the whole window');

// ---- effects: pre / post the tape
await shiftKey(BLACK.FX_POST);
await run(300); // the firmware fades the effects out, swaps them, fades back in
check(!state.fxPre, 'shift + FX POST puts the effects after the tape');
await shiftKey(BLACK.FX_PRE);
await run(300);
check(state.fxPre, 'shift + FX PRE puts them before it');

// ---- CUBBI: drum kit, every white key its own sound
await shiftKey(BLACK.CUBBI);
check(state.mode === MODE.CUBBI && state.bank === 0, 'shift + CUBBI switches to the kit (bank a)');
{ const r = await tap(WHITE[0], 150); check(r > 0.002, `first white key plays sound 1 (${r.toFixed(4)})`); }
check(ui.lastCubbi === 1, 'and the display knows which');
ui.turn(0, -60); // slow sound 1 down
await run(30);
const slow1 = ui.ev[0][0];
await tap(WHITE[1], 100);
check(ui.ev[0][0] === 0.83, 'sound 2 has its own speed');
await tap(WHITE[0], 100);
check(Math.abs(ui.ev[0][0] - slow1) < 1e-6, 'sound 1 kept its slower speed');
await shiftKey(BLACK.CUBBI);
check(state.mode === MODE.CUBBI && state.bank === 1, 'CUBBI again: next bank');
await shiftKey(BLACK.JAMMI);
check(state.mode === MODE.JAMMI && state.voiceBank === 0 && state.slot === 3, `JAMMI comes back to its own sound (bank ${state.voiceBank}, slot ${state.slot})`);

// ---- record a sound from the line input (switch up, hold the star key)
await shiftKey(BLACK.LINE);
check(state.input === INPUT.LINE, 'shift + LINE selects the line input');
lineHz = 440;
ui.setSwitch(false);
await run(50);
check(state.vuIn > 0.01, 'record mode: the input is heard');
await star(600);
lineHz = 0;
ui.setSwitch(true);
await run(100);
check(state.files[14] && state.mode === MODE.JAMMI && state.slot === 15, 'holding star recorded slot 15 and JAMMI plays it');
check(await tap(60) > 0.005, 'the recording plays on the keys');

// ---- save it to bank d, slot 1 (JAMMI x3 from bank a)
await shiftKey(BLACK.JAMMI);
await shiftKey(BLACK.JAMMI);
await shiftKey(BLACK.JAMMI);
check(state.bank === 3, `three more JAMMI presses: bank d (${state.bank})`);
ui.setKbdShift(true);
await run(20);
ui.keyDown(idx(BLACK.SAVE)); await run(20); ui.keyUp(idx(BLACK.SAVE));
check(ui.preset === 'save', 'shift + SAVE: pick a slot');
ui.keyDown(idx(WHITE[0])); await run(20); ui.keyUp(idx(WHITE[0]));
check(ui.prompt()[0] === 'save to d1?', `prompt asks (${ui.prompt()[0]})`);
ui.setKbdShift(false);
await run(50);
check(ui.menuOpen, 'the page stays open while a slot is picked');
await star(50);
check(ui.preset === 'saving', 'star confirms');
await settle(2500);
check(!!e.getFile('jammi_d1.wav'), 'jammi_d1.wav is on the card');
check(e.changes().some(([op, n]) => op === '+' && n === 'jammi_d1.wav'), 'and the card reports it as changed (for browser storage)');
check(!ui.menuOpen && state.slot === 1 && state.voiceBank === 3, `and JAMMI plays it (slot ${state.slot}, bank ${state.voiceBank})`);

// ---- copy d1 onto the tape (looper)
ui.setKbdShift(true);
await run(20);
ui.keyDown(idx(BLACK.COPY)); await run(20); ui.keyUp(idx(BLACK.COPY));
ui.keyDown(idx(WHITE[0])); await run(20); ui.keyUp(idx(WHITE[0]));
check(ui.preset === 'copy-dest', 'copy: source picked');
ui.play(true); await run(20); ui.play(false);
check(ui.selected === 16, 'PLAY picks the tape as the destination');
ui.setKbdShift(false);
await run(30);
await star(50);
await settle(2500);
check(!state.looper.empty, 'the tape now holds the sound');
ui.play(true); await run(30); ui.play(false);
let a = mark();
await run(400);
check(state.looper.playing && rmsFrom(a) > 0.005, 'and PLAY plays it');
ui.play(true); await run(30); ui.play(false);
await run(50);

// ---- erase d1
ui.setKbdShift(true);
await run(20);
ui.keyDown(idx(BLACK.ERASE)); await run(20); ui.keyUp(idx(BLACK.ERASE));
ui.keyDown(idx(WHITE[0])); await run(20); ui.keyUp(idx(WHITE[0]));
check(ui.prompt()[0] === 'erase d1?', 'erase: slot picked');
ui.setKbdShift(false);
await run(30);
await star(50);
await settle(2500);
check(!state.files[0], 'd1 is gone');
check(e.changes().some(([op, n]) => op === '-' && n === 'jammi_d1.wav'), 'and the card reports it as erased');
check(state.slot === 15, 'and JAMMI fell back to the recording');

// ---- the looper from the keys: record, overdub, overdub gain
ui.play(true); ui.loop(true); await run(2100); ui.play(false); ui.loop(false); // hold both: clear
await run(100);
check(state.looper.empty, 'holding PLAY + LOOP clears the tape');
await shiftKey(WHITE[2]); // jammi a? we're on bank d; pick the recording key instead
ui.loop(true); await run(30); ui.loop(false);
await run(50);
check(state.looper.recording && state.looper.firstRec, 'LOOP starts recording the tape');
await tap(60, 300);
ui.loop(true); await run(30); ui.loop(false);
await run(100);
check(state.looper.recording && !state.looper.firstRec && state.looper.playing, 'LOOP again sets the length and overdubs');
ui.loop(true); await run(30); ui.loop(false);
await run(100);
check(!state.looper.recording && state.looper.playing, 'and again stops recording');
const g0 = state.looper.dubGain;
ui.setKbdShift(true); await run(20);
ui.play(true); await run(20); ui.play(false);
ui.setKbdShift(false); await run(1100);
check(state.looper.dubGain < g0, `shift + PLAY lowers the overdub level (${g0.toFixed(2)} -> ${state.looper.dubGain.toFixed(2)})`);

// ---- tape speed knob while playing; press resets
ui.turn(4, -30);
await run(50);
check(state.looper.pitch < 0.98, `tape knob slows the tape (${state.looper.pitch.toFixed(2)})`);
ui.press(4);
await run(50);
check(Math.abs(state.looper.pitch - 1) < 0.01, 'pressing it resets to 1x');

// ---- MIDI notes below the keybed reach the same buttons (ui.h midi2key)
check(NOTE_TO_BUTTON[60] === 18, 'keybed mapping sanity');

done();
