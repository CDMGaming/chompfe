// Chompfe UI: knobs, wavetable view, loop recorder/step grid, presets, share
// links, on-screen and computer keyboards.
import { Synth, P, DEFAULT_OUTPUT_DB, TABLE_NAMES } from './synth.js';
import { Panel } from './panel/panel.js';
import { TapeUI } from './panel/tape-ui.js';
import { CMD, INPUT, sampleName } from './tape-engine.js';
import { PARAMS, BY_ID, CLOCK_DIVS } from './params.js';
import { FRAME_SIZE, FRAMES } from './wavetable.js';
import { Knob } from './ui/knob.js';
import { SeqGrid, noteName } from './ui/seqgrid.js';
import { MidiManager } from './midi/manager.js';
import { sourceLabel } from './midi/learn.js';
import { Importer } from './ui/importer.js';
import * as tableStore from './tablestore.js';
import * as cardStore from './cardstore.js';
import { encodeSerumWav } from './wavetable.js';
import {
  defaultValues, encodeLink, decodeLink, linkFromLocation, linkUrl,
  loadPresets, savePresets, soundFrom, applySound, loadSession, saveSession, NUM_SLOTS, SEQ_STEPS,
} from './patch.js';

const synth = new Synth();
window.chompfe = synth; // handy from the devtools console
const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------ initial state
// A shared link wins, then the last session in this browser, then defaults.
const values = defaultValues();
let initialSeq = { steps: new Array(SEQ_STEPS).fill(-1), length: 0 };
const shared = linkFromLocation();
const restored = shared || (() => {
  const s = loadSession();
  return typeof s === 'string' ? decodeLink(s) : null;
})();
if (restored) {
  Object.assign(values, restored.values);
  initialSeq = { steps: restored.steps, length: restored.length };
}
if (shared) $('start-shared').hidden = false;

let lastNote = 60;
let outDb = DEFAULT_OUTPUT_DB;

// Controllers listen here: 'param' (detail: id), 'state', 'presets'
const bus = new EventTarget();
const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));

// ------------------------------------------------------------ toast
let toastTimer = 0;
function toast(msg, ms = 1800) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

// ------------------------------------------------------------ parameters
const knobs = {};
const segs = {};
const checks = {};

function setValue(id, v, opts = {}) {
  const p = BY_ID[id];
  v = Math.min(p.max, Math.max(p.min, v));
  if (p.step) v = Math.round(v / p.step) * p.step;
  values[id] = v;
  if (id === P.PITCH && bendSt) sendPitch();
  else synth.setParam(id, v);
  if (knobs[id] && !opts.fromKnob) knobs[id].set(v, false);
  if (segs[id]) segs[id](v);
  if (checks[id]) checks[id].checked = v > 0.5;
  if (id === P.TABLE) updateSlotSelection();
  if (id === P.FRAME || id === P.TABLE) drawScope();
  if (id === P.GATE) { grid.gate = v; grid.render(); }
  if (!opts.fromPreset) markPresetDirty();
  scheduleSave();
  emit('param', id);
}

const HUES = { wave: 'var(--lime)', filter: 'var(--coral)', shape: 'var(--sun)', motion: 'var(--sky)', space: 'var(--violet)', output: 'var(--ink)' };
const BIPOLAR = new Set([P.PITCH, P.CUTOFF, P.FX, P.PAN]);
const LABELS = {
  [P.CUTOFF]: 'Filter', [P.FX]: 'Delay | Verb', [P.FX_TIME]: 'Time',
  [P.FILTER_LFO_DEPTH]: 'Amount', [P.FILTER_LFO_RATE]: 'Rate',
  [P.PITCH_LFO_DEPTH]: 'Amount', [P.PITCH_LFO_RATE]: 'Rate',
  [P.DRIVE]: 'Squash', [P.GAIN]: 'Level',
};

function addKnob(containerId, id, hue) {
  const p = BY_ID[id];
  const k = new Knob({
    label: LABELS[id] || p.name,
    min: p.min, max: p.max, step: p.step, value: values[id], def: p.def,
    bipolar: BIPOLAR.has(id), fmt: p.fmt, hue,
    onChange: (v) => setValue(id, v, { fromKnob: true }),
  });
  knobs[id] = k;
  k.el.dataset.learn = `param:${id}`;
  $(containerId).append(k.el);
  return k;
}

function addSeg(containerId, id, options) {
  const root = $(containerId);
  const btns = options.map(([label, v]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.setAttribute('role', 'radio');
    b.addEventListener('click', () => setValue(id, v));
    root.append(b);
    return [b, v];
  });
  root.dataset.learn = `param:${id}`;
  segs[id] = (cur) => btns.forEach(([b, v]) => b.setAttribute('aria-checked', String(Math.abs(cur - v) < 1e-6)));
  segs[id](values[id]);
}

function addCheck(containerId, id, label) {
  const l = document.createElement('label');
  l.className = 'toggle';
  l.innerHTML = `<input type="checkbox"> <span>${label}</span>`;
  const input = l.querySelector('input');
  input.checked = values[id] > 0.5;
  input.addEventListener('change', () => setValue(id, input.checked ? 1 : 0));
  checks[id] = input;
  l.dataset.learn = `param:${id}`;
  const row = document.createElement('div');
  row.className = 'row';
  row.append(l);
  $(containerId).after(row);
}

function buildControls() {
  addKnob('k-wave', P.FRAME, HUES.wave);
  addKnob('k-wave', P.PITCH, HUES.wave);
  addSeg('octave', P.OCTAVE, [['oct −1', -1], ['0', 0], ['+1', 1]]);

  addKnob('k-filter', P.CUTOFF, HUES.filter);
  addKnob('k-filter', P.RESONANCE, HUES.filter);

  addKnob('k-shape', P.ATTACK, HUES.shape);
  addKnob('k-shape', P.RELEASE, HUES.shape);

  addKnob('k-wob', P.FILTER_LFO_DEPTH, HUES.motion);
  addKnob('k-wob', P.FILTER_LFO_RATE, HUES.motion);
  addCheck('k-wob', P.FILTER_LFO_ON, 'wobble on');
  addKnob('k-vib', P.PITCH_LFO_DEPTH, HUES.motion);
  addKnob('k-vib', P.PITCH_LFO_RATE, HUES.motion);
  addCheck('k-vib', P.PITCH_LFO_ON, 'vibrato on');

  addKnob('k-space', P.FX, HUES.space);
  addKnob('k-space', P.FX_TIME, HUES.space);

  addKnob('k-output', P.DRIVE, HUES.output);
  addKnob('k-output', P.GAIN, HUES.output);
  addKnob('k-output', P.PAN, HUES.output);

  addKnob('k-seq', P.TEMPO, HUES.wave);
  addSeg('div', P.CLOCK_DIV, CLOCK_DIVS.map((label, i) => [label, i]));
  // The hardware offers three gate lengths (shift + keys): 10 / 50 / 100 %.
  addSeg('gate', P.GATE, [['gate 10%', 0.1], ['50%', 0.5], ['100%', 1]]);

  // Pitch: fine by default; the hardware's shift layer steps in semitones.
  $('snap').addEventListener('change', (e) => {
    const k = knobs[P.PITCH];
    k.step = e.target.checked ? 1 / 24 : 0;
    k.set(values[P.PITCH]); // re-quantise
  });
}

// ------------------------------------------------------------ wavetable view
function buildSlots() {
  const root = $('slots');
  for (let i = 0; i < 7; i++) {
    const b = document.createElement('button');
    b.className = 'slot';
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', `Wavetable ${i + 1}`);
    b.dataset.learn = `table:${i}`;
    b.innerHTML = `<canvas width="120" height="36"></canvas><span>${i + 1}</span><span class="slot-name"></span>`;
    b.addEventListener('click', () => setValue(P.TABLE, i));
    root.append(b);
  }
  updateSlotSelection();
}
function updateSlotSelection() {
  const t = Math.round(values[P.TABLE]);
  [...$('slots').children].forEach((b, i) => {
    b.setAttribute('aria-checked', String(i === t));
    const name = synth.custom[i];
    b.classList.toggle('custom', !!name);
    b.querySelector('.slot-name').textContent = name || TABLE_NAMES[i];
    b.title = name ? `${i + 1}: ${name} (yours)` : `${i + 1}: factory table`;
  });
  $('table-name').textContent = `table ${t + 1}: ${synth.custom[t] || TABLE_NAMES[t]}`;
  $('table-reset').hidden = !synth.custom[t];
}
function drawWave(canvas, data, offset, color, lineWidth, ghost) {
  const g = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  g.clearRect(0, 0, w, h);
  if (!data) return;
  const line = (off, col, lw) => {
    g.strokeStyle = col;
    g.lineWidth = lw;
    g.lineJoin = 'round';
    g.beginPath();
    for (let x = 0; x < w; x++) {
      const s = data[off + Math.floor((x / w) * FRAME_SIZE)];
      const y = h / 2 - s * (h / 2 - 6);
      if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
  };
  if (ghost) {
    // faint neighbouring frames hint at where the table goes next
    for (let d = -3; d <= 3; d++) {
      const f = offset / FRAME_SIZE + d;
      if (d === 0 || f < 0 || f >= FRAMES) continue;
      line(f * FRAME_SIZE, `rgba(127, 95, 224, ${0.22 - Math.abs(d) * 0.05})`, 1.5);
    }
  }
  line(offset, color, lineWidth);
}
function drawSlots() {
  [...$('slots').children].forEach((b, i) => drawWave(b.querySelector('canvas'), synth.tables[i], 8 * FRAME_SIZE, '#7f5fe0', 2));
}
function drawScope() {
  const t = Math.round(values[P.TABLE]);
  const f = Math.round(values[P.FRAME]);
  drawWave($('scope'), synth.tables[t], f * FRAME_SIZE, '#2f2440', 3, true);
  $('frame-label').textContent = `frame ${f + 1}/${FRAMES}`;
}

// ------------------------------------------------------------ loop / sequencer
const grid = new SeqGrid($('grid'), {
  setStep: (i, n) => { synth.send({ t: 'seqStep', i, n }); scheduleSave(); },
  setLength: (n) => { synth.send({ t: 'seqLength', n }); $('len').textContent = n; scheduleSave(); },
  lastNote: () => lastNote,
  preview: (n) => preview(n),
});
function preview(n) {
  if (synth.state.seqPlaying) return; // the loop is already sounding
  synth.noteOn(n, 90);
  setTimeout(() => synth.noteOff(n), 140);
}
grid.steps = initialSeq.steps.slice();
grid.length = initialSeq.length;
grid.gate = values[P.GATE];
grid.render();
$('len').textContent = grid.length;

$('len-dn').addEventListener('click', () => grid.setLength(grid.length - 1));
$('len-up').addEventListener('click', () => grid.setLength(grid.length + 1));
$('btn-clear').addEventListener('click', () => {
  synth.send({ t: 'seqClear' });
  grid.steps.fill(-1);
  grid.setLength(0);
});
$('btn-tap').addEventListener('click', () => synth.send({ t: 'tap' }));

// PLAY / LOOP / REST are hold-aware, so they act on press AND release.
function holdButton(el, msgType, extra) {
  const press = (down) => {
    synth.send({ t: msgType, down });
    if (extra) extra(down);
  };
  let held = false;
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    held = true;
    try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    press(true);
  });
  const up = () => { if (held) { held = false; press(false); } };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  return press;
}
const playBtn = holdButton($('btn-play'), 'playBtn');
const loopBtn = holdButton($('btn-loop'), 'loopBtn');
const restBtn = holdButton($('btn-rest'), 'restBtn', (d) => $('btn-rest').classList.toggle('down', d));

function flash(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth; // restart the animation
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), 1100);
}

function onEngineState(s) {
  grid.update(s, values[P.GATE]);
  $('len').textContent = grid.length;
  $('btn-play').setAttribute('aria-pressed', String(s.seqPlaying));
  $('btn-loop').setAttribute('aria-pressed', String(s.seqRecording));
  $('btn-rest').setAttribute('aria-pressed', String(s.seqMuted));
  if (s.seqFlags & 1) { flash($('btn-loop'), 'flash'); toast('the loop is full (32 steps)'); }
  if (s.seqFlags & 2) { flash($('btn-play'), 'rainbow'); flash($('btn-loop'), 'rainbow'); }
  else if (s.seqFlags & 4) flash($('btn-loop'), 'flash');
  // tap tempo changes the tempo inside the engine
  if (Math.abs(s.tempo - values[P.TEMPO]) >= 1) {
    values[P.TEMPO] = s.tempo;
    knobs[P.TEMPO].set(s.tempo, false);
    scheduleSave();
  }
  if (s.seqRecording || s.seqFlags) scheduleSave();
  emit('state');
}

// ------------------------------------------------------------ presets
// 14 slots like the hardware, kept in this browser's storage.
let presets = loadPresets();
let currentPreset = -1;
let presetMode = 'none'; // 'save' | 'erase'

function buildPresets() {
  const root = $('preset-slots');
  for (let i = 0; i < NUM_SLOTS; i++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pslot';
    b.dataset.learn = `preset:${i}`;
    b.textContent = i + 1;
    b.addEventListener('click', () => presetClick(i));
    root.append(b);
  }
  renderPresets();
}
function renderPresets() {
  emit('presets');
  [...$('preset-slots').children].forEach((b, i) => {
    const p = presets[i];
    b.classList.toggle('filled', !!p);
    b.classList.toggle('current', i === currentPreset);
    b.title = p ? p.name : 'empty';
    b.setAttribute('aria-label', `Sound ${i + 1}: ${p ? p.name : 'empty'}`);
  });
  const bar = $('preset-slots').parentElement;
  bar.classList.toggle('saving', presetMode === 'save');
  bar.classList.toggle('erasing', presetMode === 'erase');
  $('p-save').setAttribute('aria-pressed', String(presetMode === 'save'));
  $('p-erase').setAttribute('aria-pressed', String(presetMode === 'erase'));
  $('preset-hint').innerHTML = presetMode === 'save' ? 'Pick a slot to save the current sound into. <kbd>Esc</kbd> cancels.'
    : presetMode === 'erase' ? 'Pick a slot to erase. <kbd>Esc</kbd> cancels.'
      : 'Click a slot to load it (hover for its name). Sounds save in this browser; the loop and tempo travel with <b>copy link</b>.';
}
function presetClick(i) {
  if (presetMode === 'save') {
    const name = presets[i] && currentPreset === i ? presets[i].name : `sound ${i + 1}`;
    presets[i] = { name, sound: soundFrom(values) };
    if (savePresets(presets)) toast(`saved to slot ${i + 1}`);
    else toast("couldn't save: this browser is blocking storage");
    currentPreset = i;
    presetMode = 'none';
  } else if (presetMode === 'erase') {
    if (presets[i]) {
      presets[i] = null;
      savePresets(presets);
      toast(`slot ${i + 1} erased`);
      if (currentPreset === i) currentPreset = -1;
    }
    presetMode = 'none';
  } else if (presets[i]) {
    applyValues(applySound({ ...values }, presets[i].sound));
    currentPreset = i;
    toast(`${i + 1}: ${presets[i].name}`);
  }
  renderPresets();
}
function markPresetDirty() {
  if (currentPreset !== -1) {
    currentPreset = -1;
    renderPresets();
  }
}
$('p-save').addEventListener('click', () => { presetMode = presetMode === 'save' ? 'none' : 'save'; renderPresets(); });
$('p-erase').addEventListener('click', () => { presetMode = presetMode === 'erase' ? 'none' : 'erase'; renderPresets(); });
$('p-init').addEventListener('click', () => {
  applyValues(applySound({ ...values }, soundFrom(defaultValues())));
  currentPreset = -1;
  renderPresets();
  toast('init sound');
});

function applyValues(next) {
  for (const p of PARAMS) setValue(p.id, next[p.id], { fromPreset: true });
}

// ------------------------------------------------------------ share + session
function currentLinkState() {
  return { values, steps: grid.steps, length: grid.length };
}
$('share').addEventListener('click', async () => {
  const url = linkUrl(currentLinkState());
  history.replaceState(null, '', url);
  try {
    await navigator.clipboard.writeText(url);
    const t = Math.round(values[P.TABLE]);
    toast(synth.custom[t]
      ? `link copied. Heads up: table ${t + 1} is your own; links carry settings, not tables (send the .wav too)`
      : 'link copied: send it to someone');
  } catch {
    // clipboard blocked: the link is still in the address bar
    toast('link is in the address bar: copy it from there');
  }
});

let saveTimer = 0;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveSession(encodeLink(currentLinkState())), 400);
}

// ------------------------------------------------------------ keyboards
const LOW = 48; // on-screen: C3..C5, the hardware's 25-key span
const HIGH = 72;
const held = new Map(); // source id -> note
const down = new Set();

// Sustain pedal: released notes keep sounding until the pedal comes up.
let sustain = false;
const sustained = new Set();

function press(src, note, vel = 100) {
  if (held.has(src)) release(src);
  held.set(src, note);
  if (engine === 'tape') { tapeUI.midiNote(note, true, vel); return; }
  sustained.delete(note);
  down.add(note);
  if (lastNote !== note) { lastNote = note; $('sel-note').textContent = noteName(note); emit('param', 'note'); }
  synth.noteOn(note, vel);
  markKey(note);
}
function release(src) {
  const note = held.get(src);
  if (note === undefined) return;
  held.delete(src);
  if (engine === 'tape') {
    if (![...held.values()].includes(note)) tapeUI.midiNote(note, false);
    return;
  }
  if (![...held.values()].includes(note)) {
    down.delete(note);
    if (sustain) sustained.add(note);
    else synth.noteOff(note);
  }
  markKey(note);
}
function setSustain(on) {
  sustain = on;
  if (on) return;
  for (const note of sustained) if (![...held.values()].includes(note)) synth.noteOff(note);
  sustained.clear();
}
function releaseAll() {
  sustain = false;
  sustained.clear();
  for (const src of [...held.keys()]) release(src);
  synth.allNotesOff();
  if (synth.tapeOn) synth.tcmd(CMD.STOP_ALL);
}

// Pitch bend rides on top of the Pitch knob (the engine has no bend input):
// the engine gets knob + bend, the patch keeps the knob value.
let bendSt = 0;
function sendPitch() {
  synth.setParam(P.PITCH, Math.min(1, Math.max(0, values[P.PITCH] + bendSt / 24)));
}
function setBend(semitones) {
  bendSt = semitones;
  sendPitch();
}

const keyEls = new Map();
function buildKeyboard() {
  const root = $('keyboard');
  if (!root) return; // replaced by the panel's keybed
  const isBlack = (n) => [1, 3, 6, 8, 10].includes(n % 12);
  const whites = [];
  for (let n = LOW; n <= HIGH; n++) if (!isBlack(n)) whites.push(n);
  const ww = 100 / whites.length;
  let wi = 0;
  for (let n = LOW; n <= HIGH; n++) {
    const el = document.createElement('div');
    el.dataset.note = n;
    if (isBlack(n)) {
      el.className = 'key black';
      el.style.left = `${(wi - 0.32) * ww}%`;
      el.style.width = `${ww * 0.64}%`;
    } else {
      el.className = 'key white';
      el.style.left = `${wi * ww}%`;
      el.style.width = `${ww}%`;
      if (n % 12 === 0) el.textContent = noteName(n);
      wi++;
    }
    root.append(el);
    keyEls.set(n, el);
  }
  const noteAt = (x, y) => {
    const el = document.elementFromPoint(x, y);
    return el && el.dataset && el.dataset.note ? parseInt(el.dataset.note, 10) : null;
  };
  const velFromY = (el, y) => {
    const r = el.getBoundingClientRect();
    return Math.round(40 + 87 * Math.min(1, Math.max(0, (y - r.top) / r.height)));
  };
  root.addEventListener('pointerdown', (e) => {
    const n = noteAt(e.clientX, e.clientY);
    if (n === null) return;
    press(`p${e.pointerId}`, n, velFromY(keyEls.get(n), e.clientY));
    try { root.setPointerCapture(e.pointerId); } catch { /* synthetic/inactive pointer */ }
  });
  root.addEventListener('pointermove', (e) => {
    const src = `p${e.pointerId}`;
    if (!held.has(src)) return;
    const n = noteAt(e.clientX, e.clientY);
    if (n !== null && n !== held.get(src)) press(src, n, velFromY(keyEls.get(n), e.clientY));
  });
  const up = (e) => release(`p${e.pointerId}`);
  root.addEventListener('pointerup', up);
  root.addEventListener('pointercancel', up);
}
function markKey(n) {
  const el = keyEls.get(n);
  if (el) el.classList.toggle('down', down.has(n));
}

// Computer keys by physical position (layout independent).
const KEYMAP = {
  KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8,
  KeyH: 9, KeyU: 10, KeyJ: 11, KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15, Semicolon: 16, Quote: 17,
};
let kbOct = 0;
let kbVel = 100;
const transportHeld = new Set(); // codes whose press we turned into PLAY/LOOP/REST
const isTextField = (t) => t instanceof HTMLElement && t.matches('input[type="text"], input[type="url"], textarea, [contenteditable]');
const isActivatable = (t) => t instanceof HTMLElement && t.matches('button, [role="slider"], input, a, summary');

window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || isTextField(e.target) || $('about').open) return;
  if (e.code in KEYMAP) {
    e.preventDefault();
    if (e.repeat) return;
    if (panel.fw.shift) panel.fw.keyDown(KEYMAP[e.code]); // shift functions of the keybed
    else press(`k${e.code}`, 60 + kbOct * 12 + KEYMAP[e.code], kbVel);
  } else if (e.code === 'Space') {
    e.preventDefault(); // Space is always PLAY, even with a button focused
    if (!e.repeat) { transportHeld.add('Space'); api.play(true); }
  } else if (e.code === 'Enter' || e.code === 'NumpadEnter') {
    if (isActivatable(e.target)) return; // Enter presses the focused control instead
    e.preventDefault();
    if (!e.repeat) { transportHeld.add('Enter'); api.loop(true); }
  } else if (e.code === 'KeyQ') {
    if (!e.repeat) { transportHeld.add('KeyQ'); api.rest(true); }
  } else if (e.code === 'KeyZ' || e.code === 'KeyX') {
    kbOct = Math.max(-3, Math.min(3, kbOct + (e.code === 'KeyZ' ? -1 : 1)));
    $('kb-oct').textContent = kbOct > 0 ? `+${kbOct}` : kbOct;
  } else if (e.code === 'KeyC' || e.code === 'KeyV') {
    kbVel = Math.max(10, Math.min(127, kbVel + (e.code === 'KeyC' ? -20 : 20)));
    $('kb-vel').textContent = kbVel;
  } else if (e.code === 'Escape' && presetMode !== 'none') {
    presetMode = 'none';
    renderPresets();
  }
});
window.addEventListener('keyup', (e) => {
  if (e.code in KEYMAP) { release(`k${e.code}`); return; }
  const code = e.code === 'NumpadEnter' ? 'Enter' : e.code;
  if (!transportHeld.delete(code)) return;
  if (code === 'Space') api.play(false);
  else if (code === 'Enter') api.loop(false);
  else if (code === 'KeyQ') api.rest(false);
});
function releaseTransport() {
  if (transportHeld.delete('Space')) api.play(false);
  if (transportHeld.delete('Enter')) api.loop(false);
  if (transportHeld.delete('KeyQ')) api.rest(false);
}
window.addEventListener('blur', () => { releaseAll(); releaseTransport(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { releaseAll(); releaseTransport(); } });

// ------------------------------------------------------------ live drawing
function draw() {
  const s = synth.state;
  $('vu').style.width = `${Math.round(Math.min(1, s.vu) * 100)}%`;
  const playing = new Set(s.voices);
  for (const [n, el] of keyEls) el.classList.toggle('playing', playing.has(n));
  requestAnimationFrame(draw);
}

// ------------------------------------------------------------ start
$('start-btn').addEventListener('click', async () => {
  $('start-btn').disabled = true;
  try {
    await synth.start();
    for (const [slot, t] of await tableStore.loadAll()) {
      if (slot >= 0 && slot < 7 && t.data.length === synth.tables[slot].length) {
        synth.loadTable(slot, t.data);
        synth.custom[slot] = t.name;
      }
    }
    updateSlotSelection();
    synth.send({ t: 'params', list: PARAMS.map((p) => [p.id, values[p.id]]) });
    synth.send({ t: 'seqSteps', notes: grid.steps });
    synth.send({ t: 'seqLength', n: grid.length });
    synth.addEventListener('state', (e) => onEngineState(e.detail.s));
    drawSlots();
    drawScope();
    $('start').hidden = true;
    panel.boot();
    requestAnimationFrame(draw);
    let want = 'wave';
    try { want = localStorage.getItem('chompfe.engine') || 'wave'; } catch { /* ignore */ }
    if (want === 'tape') setEngine('tape');
  } catch (err) {
    console.error(err);
    const e = $('start-err');
    e.hidden = false;
    e.textContent = `Couldn't start audio: ${err.message}`;
    $('start-btn').disabled = false;
  }
});

$('panic').addEventListener('click', releaseAll);
function setOutDb(db) {
  outDb = db;
  synth.setOutputDb(db);
  $('outdb').value = db;
  emit('param', 'out');
}
$('outdb').value = DEFAULT_OUTPUT_DB;
$('outdb').addEventListener('input', (e) => setOutDb(parseFloat(e.target.value)));

// ------------------------------------------------------------ controllers
// Everything a controller profile may do, in one place.
const api = {
  P, BY_ID, PARAMS,
  get: (id) => values[id],
  set: (id, v) => setValue(id, v),
  getOutDb: () => outDb,
  setOutDb,
  noteOn: (src, note, vel) => press(src, note, vel),
  noteOff: (src) => release(src),
  releaseSources: (prefix) => { for (const k of [...held.keys()]) if (k.startsWith(prefix)) release(k); },
  allNotesOff: () => releaseAll(),
  selectedNote: () => lastNote,
  sustain: (on) => setSustain(on),
  bend: (semitones) => setBend(semitones),
  preview,
  // in TAPE mode these are TAPE's play / loop, and Q is its star key
  play: (down) => (engine === 'tape' ? tapeUI.play(down) : playBtn(down)),
  loop: (down) => (engine === 'tape' ? tapeUI.loop(down) : loopBtn(down)),
  rest: (down) => (engine === 'tape' ? tapeUI.star(down) : restBtn(down)),
  tap: () => synth.send({ t: 'tap' }),
  state: () => synth.state,
  seq: {
    get steps() { return grid.steps; },
    get length() { return grid.length; },
    click: (i) => grid.click(i),
    setStep: (i, n) => {
      if (i >= grid.length) grid.setLength(i + 1);
      grid.edit(i, n);
    },
    setLength: (n) => grid.setLength(n),
    clear: () => $('btn-clear').click(),
  },
  presets: {
    load: (i) => { if (presets[i]) { presetMode = 'none'; presetClick(i); } },
    loadDefault: () => { applyValues(applySound({ ...values }, soundFrom(defaultValues()))); currentPreset = -1; renderPresets(); },
    saveTo: (i) => { presets[i] = { name: presets[i] && currentPreset === i ? presets[i].name : `sound ${i + 1}`, sound: soundFrom(values) }; savePresets(presets); currentPreset = i; renderPresets(); },
    erase: (i) => { presets[i] = null; savePresets(presets); if (currentPreset === i) currentPreset = -1; renderPresets(); },
    copy: (a, b) => { if (presets[a]) { presets[b] = JSON.parse(JSON.stringify(presets[a])); savePresets(presets); renderPresets(); } },
    filled: (i) => !!presets[i],
    currentIndex: () => currentPreset,
    currentName: () => (currentPreset >= 0 && presets[currentPreset] ? presets[currentPreset].name : ''),
    step: (dir) => {
      // next/previous filled slot
      for (let k = 1; k <= NUM_SLOTS; k++) {
        const i = (((currentPreset < 0 ? (dir > 0 ? -1 : 0) : currentPreset) + dir * k) % NUM_SLOTS + NUM_SLOTS) % NUM_SLOTS;
        if (presets[i]) { presetMode = 'none'; presetClick(i); return; }
      }
    },
  },
  on: (type, fn) => {
    const h = (e) => fn(e.detail);
    bus.addEventListener(type, h);
    return () => bus.removeEventListener(type, h);
  },
};

const midi = new MidiManager(api);
window.chompfeDebug = { api, midi }; // for the console and the controller tests
function renderMidiStatus() {
  const btn = $('midi-btn');
  const devs = midi.access ? midi.devices() : [];
  if (!MidiManager.supported()) {
    btn.textContent = 'no MIDI here';
    btn.title = 'This browser has no Web MIDI. Chrome and Edge do; the computer keyboard and mouse still work.';
    btn.disabled = true;
  } else if (!midi.access) {
    btn.textContent = 'connect MIDI';
  } else if (!devs.length) {
    btn.textContent = 'MIDI: nothing plugged in';
  } else {
    btn.textContent = `MIDI: ${devs.map((d) => d.label).join(' + ')}`;
    btn.title = devs.map((d) => `${d.name} → ${d.label}`).join('\n')
      + (midi.sysex ? '' : '\n(SysEx not allowed: no Push display)');
  }
}
midi.addEventListener('change', () => { renderMidiStatus(); if ($('midi-dlg').open) renderMidiDialog(); });

// ---- MIDI learn
const learn = midi.learn;
function parseTarget(str) {
  const [kind, v] = str.split(':');
  if (kind === 'param') return { kind, id: +v };
  if (kind === 'table' || kind === 'preset') return { kind, i: +v };
  return { kind: 'action', name: v };
}
function targetLabel(t) {
  if (t.kind === 'param') return BY_ID[t.id].name;
  if (t.kind === 'table') return `Wavetable ${t.i + 1}`;
  if (t.kind === 'preset') return `Sound slot ${t.i + 1}`;
  return { play: 'Play', loop: 'Loop (record)', rest: 'Rest / mute', tap: 'Tap tempo', clear: 'Clear loop', next: 'Next sound', prev: 'Previous sound' }[t.name] || t.name;
}
const targetKey = (t) => (t.kind === 'param' ? `param:${t.id}` : t.kind === 'action' ? `action:${t.name}` : `${t.kind}:${t.i}`);
function markMapped() {
  const mapped = new Set(learn.maps.map((m) => targetKey(m.target)));
  document.querySelectorAll('[data-learn]').forEach((el) => el.classList.toggle('mapped', mapped.has(el.dataset.learn)));
}
function setLearning(on) {
  document.body.classList.toggle('learning', on);
  $('learn-banner').hidden = !on;
  if (!on) learn.disarm();
  renderArmed();
}
function renderArmed() {
  const key = learn.target ? targetKey(learn.target) : null;
  document.querySelectorAll('[data-learn]').forEach((el) => el.classList.toggle('armed', el.dataset.learn === key));
  $('learn-msg').textContent = learn.target
    ? `Now move a knob or press a button on your controller for "${targetLabel(learn.target)}".`
    : 'Click a control on screen, then move a knob or press a button on your controller.';
}
// While learning, clicks pick a target instead of operating the control.
for (const type of ['pointerdown', 'click', 'dblclick']) {
  document.addEventListener(type, (e) => {
    if (!document.body.classList.contains('learning')) return;
    if (e.target.closest('#learn-banner')) return;
    const el = e.target.closest('[data-learn]');
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    if (type === 'pointerdown') learn.arm(parseTarget(el.dataset.learn));
  }, true);
}
learn.addEventListener('armed', renderArmed);
learn.addEventListener('learned', (e) => {
  const m = e.detail;
  toast(`${sourceLabel(m)} -> ${targetLabel(m.target)}${m.mode.startsWith('rel') ? ' (relative)' : ''}`);
});
learn.addEventListener('change', () => { markMapped(); if ($('midi-dlg').open) renderMidiDialog(); });
$('learn-done').addEventListener('click', () => setLearning(false));
window.addEventListener('keydown', (e) => { if (e.code === 'Escape' && document.body.classList.contains('learning')) setLearning(false); });

const MODE_NAMES = { abs: 'knob (absolute)', rel64: 'encoder (64 = still)', rel2c: 'encoder (1 / 127)', button: 'button' };
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Live view of incoming MIDI in the panel: which port, which bytes, what kind.
function describe(d) {
  const st = d[0] & 0xf0;
  const ch = (d[0] & 0x0f) + 1;
  if (d[0] === 0xf0) return `sysex (${d.length} bytes)`;
  if (st === 0x90) return d[2] ? `note on  ${d[1]} vel ${d[2]} ch${ch}` : `note off ${d[1]} ch${ch}`;
  if (st === 0x80) return `note off ${d[1]} ch${ch}`;
  if (st === 0xb0) return `CC ${d[1]} = ${d[2]} ch${ch}`;
  if (st === 0xe0) return `pitch bend ch${ch}`;
  if (st === 0xa0) return `aftertouch ${d[1]} ch${ch}`;
  if (st === 0xd0) return `pressure ch${ch}`;
  return 'other';
}
let monTimer = 0;
midi.addEventListener('message', () => {
  if (!$('midi-dlg').open || monTimer) return;
  monTimer = setTimeout(() => {
    monTimer = 0;
    // aftertouch floods the log; leave it out unless it's all there is
    const rows = midi.monitor.filter((m) => (m.data[0] & 0xf0) !== 0xa0 && (m.data[0] & 0xf0) !== 0xd0);
    $('midi-mon').textContent = (rows.length ? rows : midi.monitor).slice(-8)
      .map((m) => `${m.port.padEnd(26).slice(0, 26)}  ${m.data.slice(0, 3).map((b) => b.toString(16).padStart(2, '0')).join(' ').padEnd(9)}  ${describe(m.data)}`)
      .join('\n') || 'nothing yet';
  }, 60);
});

function openMidiDialog() {
  renderMidiDialog();
  $('midi-dlg').showModal();
}
function renderMidiDialog() {
  const devs = midi.devices();
  $('midi-devs').innerHTML = devs.length
    ? devs.map((d) => `<li><b>${escapeHtml(d.label)}</b> <span class="dim">${escapeHtml(d.name)}</span></li>`).join('')
    : '<li class="dim">No MIDI inputs found. Plug something in; it shows up here.</li>';
  $('midi-sysex').hidden = midi.sysex;
  const rows = learn.maps.map((m, i) => `<tr>
      <td>${escapeHtml(m.port)}<br><span class="dim">${sourceLabel(m)}</span></td>
      <td>${escapeHtml(targetLabel(m.target))}</td>
      <td><select data-i="${i}" aria-label="Control type">${Object.keys(MODE_NAMES).map((x) => `<option value="${x}"${x === m.mode ? ' selected' : ''}>${MODE_NAMES[x]}</option>`).join('')}</select></td>
      <td><button class="btn small" data-del="${i}" type="button" aria-label="Remove mapping">x</button></td>
    </tr>`).join('');
  $('midi-maps').innerHTML = rows || '<tr><td colspan="4" class="dim">No learned mappings yet.</td></tr>';
}
$('midi-maps').addEventListener('change', (e) => { if (e.target.dataset.i) learn.setMode(+e.target.dataset.i, e.target.value); });
$('midi-maps').addEventListener('click', (e) => { if (e.target.dataset.del) learn.remove(+e.target.dataset.del); });
$('midi-learn').addEventListener('click', () => { $('midi-dlg').close(); setLearning(true); });
$('midi-clear').addEventListener('click', () => { if (learn.maps.length && confirm('Remove all learned MIDI mappings?')) learn.clear(); });
markMapped();
$('midi-btn').addEventListener('click', async () => {
  if (midi.access) { openMidiDialog(); return; }
  try {
    await midi.enable();
    toast(midi.sysex ? 'MIDI connected' : 'MIDI connected (without SysEx: no Push display)');
  } catch (err) {
    // Firefox gates Web MIDI behind a per-site "site permission add-on".
    if (/firefox/i.test(navigator.userAgent) || /add-?on/i.test(err.message)) {
      toast('Firefox needs a one-time MIDI add-on for this site and didn\'t offer it here. Open Chompfe in Chrome or Edge for MIDI; keys and mouse still work in Firefox.', 9000);
    } else {
      toast(`MIDI not available: ${err.message}`, 6000);
    }
  }
  renderMidiStatus();
});
renderMidiStatus();
MidiManager.supported() && MidiManager.alreadyGranted().then((ok) => { if (ok) midi.enable().then(renderMidiStatus).catch(() => {}); });
$('about-btn').addEventListener('click', () => $('about').showModal());

buildControls();
buildSlots();
buildPresets();
buildKeyboard();


// ------------------------------------------------------------ your own wavetables
const importer = new Importer({
  ctx: () => synth.ctx,
  getTable: (slot) => synth.tables[slot],
  preview: (slot, table) => { synth.loadTable(slot, table.slice()); drawSlots(); drawScope(); },
  commit: async (slot, name, table) => {
    synth.loadTable(slot, table.slice());
    synth.custom[slot] = name;
    updateSlotSelection();
    drawSlots();
    drawScope();
    toast((await tableStore.put(slot, name, table)) ? `"${name}" is in slot ${slot + 1}` : `"${name}" loaded (this browser won't remember it)`);
  },
  selectSlot: (slot) => setValue(P.TABLE, slot),
  currentSlot: () => Math.round(values[P.TABLE]),
  toast,
});

async function importFile(file, slot) {
  if (!synth.ctx) { toast('wake it up first (the button in the middle)'); return; }
  await importer.open(file, slot ?? Math.round(values[P.TABLE]));
}

$('table-file').addEventListener('change', (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) importFile(f);
});

$('table-save').addEventListener('click', () => {
  const t = Math.round(values[P.TABLE]);
  if (!synth.tables[t]) return;
  const blob = new Blob([encodeSerumWav(synth.tables[t])], { type: 'audio/wav' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${synth.custom[t] || `chompfe-table-${t + 1}`}.wav`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$('table-reset').addEventListener('click', async () => {
  const t = Math.round(values[P.TABLE]);
  await synth.loadFactory(t);
  await tableStore.remove(t);
  updateSlotSelection();
  drawSlots();
  drawScope();
  toast(`slot ${t + 1} is the factory table again`);
});

// Drag and drop: onto a slot targets that slot, anywhere else the current one.
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; document.body.classList.add('dragging'); } });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
window.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  const slot = e.target.closest && e.target.closest('.slot');
  document.querySelectorAll('.slot.dropping').forEach((s) => { if (s !== slot) s.classList.remove('dropping'); });
  if (slot) slot.classList.add('dropping');
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  document.querySelectorAll('.slot.dropping').forEach((s) => s.classList.remove('dropping'));
  const file = e.dataTransfer.files[0];
  if (!file) return;
  const slotEl = e.target.closest && e.target.closest('.slot');
  importFile(file, slotEl ? [...$('slots').children].indexOf(slotEl) : undefined);
});


// ------------------------------------------------------------ the instrument panel
const panel = new Panel($('instrument'), api, {
  table: (slot) => synth.tables[slot],
  tableName: (slot) => synth.custom[slot] || TABLE_NAMES[slot],
  hint: (text) => { $('hint').textContent = text; },
  pickFirmware: (name) => setEngine(name),
  tapeState: () => synth.tapeState,
  tapeLoading: () => tapeLoadingMsg,
  tapePeaks: (mode, bank, slot) => synth.tapePeaks.get(sampleName(mode, bank, slot).replace('.wav', '')),
  extras: () => ({ bridge: bridgeOn, input: !!synth.inputStream }),
  toggleBridge: () => setBridge(!bridgeOn),
  toggleInput: () => toggleInput(),
});
window.chompfeDebug.panel = panel;

// ------------------------------------------------------------ TAPE
// The second firmware: sampler + tape looper + effects, in its own engine.
// Factory banks load the first time they're picked.
const tapeUI = new TapeUI({
  cmd: (op, a, b) => synth.tcmd(op, a, b),
  ask: (op, a, b) => synth.tcmdResult(op, a, b),
  key: (n, down, v, b) => synth.tkey(n, down, v, b),
  cubbi: (p) => synth.tcubbi(p),
  copy: (r) => synth.tcopy(r),
  state: () => synth.tapeState,
});
panel.addFirmware('tape', tapeUI);
window.chompfeDebug.tape = tapeUI;
let engine = 'wave';
let tapeLoadingMsg = '';
let bridgeOn = false;

async function loadBank(mode, bank, quiet) {
  if (synth.tapeBanks.has(`${mode}:${bank}`) || !(await synth.tapeBankExists(mode, bank))) return;
  const name = `${mode ? 'cubbi' : 'jammi'} ${'abcde'[bank]}`;
  if (!quiet) tapeLoadingMsg = `loading ${name}`;
  try {
    await synth.loadTapeBank(mode, bank, (n, of) => { if (!quiet) tapeLoadingMsg = `${name} ${n}/${of}`; });
  } catch (err) {
    console.error(err);
    toast(`couldn't load the ${name} sounds: ${err.message}`, 5000);
  } finally {
    if (!quiet) tapeLoadingMsg = '';
  }
}

async function setEngine(name) {
  if (name === engine) return;
  if (!synth.ctx) { toast('wake it up first (the button in the middle)'); return; }
  releaseAll();
  releaseTransport();
  if (name === 'tape') {
    engine = 'tape';
    panel.setFirmware('tape');
    if (!synth.tapeOn) {
      tapeLoadingMsg = 'waking up';
      try {
        await synth.enableTape();
      } catch (err) {
        console.error(err);
        tapeLoadingMsg = '';
        toast(`TAPE couldn't start: ${err.message}`, 6000);
        engine = 'wave';
        panel.setFirmware('wave');
        return;
      }
      tapeUI.init();
      synth.setMode('tape');
      synth.cardOverrides = await cardStore.loadAll(); // your saved sounds win over the factory ones
      await loadBank(0, 0);
      loadBank(1, 0, true); // the first drum kit, in the background
      const extras = await synth.loadCardExtras();
      if (extras.includes('looper.wav')) synth.tcmd(CMD.LOOPER_OPEN_FILE);
    }
    synth.setMode('tape');
  } else {
    engine = 'wave';
    synth.setMode('wave');
    panel.setFirmware('wave');
  }
  document.body.classList.toggle('tape-mode', engine === 'tape');
  try { localStorage.setItem('chompfe.engine', engine); } catch { /* ignore */ }
  emit('engine', engine);
}
tapeUI.addEventListener('bank', (e) => loadBank(e.detail.mode, e.detail.bank));

// whatever the firmware writes to its card is kept in this browser
synth.addEventListener('card', async (e) => {
  const { files, removed } = e.detail;
  const ok = await cardStore.putMany([...files.map((f) => [f.name, f.data]), ...removed.map((n) => [n, null])]);
  if (!ok && !cardWarned) { cardWarned = true; toast("this browser won't keep your TAPE sounds (storage is blocked); they last until you close the page", 6000); }
});
let cardWarned = false;

$('card-forget').addEventListener('click', async () => {
  if (!confirm('Forget every TAPE sound you saved, copied or erased in this browser? The factory sounds come back after a reload.')) return;
  try { localStorage.removeItem('chompfe.tape.presets'); } catch { /* ignore */ }
  tapeUI.presets = { chompi: null, v: {} };
  toast((await cardStore.clear()) ? 'forgotten: reload for the factory card' : "couldn't reach this browser's storage");
});

// controllers reach TAPE through these
api.engine = () => engine;
api.setEngine = (name) => setEngine(name);
api.tape = tapeUI;
api.tapeState = () => synth.tapeState;
api.bridge = () => bridgeOn;
api.setBridge = (on) => setBridge(on);

function setBridge(on) {
  bridgeOn = on;
  synth.setBridge(on);
  if (on) {
    synth.tcmd(CMD.INPUT_SOURCE, INPUT.LINE);
    toast("WAVE now plays into TAPE's line in: start a loop in WAVE, then record it here (switch up, hold the star key) or onto the tape (LOOP)", 6500);
  } else {
    toast('bridge off');
  }
}

async function toggleInput() {
  if (synth.inputStream) {
    synth.disableInput();
    toast('input off');
    return;
  }
  try {
    await synth.enableInput();
    toast('input on. Shift + MIC or LINE picks it; headphones stop feedback', 5000);
  } catch (err) {
    toast(`no input: ${err.message}`, 5000);
  }
}

// MIDI CC 20-23/25 move the panel knobs on their current page (WAVE manual)
api.knobAbs = (k, v01) => {
  if (engine === 'tape') { tapeUI.absolute(k, v01); return; }
  const f = panel.fw.KNOBS[k].pages[panel.fw.pages[k]].turn;
  const p = BY_ID[f.id];
  setValue(f.id, p.min + v01 * (p.max - p.min));
};

// Computer Shift = the star key's shift; in shift, the note keys reach the
// keybed's shift functions (A = first white key = sound slot 1, ...).
window.addEventListener('keydown', (e) => {
  if (e.key === 'Shift') panel.fw.setKbdShift(true);
  else if (e.code === 'Escape' && panel.fw.mode !== 'none') panel.fw.cancelMode();
}, true);
window.addEventListener('keyup', (e) => { if (e.key === 'Shift') panel.fw.setKbdShift(false); }, true);
window.addEventListener('blur', () => panel.fw.setKbdShift(false));

$('labels-btn').addEventListener('click', () => {
  const on = !document.body.classList.contains('labels');
  document.body.classList.toggle('labels', on);
  $('labels-btn').setAttribute('aria-pressed', String(on));
  try { localStorage.setItem('chompfe.labels', on ? '1' : '0'); } catch { /* ignore */ }
});
try {
  if (localStorage.getItem('chompfe.labels') === '0') { document.body.classList.remove('labels'); $('labels-btn').setAttribute('aria-pressed', 'false'); }
} catch { /* ignore */ }
