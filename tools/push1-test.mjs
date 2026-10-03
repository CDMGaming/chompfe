// Offline checks for the Push 1 profile against a fake app API and a fake
// MIDI output. No hardware, no browser.   node tools/push1-test.mjs
import * as push1 from '../web/js/midi/push1.js';
import { P } from '../web/js/engine.js';
import { PARAMS, BY_ID } from '../web/js/params.js';

let fail = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fail++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- fake app
const values = Object.fromEntries(PARAMS.map((p) => [p.id, p.def]));
const listeners = { param: [], state: [], presets: [] };
const notes = [];
const transport = [];
const seq = { steps: new Array(32).fill(-1), length: 0 };
const state = { vu: 0, voices: [], seqPlaying: false, seqRecording: false, seqMuted: false, seqGateOpen: false, seqIndex: 0, seqLength: 0, steps: seq.steps };
const api = {
  P, BY_ID, PARAMS,
  get: (id) => values[id],
  set: (id, v) => { const p = BY_ID[id]; values[id] = Math.min(p.max, Math.max(p.min, v)); listeners.param.forEach((f) => f(id)); },
  getOutDb: () => 18, setOutDb: () => {},
  noteOn: (src, n, v) => notes.push(['on', src, n, v]),
  noteOff: (src) => notes.push(['off', src]),
  releaseSources: () => {}, allNotesOff: () => {}, preview: () => {},
  play: (d) => transport.push(['play', d]), loop: (d) => transport.push(['loop', d]), rest: (d) => transport.push(['rest', d]),
  tap: () => transport.push(['tap']),
  state: () => state,
  seq: {
    get steps() { return seq.steps; }, get length() { return seq.length; },
    click: (i) => { if (i >= seq.length) seq.length = i + 1; seq.steps[i] = seq.steps[i] >= 0 ? -1 : 60; },
    setStep: (i, n) => { if (i >= seq.length) seq.length = i + 1; seq.steps[i] = n; },
    setLength: (n) => { seq.length = n; },
  },
  presets: { currentName: () => '', step: () => {} },
  on: (t, f) => { listeners[t].push(f); return () => {}; },
};

const sent = [];
const dev = push1.create({ output: { send: (b) => sent.push(Array.from(b)) }, api, sysex: true });
const cc = (n, v) => dev.onMessage([0xb0, n, v]);
const on = (n, v = 100) => dev.onMessage([0x90, n, v]);
const off = (n) => dev.onMessage([0x90, n, 0]);
const lcd = (line) => {
  const m = [...sent].reverse().find((x) => x[0] === 0xf0 && x[4] === 0x18 + line);
  return m && m.slice(8, -1).map((c) => (c < 32 ? '#' : String.fromCharCode(c))).join('');
};
const pad = (note) => { let v; for (const m of sent) if (m[0] === 0x90 && m[1] === note) v = m[2]; return v; };

await wait(40);

// port names
check(push1.match('Ableton Push') && push1.match('Ableton Push Live Port'), 'matches Push 1 Live port names');
check(push1.ignore('MIDIIN2 (Ableton Push)') && push1.ignore('Ableton Push User Port') && !push1.match('Ableton Push User Port'), 'leaves the User port alone');
check(!push1.match('Ableton Push 2') && !push1.ignore('Ableton Push 2'), 'does not claim Push 2');

// LCD
const writes = sent.filter((m) => m[0] === 0xf0 && m.length > 8);
check(writes.length === 4 && writes.every((m) => m.length === 77 && m[5] === 0 && m[6] === 0x45 && m[7] === 0 && m[76] === 0xf7),
  'LCD: 4 line writes of F0 47 7F 15 18+n 00 45 00 + 68 chars + F7');
check(sent.filter((m) => m[0] === 0xf0 && m.length === 8).map((m) => m[4]).join() === '28,29,30,31', 'LCD: clears lines 1C..1F on connect');
check(lcd(0).startsWith(' TABLE    FRAME '), `LCD line 1: "${lcd(0)}"`);

// encoders: relative two's complement
const c0 = values[P.CUTOFF];
cc(74, 10); const up = values[P.CUTOFF] - c0;
cc(74, 118); // -10
check(up > 0 && Math.abs(values[P.CUTOFF] - c0) < 1e-9, 'encoder 4: +10 then -10 (value 118) returns to start');

// pages and lower row
cc(21, 127); await wait(30);
check(lcd(0).startsWith('WOB AMT'), 'upper row button 2 -> Motion page');
const wob = values[P.FILTER_LFO_ON];
cc(104, 127);
check(values[P.FILTER_LFO_ON] === (wob ? 0 : 1), 'lower row under a toggle flips it');
cc(20, 127);
values[P.RESONANCE] = 0.9; cc(106, 127);
check(values[P.RESONANCE] === BY_ID[P.RESONANCE].def, 'lower row under a knob resets it');

// transport
cc(85, 127); cc(85, 0); cc(86, 127); cc(86, 0); cc(60, 127); cc(60, 0);
check(transport.map((t) => t.join(':')).join() === 'play:true,play:false,loop:true,loop:false,rest:true,rest:false', 'Play/Record/Mute pass press and release');

// session mode pads: top-left pad = note 92 = step 0
on(92); off(92);
check(seq.length === 1 && seq.steps[0] === 60, 'tap step pad 1 -> note on step 1');
on(95); on(36); off(36); off(95);
check(seq.steps[3] === 48 && seq.length === 4, 'hold step 4 + bottom-left key pad -> step 4 = C3');
on(40, 99); off(40);
check(notes.some((n) => n[0] === 'on' && n[2] === 55 && n[3] === 99), 'session-mode key pad plays G3 with its velocity');

// note mode layout
cc(50, 127); await wait(30);
check([36, 43].every((n) => pad(n) === 45) && pad(37) === 3, 'note mode: roots blue (45), scale notes white (3)');
on(44); off(44);
check(notes.some((n) => n[0] === 'on' && n[2] === 53), 'second row starts a fourth up (F3)');

dev.destroy(true);
check(sent.slice(-4).every((m) => m[0] === 0xf0 && m.length === 8), 'goodbye clears the LCD');

console.log(fail ? `\n${fail} check(s) failed` : '\nall checks passed');
process.exit(fail ? 1 : 0);
