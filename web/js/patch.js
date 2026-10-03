// Patch state: what a preset holds, what a share link holds, and how both are
// stored. A "sound" is every engine parameter except the sequencer timing; a
// "link" is the sound plus tempo, step length, gate and the 32-step loop.
import { PARAMS, BY_ID } from './params.js';
import { P } from './engine.js';

export const SEQ_STEPS = 32;
const TIMING = new Set([P.TEMPO, P.CLOCK_DIV, P.GATE]);
export const SOUND_PARAMS = PARAMS.filter((p) => !TIMING.has(p.id));

export function defaultValues() {
  return Object.fromEntries(PARAMS.map((p) => [p.id, p.def]));
}

// ---------------------------------------------------------------- share links
// Binary layout (version 1), then base64url:
//   [0]      version
//   [1..]    one uint16 per PARAMS entry, in PARAMS order, scaled min..max
//   [..]     loop length (0..32)
//   [..]     32 notes, 255 = rest
// About 77 bytes -> ~103 URL characters.
const LINK_VERSION = 1;

function toB64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(str) {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

/** @param {{values:object, steps:number[], length:number}} st */
export function encodeLink(st) {
  const bytes = new Uint8Array(1 + PARAMS.length * 2 + 1 + SEQ_STEPS);
  const dv = new DataView(bytes.buffer);
  let o = 0;
  bytes[o++] = LINK_VERSION;
  for (const p of PARAMS) {
    const t = (st.values[p.id] - p.min) / (p.max - p.min);
    dv.setUint16(o, Math.round(Math.min(1, Math.max(0, t)) * 65535), false);
    o += 2;
  }
  bytes[o++] = st.length;
  for (let i = 0; i < SEQ_STEPS; i++) {
    const n = st.steps[i];
    bytes[o++] = n >= 0 && n <= 127 ? n : 255;
  }
  return toB64url(bytes);
}

/** Returns null if the string isn't a link we understand. */
export function decodeLink(str) {
  try {
    const bytes = fromB64url(str);
    if (bytes[0] !== LINK_VERSION || bytes.length < 1 + PARAMS.length * 2 + 1 + SEQ_STEPS) return null;
    const dv = new DataView(bytes.buffer);
    let o = 1;
    const values = {};
    for (const p of PARAMS) {
      let v = p.min + (dv.getUint16(o, false) / 65535) * (p.max - p.min);
      if (p.step) v = Math.round(v / p.step) * p.step;
      values[p.id] = v;
      o += 2;
    }
    const length = Math.min(SEQ_STEPS, bytes[o++]);
    const steps = [];
    for (let i = 0; i < SEQ_STEPS; i++) {
      const n = bytes[o++];
      steps.push(n === 255 ? -1 : n);
    }
    return { values, length, steps };
  } catch {
    return null;
  }
}

export function linkFromLocation() {
  const m = /[#&]s=([A-Za-z0-9_-]+)/.exec(location.hash);
  return m ? decodeLink(m[1]) : null;
}

export function linkUrl(st) {
  const u = new URL(location.href);
  u.hash = `s=${encodeLink(st)}`;
  return u.toString();
}

// ---------------------------------------------------------------- storage
// localStorage can be missing or throw (private mode, blocked storage);
// everything here degrades to "nothing saved".
const KEY_PRESETS = 'chompfe.presets.v1';
const KEY_SESSION = 'chompfe.session.v1';

function load(key) {
  try {
    const s = localStorage.getItem(key);
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}
function save(key, val) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
    return true;
  } catch {
    return false;
  }
}

/** Sound values keyed by param `key` (stable names, not numeric ids). */
export function soundFrom(values) {
  return Object.fromEntries(SOUND_PARAMS.map((p) => [p.key, values[p.id]]));
}
export function applySound(values, sound) {
  for (const p of SOUND_PARAMS) {
    if (typeof sound[p.key] === 'number') values[p.id] = sound[p.key];
  }
  return values;
}

// 14 slots, like the hardware. Slots 1-6 start with the starter sounds below.
export const NUM_SLOTS = 14;

// Starting points picked from the engine's ranges (not tuned by ear yet);
// overwrite them freely.
const STARTERS = [
  { name: 'Glass', sound: { table: 0, frame: 6, atk: 0, rel: 0.45, fx: 0.78, fxt: 0.62, cut: 0.42, res: 0.4, drv: 0.15 } },
  { name: 'Wobble bass', sound: { table: 2, frame: 18, rel: 0.12, cut: 0.3, res: 0.75, fld: 0.25, flr: 0.42, oct: -1, drv: 0.62 } },
  { name: 'Slow pad', sound: { table: 4, frame: 12, atk: 0.35, rel: 0.85, pld: 0.12, plr: 0.35, fx: 0.86, fxt: 0.8, cut: 0.38 } },
  { name: 'Echo pluck', sound: { table: 1, frame: 2, rel: 0.2, fx: 0.18, fxt: 0.55, cut: 0.45, res: 0.55 } },
  { name: 'Thin lead', sound: { table: 5, frame: 24, rel: 0.25, pld: 0.18, plr: 0.6, cut: 0.62, res: 0.3, fx: 0.35, fxt: 0.3, drv: 0.4 } },
  { name: 'Grit', sound: { table: 6, frame: 30, rel: 0.3, cut: 0.48, res: 0.7, fld: 0.4, flr: 0.7, drv: 0.85 } },
];

export function loadPresets() {
  const stored = load(KEY_PRESETS);
  if (Array.isArray(stored) && stored.length === NUM_SLOTS) return stored;
  const base = soundFrom(defaultValues());
  const slots = new Array(NUM_SLOTS).fill(null);
  STARTERS.forEach((s, i) => {
    slots[i] = { name: s.name, sound: { ...base, ...s.sound } };
  });
  return slots;
}
export function savePresets(slots) { return save(KEY_PRESETS, slots); }

export function loadSession() { return load(KEY_SESSION); }
export function saveSession(st) { return save(KEY_SESSION, st); }

export { BY_ID };
