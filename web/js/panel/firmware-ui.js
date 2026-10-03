// The hardware's control layer, ported from the firmware's NormalPage.h and
// MenuPage.h and the WAVE quick start guide: six push-button encoders with two
// pages each plus a shift layer, the mode switch, the shift/rest key, and the
// keybed's shift functions (sound slots, octave, gate, LFOs, erase/copy/save).
// No DOM here: the panel calls in, and reads state back to draw.

// detent sizes (NormalPage.h / MenuPage.h)
const FINE = 0.003; // kEncoderFineStep
const COARSE = 0.01; // kEncoderCoarseStep
const ENV_COARSE = 0.03; // kEncoderEnvCoarseStep
const DIV_DETENTS = 12; // clockManager::changeDiv: 12 encoder counts per division

// LED colours (NormalPage.h)
const COL = {
  white: [1, 1, 1], red: [1, 0, 0], orange: [1, 0.6, 0.24], yellow: [1, 0.95, 0.05], green: [0, 1, 0],
  teal: [0.14, 1, 0.92], medBlue: [0, 0.84, 1], blue: [0, 0, 1], purple: [0.58, 0.05, 1], pink: [1, 0.36, 0.62],
};
const mix = (a, b, t) => a.map((x, i) => (1 - t) * x + t * b[i]);
const triple = (a, b, c, t) => (t < 0.5 ? mix(a, b, t * 2) : mix(b, c, (t - 0.5) * 2));
const quad = (a, b, c, d, t) => (t < 0.33 ? mix(a, b, t * 3) : t < 0.66 ? mix(b, c, (t - 0.33) * 3) : mix(c, d, (t - 0.66) * 3));
const scale = (a, k) => a.map((x) => x * k);

// White keys (left to right) are sound slots 1-15; black keys, in order:
export const BLACK_FUNCS = ['oct-', 'oct+', 'gate10', 'gate50', 'gate100', 'lfo-pitch', 'lfo-filter', 'erase', 'copy', 'save'];
export const BLACK_LABELS = ['«', '»', '10%', '50%', '100%', 'PITCH', 'FILTER', 'ERASE', 'COPY', 'SAVE'];
export const KEYBED_LOW = 48; // the 25 keys are MIDI 48..72, as on the hardware
const isBlack = (n) => [1, 3, 6, 8, 10].includes(n % 12);
export const KEYS = Array.from({ length: 25 }, (_, i) => {
  const note = KEYBED_LOW + i;
  return { note, black: isBlack(note) };
});
let w = 0;
let b = 0;
for (const k of KEYS) {
  if (k.black) k.func = BLACK_FUNCS[b++];
  else k.slot = ++w; // 1..15
}

export class FirmwareUI extends EventTarget {
  constructor(api) {
    super();
    this.api = api;
    this.pages = [0, 0, 0, 0, 0, 0];
    this.switchDown = true; // down: the star key is shift; up: rest / mute
    this.starHeld = false;
    this.starDownAt = 0;
    this.starUsed = false;
    this.latched = false;
    this.kbdShift = false;
    this.mode = 'none'; // 'save' | 'erase' | 'copy-src' | 'copy-dest'
    this.selected = 0; // slot picked in a preset mode (1..15), 0 = none
    this.copySrc = 0;
    this.flashMsg = null; // { text, until }
    this.pitchAcc = null; // half-step accumulator (MenuPage pre_quantized_amount)
    this.tableAcc = 0;
    this.divAcc = 0;
    this.keyNotes = new Map(); // key index -> note sounding from that key
    const { P } = api;
    const set = (id, v) => api.set(id, v);
    const get = (id) => api.get(id);
    const nudge = (id, d) => set(id, get(id) + d);

    // [page][turn | shift] -> { label, run(detents), norm() }
    this.KNOBS = [
      { name: 'Pitch', pages: [
        { turn: { label: 'fine tune', id: P.PITCH, run: (d) => nudge(P.PITCH, d * FINE) },
          shift: { label: 'half-steps', id: P.PITCH, run: (d) => this.halfSteps(d) } },
        { turn: { label: 'scan wavetable', id: P.FRAME, run: (d) => nudge(P.FRAME, d) },
          shift: { label: 'change table', id: P.TABLE, run: (d) => this.tableStep(d) } },
      ] },
      { name: 'Attack', pages: [
        { turn: { label: 'attack', id: P.ATTACK, run: (d) => nudge(P.ATTACK, d * FINE) },
          shift: { label: 'coarse attack', id: P.ATTACK, run: (d) => nudge(P.ATTACK, d * ENV_COARSE) } },
        { turn: { label: 'vibrato depth', id: P.PITCH_LFO_DEPTH, run: (d) => nudge(P.PITCH_LFO_DEPTH, d * COARSE) },
          shift: { label: 'vibrato rate', id: P.PITCH_LFO_RATE, run: (d) => nudge(P.PITCH_LFO_RATE, d * COARSE) } },
      ] },
      { name: 'Decay', pages: [
        { turn: { label: 'release', id: P.RELEASE, run: (d) => nudge(P.RELEASE, d * FINE) },
          shift: { label: 'coarse release', id: P.RELEASE, run: (d) => nudge(P.RELEASE, d * ENV_COARSE) } },
        { turn: { label: 'filter LFO depth', id: P.FILTER_LFO_DEPTH, run: (d) => nudge(P.FILTER_LFO_DEPTH, d * COARSE) },
          shift: { label: 'filter LFO rate', id: P.FILTER_LFO_RATE, run: (d) => nudge(P.FILTER_LFO_RATE, d * COARSE) } },
      ] },
      { name: 'Effects', pages: [
        { turn: { label: 'delay <-> reverb', id: P.FX, run: (d) => nudge(P.FX, d * COARSE) },
          shift: { label: 'delay time / size', id: P.FX_TIME, run: (d) => nudge(P.FX_TIME, d * COARSE) } },
        { turn: { label: 'filter', id: P.CUTOFF, run: (d) => nudge(P.CUTOFF, d * COARSE) },
          shift: { label: 'resonance', id: P.RESONANCE, run: (d) => nudge(P.RESONANCE, d * COARSE) } },
      ] },
      { name: 'Tempo', pages: [
        { turn: { label: 'tempo', id: P.TEMPO, run: (d) => nudge(P.TEMPO, d) },
          shift: { label: 'clock divide', id: P.CLOCK_DIV, run: (d) => this.divStep(d) } },
      ] },
      { name: 'Volume', pages: [
        { turn: { label: 'volume', id: P.GAIN, run: (d) => nudge(P.GAIN, d * COARSE) },
          shift: { label: 'compressor', id: P.DRIVE, run: (d) => nudge(P.DRIVE, d * COARSE) } },
        { turn: { label: 'pan', id: P.PAN, run: (d) => nudge(P.PAN, d * COARSE) },
          shift: { label: 'compressor', id: P.DRIVE, run: (d) => nudge(P.DRIVE, d * COARSE) } },
      ] },
    ];
  }

  get shift() {
    return (this.switchDown && this.starHeld) || this.latched || this.kbdShift || this.mode !== 'none';
  }

  changed() { this.dispatchEvent(new Event('change')); }

  // ------------------------------------------------------------ knobs
  fn(k) {
    const knob = this.KNOBS[k];
    const page = knob.pages[Math.min(this.pages[k], knob.pages.length - 1)];
    return this.shift ? page.shift : page.turn;
  }

  turn(k, detents) {
    if (!detents) return;
    this.starUsed = true;
    const f = this.fn(k);
    f.run(detents);
    this.dispatchEvent(new CustomEvent('touched', { detail: { k, id: f.id, label: f.label } }));
    this.changed();
  }

  /** Encoder click. Plain: next page (Tempo: tap). With shift: reset that page. */
  press(k) {
    this.starUsed = true;
    const { api } = this;
    const { P } = api;
    const def = (id) => api.BY_ID[id].def;
    if (!this.shift) {
      if (k === 4) api.tap();
      else this.pages[k] = (this.pages[k] + 1) % this.KNOBS[k].pages.length;
    } else {
      const pg = this.pages[k];
      const reset = (...ids) => ids.forEach((id) => api.set(id, def(id)));
      if (k === 0) { if (pg === 0) { reset(P.PITCH); this.pitchAcc = null; } else reset(P.FRAME); }
      else if (k === 1) pg === 0 ? reset(P.ATTACK) : reset(P.PITCH_LFO_DEPTH, P.PITCH_LFO_RATE);
      else if (k === 2) pg === 0 ? reset(P.RELEASE) : reset(P.FILTER_LFO_DEPTH, P.FILTER_LFO_RATE);
      else if (k === 3) reset(P.FX, P.CUTOFF, P.RESONANCE, P.FX_TIME);
      else if (k === 4) { reset(P.TEMPO, P.CLOCK_DIV); this.divAcc = 0; }
      else if (k === 5) reset(pg === 0 ? P.GAIN : P.PAN, P.DRIVE);
      this.flash(`${this.KNOBS[k].name} reset`);
    }
    this.dispatchEvent(new CustomEvent('touched', { detail: { k, id: this.fn(k).id, label: this.fn(k).label } }));
    this.changed();
  }

  // MenuPage: half-steps accumulate in coarse steps, then snap to semitones
  halfSteps(d) {
    const { api } = this;
    const { P } = api;
    if (this.pitchAcc === null) this.pitchAcc = api.get(P.PITCH);
    this.pitchAcc = Math.max(0, Math.min(1, this.pitchAcc + d * COARSE));
    const semis = Math.round((this.pitchAcc - 0.5) * 2 * 12);
    api.set(P.PITCH, (semis / 12) * 0.5 + 0.5);
  }

  // MenuPage: two detents per table, so landing on one feels intentional
  tableStep(d) {
    const { api } = this;
    this.tableAcc += d;
    while (Math.abs(this.tableAcc) >= 2) {
      const dir = this.tableAcc > 0 ? 1 : -1;
      api.set(api.P.TABLE, Math.max(0, Math.min(6, api.get(api.P.TABLE) + dir)));
      this.tableAcc -= 2 * dir;
    }
  }

  divStep(d) {
    const { api } = this;
    this.divAcc += d;
    while (Math.abs(this.divAcc) >= DIV_DETENTS) {
      const dir = this.divAcc > 0 ? 1 : -1;
      api.set(api.P.CLOCK_DIV, Math.max(0, Math.min(4, api.get(api.P.CLOCK_DIV) + dir)));
      this.divAcc -= DIV_DETENTS * dir;
    }
  }

  /** 0..1 position of what the knob currently controls (for its ring). */
  norm(k) {
    const f = this.fn(k);
    const p = this.api.BY_ID[f.id];
    return (this.api.get(f.id) - p.min) / (p.max - p.min);
  }

  valueText(k) {
    const f = this.fn(k);
    return this.api.BY_ID[f.id].fmt(this.api.get(f.id));
  }

  /** The knob's LED colour [r,g,b] 0..1, as NormalPage::Draw computes it. */
  ledColor(k, vu = 0) {
    const { api } = this;
    const { P } = api;
    const v = (id) => api.get(id);
    const pg = this.pages[k];
    switch (k) {
      case 0: return pg === 0 ? quad(COL.medBlue, COL.green, COL.yellow, COL.red, v(P.PITCH)) : triple(COL.blue, COL.pink, COL.red, v(P.FRAME) / 32);
      case 1: return pg === 0 ? mix(COL.yellow, COL.orange, v(P.ATTACK)) : mix(scale(COL.purple, 0.2), COL.purple, v(P.PITCH_LFO_DEPTH));
      case 2: return pg === 0 ? mix(COL.orange, COL.red, v(P.RELEASE)) : mix(scale(COL.purple, 0.2), COL.purple, v(P.FILTER_LFO_DEPTH));
      case 3: return pg === 0 ? triple(COL.green, mix(COL.green, COL.blue, 0.5), COL.blue, v(P.FX)) : triple(COL.purple, COL.pink, COL.white, v(P.CUTOFF));
      case 4: return quad(COL.medBlue, COL.green, COL.yellow, COL.red, (v(P.TEMPO) - 160) / 320);
      case 5: return pg === 0 ? scale(quad([0.1, 0.1, 0.1], COL.green, COL.yellow, COL.pink, vu), v(P.GAIN)) : mix(COL.blue, COL.red, v(P.PAN));
      default: return [0, 0, 0];
    }
  }

  // ------------------------------------------------------------ mode switch + star key
  setSwitch(down) {
    this.switchDown = down;
    if (!down) { this.latched = false; this.cancelMode(); }
    this.changed();
  }

  /** The star key (shift / rest). */
  star(down) {
    const { api } = this;
    if (!this.switchDown) { api.rest(down); this.starHeld = down; this.changed(); return; }
    if (down) {
      // confirming a preset operation (MenuPage: press the key with a slot picked)
      if (this.selected && (this.mode === 'save' || this.mode === 'erase' || this.mode === 'copy-dest')) {
        this.confirm();
        this.starHeld = true;
        this.starUsed = true;
        this.changed();
        return;
      }
      this.starHeld = true;
      this.starDownAt = performance.now();
      this.starUsed = false;
    } else {
      // a quick tap with nothing else done toggles the shift latch
      const tap = performance.now() - this.starDownAt < 300 && !this.starUsed;
      this.starHeld = false;
      if (tap) this.latched = !this.latched;
    }
    this.changed();
  }

  setKbdShift(on) { if (this.kbdShift !== on) { this.kbdShift = on; this.changed(); } }

  // ------------------------------------------------------------ keys
  keyDown(i, vel = 110) {
    const key = KEYS[i];
    if (!key) return;
    if (!this.shift) {
      this.keyNotes.set(i, key.note);
      this.api.noteOn(`panel:${i}`, key.note, vel);
      return;
    }
    this.starUsed = true;
    if (key.black) this.blackKey(key.func);
    else this.whiteKey(key.slot);
    this.changed();
  }

  keyUp(i) {
    if (this.keyNotes.has(i)) {
      this.keyNotes.delete(i);
      this.api.noteOff(`panel:${i}`);
    }
  }

  blackKey(f) {
    const { api } = this;
    const { P } = api;
    if (f === 'oct-' || f === 'oct+') api.set(P.OCTAVE, api.get(P.OCTAVE) + (f === 'oct+' ? 1 : -1));
    else if (f.startsWith('gate')) api.set(P.GATE, { gate10: 0.1, gate50: 0.5, gate100: 1 }[f]);
    else if (f === 'lfo-pitch') api.set(P.PITCH_LFO_ON, api.get(P.PITCH_LFO_ON) > 0.5 ? 0 : 1);
    else if (f === 'lfo-filter') api.set(P.FILTER_LFO_ON, api.get(P.FILTER_LFO_ON) > 0.5 ? 0 : 1);
    else {
      // erase / copy / save: press to enter the mode, press again to leave it
      const target = f === 'copy' ? 'copy-src' : f;
      const inThis = this.mode === target || (f === 'copy' && this.mode === 'copy-dest');
      if (inThis) this.cancelMode();
      else if (this.mode === 'none') { this.mode = target; this.selected = 0; this.copySrc = 0; }
    }
  }

  whiteKey(slot) {
    const { presets } = this.api;
    const filled = (s) => s === 15 || presets.filled(s - 1);
    if (this.mode === 'none') {
      if (slot === 15) presets.loadDefault();
      else if (filled(slot)) presets.load(slot - 1);
      else this.flash(`slot ${slot} is empty`);
    } else if (this.mode === 'save') {
      if (slot !== 15) this.selected = slot;
      else this.flash("15 is the default; can't save there");
    } else if (this.mode === 'erase') {
      if (slot !== 15 && filled(slot)) this.selected = slot;
    } else if (this.mode === 'copy-src') {
      if (slot !== 15 && filled(slot)) { this.copySrc = slot; this.mode = 'copy-dest'; this.selected = 0; }
    } else if (this.mode === 'copy-dest') {
      if (slot !== 15 && slot !== this.copySrc) this.selected = slot;
    }
  }

  confirm() {
    const { presets } = this.api;
    const s = this.selected;
    if (this.mode === 'save') { presets.saveTo(s - 1); this.flash(`saved to ${s}`); }
    else if (this.mode === 'erase') { presets.erase(s - 1); presets.loadDefault(); this.flash(`erased ${s}`); }
    else if (this.mode === 'copy-dest') { presets.copy(this.copySrc - 1, s - 1); presets.load(s - 1); this.flash(`copied ${this.copySrc} to ${s}`); }
    this.mode = 'none';
    this.selected = 0;
    this.copySrc = 0;
    this.latched = false;
  }

  cancelMode() { this.mode = 'none'; this.selected = 0; this.copySrc = 0; this.changed(); }

  flash(text) { this.flashMsg = { text, until: performance.now() + 1600 }; this.changed(); }

  /** Prompt for the display while a preset operation is in progress. */
  prompt() {
    const s = this.selected;
    if (this.mode === 'save') return s ? [`save to ${s}?`, 'press * to save'] : ['save', 'pick a slot 1-14'];
    if (this.mode === 'erase') return s ? [`erase ${s}?`, 'press * to erase'] : ['erase', 'pick a slot'];
    if (this.mode === 'copy-src') return ['copy', 'pick the source'];
    if (this.mode === 'copy-dest') return s ? [`copy ${this.copySrc} > ${s}?`, 'press * to copy'] : [`copy ${this.copySrc} to`, 'pick a slot'];
    return null;
  }

  // ------------------------------------------------------------ key LEDs
  /** LED colour for key i as [r,g,b] (0..1) or null when dark. */
  keyLed(i, { playing, blink }) {
    const key = KEYS[i];
    const { api } = this;
    const { P } = api;
    if (!this.shift) return playing.has(key.note) ? COL.white : null;
    if (key.black) {
      const f = key.func;
      if (f === 'oct-') return api.get(P.OCTAVE) < 0 ? COL.orange : scale(COL.orange, 0.15);
      if (f === 'oct+') return api.get(P.OCTAVE) > 0 ? COL.orange : scale(COL.orange, 0.15);
      if (f.startsWith('gate')) {
        const g = api.get(P.GATE);
        const cur = g <= 0.25 ? 'gate10' : g <= 0.75 ? 'gate50' : 'gate100';
        return f === cur ? COL.yellow : null;
      }
      if (f === 'lfo-pitch') return api.get(P.PITCH_LFO_ON) > 0.5 ? COL.yellow : null;
      if (f === 'lfo-filter') return api.get(P.FILTER_LFO_ON) > 0.5 ? COL.yellow : null;
      const active = { erase: 'erase', copy: 'copy', save: 'save' }[f];
      const on = this.mode === active || (active === 'copy' && this.mode.startsWith('copy'));
      const c = { erase: COL.red, copy: COL.green, save: COL.medBlue }[f];
      return on ? c : scale(c, 0.25);
    }
    // white keys: sound slots
    const s = key.slot;
    const filled = s === 15 || api.presets.filled(s - 1);
    if (this.mode === 'none') {
      if (s === 15) return COL.pink; // the default slot
      if (api.presets.currentIndex() === s - 1) return COL.white;
      return filled ? scale(COL.white, 0.25) : null;
    }
    if (s === this.selected) return blink ? (this.mode === 'erase' ? COL.red : COL.medBlue) : null;
    if (this.mode === 'copy-dest' && s === this.copySrc) return COL.green;
    if (s === 15) return null;
    if (this.mode === 'save') return blink ? scale(COL.white, filled ? 0.6 : 0.2) : null;
    return filled && blink ? scale(COL.white, 0.6) : null;
  }
}
