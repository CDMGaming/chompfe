// Parameter metadata: names, ranges, defaults and value text. Defaults mirror
// kDefaults in engine/src/chompfe.cpp (the firmware's defaults slot).
// The formulas in fmt() restate the engine setters so the readout is honest.
import { P } from './engine.js';

const pct = (v) => `${Math.round(v * 100)}%`;
const secs = (s) => (s < 1 ? `${Math.round(s * 1000)} ms` : `${s.toFixed(2)} s`);
const lfoHz = (v) => 0.14 * Math.pow(65.41 / 0.14, v);

export const CLOCK_DIVS = ['1/4', '1/8.', '1/8', '1/8T', '1/16'];

export const PARAMS = [
  { id: P.PITCH, key: 'pitch', name: 'Pitch', short: 'PITCH', def: 0.5,
    fmt: (v) => { const st = (v - 0.5) * 24; return `${st >= 0 ? '+' : ''}${st.toFixed(1)} st`; } },
  { id: P.FRAME, key: 'frame', name: 'Frame', short: 'FRAME', def: 0, min: 0, max: 32, step: 1,
    fmt: (v) => `${Math.round(v) + 1}/33` },
  { id: P.TABLE, key: 'table', name: 'Table', short: 'TABLE', def: 0, min: 0, max: 6, step: 1,
    fmt: (v) => `${Math.round(v) + 1}` },
  { id: P.ATTACK, key: 'atk', name: 'Attack', short: 'ATTACK', def: 0,
    fmt: (v) => secs((v < 0.008 ? 0.001 : v) * 5) },
  { id: P.RELEASE, key: 'rel', name: 'Release', short: 'RELEASE', def: 0,
    fmt: (v) => secs(v < 0.008 ? 0.005 : v) },
  { id: P.PITCH_LFO_DEPTH, key: 'pld', name: 'Vibrato depth', short: 'VIB AMT', def: 0,
    fmt: (v) => `±${(v * 2).toFixed(2)} st` },
  { id: P.PITCH_LFO_RATE, key: 'plr', name: 'Vibrato rate', short: 'VIB RATE', def: 0.58,
    fmt: (v) => `${lfoHz(v).toFixed(2)} Hz` },
  { id: P.FILTER_LFO_DEPTH, key: 'fld', name: 'Filter LFO depth', short: 'WOB AMT', def: 0, fmt: pct },
  { id: P.FILTER_LFO_RATE, key: 'flr', name: 'Filter LFO rate', short: 'WOB RATE', def: 0.58,
    fmt: (v) => `${lfoHz(v).toFixed(2)} Hz` },
  { id: P.CUTOFF, key: 'cut', name: 'Filter', short: 'FILTER', def: 0.5,
    fmt: (v) => (Math.abs(v - 0.5) < 0.01 ? 'open' : v < 0.5 ? `LP ${pct((0.5 - v) * 2)}` : `HP ${pct((v - 0.5) * 2)}`) },
  { id: P.RESONANCE, key: 'res', name: 'Resonance', short: 'RESO', def: 0.63, fmt: pct },
  { id: P.FX, key: 'fx', name: 'Delay / Reverb', short: 'DLY|VERB', def: 0.5,
    fmt: (v) => (Math.abs(v - 0.5) < 0.01 ? 'dry' : v < 0.5 ? `delay ${pct((0.5 - v) * 2)}` : `reverb ${pct((v - 0.5) * 2)}`) },
  { id: P.FX_TIME, key: 'fxt', name: 'Delay time / Size', short: 'TIME', def: 0.4,
    fmt: (v) => `${Math.round(((0.99 * v * v * v * 96256 + 450) / 48000) * 1000)} ms` },
  { id: P.DRIVE, key: 'drv', name: 'Squash', short: 'SQUASH', def: 0,
    fmt: (v) => (v < 0.5 ? `comp ${pct(v * 2)}` : `sat ${pct((v - 0.5) * 2)}`) },
  { id: P.GAIN, key: 'gain', name: 'Level', short: 'LEVEL', def: 0.84, fmt: pct },
  { id: P.PAN, key: 'pan', name: 'Pan', short: 'PAN', def: 0.5,
    fmt: (v) => (Math.abs(v - 0.5) < 0.01 ? 'C' : v < 0.5 ? `L${Math.round((0.5 - v) * 200)}` : `R${Math.round((v - 0.5) * 200)}`) },
  { id: P.PITCH_LFO_ON, key: 'plo', name: 'Vibrato on', short: 'VIB ON', def: 1, min: 0, max: 1, step: 1,
    fmt: (v) => (v > 0.5 ? 'on' : 'off') },
  { id: P.FILTER_LFO_ON, key: 'flo', name: 'Filter LFO on', short: 'WOB ON', def: 1, min: 0, max: 1, step: 1,
    fmt: (v) => (v > 0.5 ? 'on' : 'off') },
  { id: P.OCTAVE, key: 'oct', name: 'Octave', short: 'OCTAVE', def: 0, min: -1, max: 1, step: 1,
    fmt: (v) => `${v > 0 ? '+' : ''}${Math.round(v)}` },
  { id: P.TEMPO, key: 'tempo', name: 'Tempo', short: 'TEMPO', def: 320, min: 160, max: 480, step: 1,
    fmt: (v) => `${(v / 2).toFixed(v % 2 ? 1 : 0)} bpm` },
  { id: P.CLOCK_DIV, key: 'div', name: 'Step length', short: 'STEP', def: 2, min: 0, max: 4, step: 1,
    fmt: (v) => CLOCK_DIVS[Math.round(v)] },
  { id: P.GATE, key: 'gate', name: 'Gate', short: 'GATE', def: 0.5, fmt: pct },
];

export const BY_ID = Object.fromEntries(PARAMS.map((p) => [p.id, p]));
export const BY_KEY = Object.fromEntries(PARAMS.map((p) => [p.key, p]));
for (const p of PARAMS) {
  p.min ??= 0;
  p.max ??= 1;
  p.step ??= 0;
}
