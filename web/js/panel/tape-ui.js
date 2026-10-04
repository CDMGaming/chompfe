// The TAPE firmware's control layer, ported from its NormalPage.h (knobs,
// keys, play/loop, the record key) and MenuPage.h (the shift layer: banks,
// input select, FX pre/post, erase/copy/save, the second knob functions), and
// ui.h (when the shift page opens and closes, encoder scaling, MIDI keys).
// Same interface as firmware-ui.js, so the panel can drive either.
//
// The engine lives in the worklet, so the few firmware calls that return a
// value (stepped pitch, start/end points) are asked for and applied when the
// answer comes back; everything else is fire-and-forget, in order.
import { CMD, MODE, INPUT, NOTE_TO_BUTTON, buttonToSlot } from '../tape-engine.js';

const FINE = 0.003; // kEncoderFineStep
const COARSE = 0.01; // kEncoderCoarseStep
const REC_DIM = 0.7; // kRecDim
const SLOT_NONE = 100; // kSlotNone
const TAPE = 16; // the looper, as a copy/save target (play / loop keys)

const COL = {
  white: [1, 1, 1], red: [1, 0, 0], orange: [1, 0.6, 0.24], yellow: [1, 0.95, 0.05], green: [0, 1, 0],
  teal: [0.14, 1, 0.92], medBlue: [0, 0.84, 1], blue: [0, 0, 1], purple: [0.58, 0.05, 1], pink: [1, 0.36, 0.62],
  darkOrange: [0.77, 0.38, 0.06], yellowGreen: [0.706, 1, 0], chompi: [0.67, 0, 1], off: [0, 0, 0],
};
const BANK_COL = [COL.purple, COL.orange, COL.teal, COL.darkOrange, COL.yellowGreen];
const mix = (a, b, t) => a.map((x, i) => (1 - t) * x + t * b[i]);
const triple = (a, b, c, t) => (t < 0.5 ? mix(a, b, t * 2) : mix(b, c, (t - 0.5) * 2));
const quad = (a, b, c, d, t) => (t < 0.33 ? mix(a, b, t * 3) : t < 0.66 ? mix(b, c, (t - 0.33) * 3) : mix(c, d, (t - 0.66) * 3));
const scale = (a, k) => a.map((x) => x * k);
const gray = (v) => [v, v, v];
const clamp = (v) => Math.max(0, Math.min(1, v));
const tri = (v) => (v < 0.5 ? v * 2 : (1 - v) * 2); // 0 - 1 - 0

const NUM_PAGES = [2, 2, 2, 3, 1, 2]; // knob_num_pages
const DEFAULTS = [ // ui.h enc_defaults
  [0.83, 0, 1, 0, 0.75, 0.84],
  [0.704, 0, 0, 0, 0, 0.75],
  [0, 0, 0, 0.5, 0, 0],
];

// ui.h midi2key: MIDI note - 24 -> hardware button
const MIDI2KEY = [
  44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55,
  32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43,
  15, 7, 8, 12, 9, 10, 13, 11,
  14, 16, 21, 17, 18, 22, 19, 23,
  20, 24, 29, 25, 30, 26, 31, 27, 28,
];

// black keys (button ids) and what they do in the shift layer
const BTN = { JAMMI: 7, CUBBI: 12, MIC: 13, LINE: 14, RESAMPLE: 21, FX_PRE: 22, FX_POST: 23, ERASE: 29, COPY: 30, SAVE: 31 };
export const TAPE_BLACK_LABELS = ['JAMMI', 'CUBBI', 'MIC', 'LINE', 'RESAMP', 'FX PRE', 'FX POST', 'ERASE', 'COPY', 'SAVE'];
export const TAPE_GROUPS = [['sounds', 0, 2], ['input', 2, 5], ['effects', 5, 7], ['card', 7, 10]];
// keybed indices (0 = MIDI 48), for controllers: the white keys are slots 1..15
export const SLOT_KEYS = [0, 2, 4, 5, 7, 9, 11, 12, 14, 16, 17, 19, 21, 23, 24];
export const FUNC_KEYS = { JAMMI: 1, CUBBI: 3, MIC: 6, LINE: 8, RESAMPLE: 10, FX_PRE: 13, FX_POST: 15, ERASE: 18, COPY: 20, SAVE: 22 };

/** Sample speed from the speed knob (NormalPage::OpenCubbiSlot / MenuPage::SetVoiceSlot). */
export function knobToSpeed(v) {
  const val = v < 0.5 ? (0.5 - v) * -2 : (v - 0.5) * 2; // -1 .. 0 .. 1
  const inv = val < 0 ? -1 : 1;
  if (Math.abs(val) < 0.33) return val * 1.484848 + 0.01 * inv; // .01x - .5x
  if (Math.abs(val) < 0.66) return (val - 0.33 * inv) * 1.515151 + 0.5 * inv; // .5x - 1x
  return (val - 0.66 * inv) * 2.941176 + inv; // 1x - 2x
}
const fmtSpeed = (s) => `${s < 0 ? 'rev ' : ''}${Math.abs(s).toFixed(2)}x`;
const pct = (v) => `${Math.round(v * 100)}%`;
const slotName = (bank, slot) => (slot === TAPE ? 'tape' : slot === 15 ? 'rec' : `${'abcde'[bank]}${slot}`);

const STORE = 'chompfe.tape.presets';

export class TapeUI extends EventTarget {
  /**
   * @param {object} tape
   * @param {(op:number, a?:number, b?:number) => void} tape.cmd
   * @param {(op:number, a?:number, b?:number) => Promise<number>} tape.ask
   * @param {(note:number, down:boolean, vel:number, button?:number) => void} tape.key
   * @param {(p:object) => void} tape.cubbi
   * @param {(req:object) => void} tape.copy
   * @param {() => object|null} tape.state  last engine state from the worklet
   */
  constructor(tape) {
    super();
    this.t = tape;
    this.name = 'tape';
    this.ev = DEFAULTS.map((r) => r.slice()); // enc_values[page][knob]
    this.pages = [0, 0, 0, 0, 0, 0];
    this.switchDown = true; // down: the star key is shift; up: it records
    this.starHeld = false;
    this.starDownAt = 0;
    this.starUsed = false;
    this.latched = false;
    this.kbdShift = false;
    this.menuOpen = false;
    this.preset = 'none'; // MenuPage::PresetMode
    this.selected = SLOT_NONE;
    this.ssBank = SLOT_NONE;
    this.ssMode = 2;
    this.copySrc = SLOT_NONE;
    this.csBank = SLOT_NONE;
    this.csMode = 2;
    this.blinkStart = -1e9; // when a save / copy / erase started (the page stays up >= 1 s)
    this.flashMsg = null;
    this.ledFlash = {}; // knob -> { c, until } (MenuPage lights a knob white on toggles)
    // MenuPage-owned values
    this.delayTime = 0.5;
    this.resonance = 0;
    this.warble = 0;
    this.finalComp = 0;
    this.inputToggled = false;
    this.fxReset = false;
    this.pitchReset = false;
    // shadows of engine state we change ourselves (the posted state lags a frame)
    this.local = { mode: MODE.JAMMI, bank: [0, 0], slot: 15, voiceBank: 0, autoloop: true, sustain: true, pan: 0.5, rec: false, at: 0 };
    this.lastCubbi = 0;
    this.keyDownAt = new Map(); // keybed index -> button sounding
    this.sent = {};
    this.queue = Promise.resolve();
    this.presets = loadPresets();

    this.KNOBS = [
      { name: 'Speed', pages: [{ turn: 'speed', shift: 'speed in steps' }, { turn: 'sample level', shift: 'pan' }] },
      { name: 'Start', pages: [{ turn: 'start', shift: 'slide window' }, { turn: 'attack', shift: 'attack + decay' }] },
      { name: 'End', pages: [{ turn: 'end', shift: 'slide window' }, { turn: 'decay', shift: 'attack + decay' }] },
      { name: 'Magic', pages: [{ turn: 'reverb + delay', shift: 'delay time' }, { turn: 'lo-fi', shift: 'warble' }, { turn: 'filter', shift: 'resonance' }] },
      { name: 'Tape', pages: [{ turn: 'tape speed', shift: 'tape steps' }] },
      { name: 'Volume', pages: [{ turn: 'volume', shift: 'squash' }, { turn: 'input gain', shift: 'squash' }] },
    ];
    this.shiftTips = ['black keys: banks', 'mic line resample', 'fx pre / post tape', 'erase copy save', 'knobs: 2nd function'];
  }

  /** NormalPage::Init + MenuPage::Init, after the engine is up. */
  init() {
    const { cmd } = this.t;
    cmd(CMD.GLOBAL_PITCH, 1);
    cmd(CMD.REVERSE, 0);
    cmd(CMD.INPUT_GAIN, 0.75);
    cmd(CMD.FINAL_COMP, this.finalComp);
    cmd(CMD.RESONANCE, this.resonance);
    cmd(CMD.DELAY_TIME, this.delayTime);
    cmd(CMD.WARBLE, this.warble);
    this.sent = {};
    this.applyDraw();
  }

  get mode() { return this.preset; }
  get shift() { return this.menuOpen; }
  get shiftHeld() { return (this.starHeld && this.switchDown) || this.latched || this.kbdShift; }

  st() { return this.t.state() || {}; }

  // engine facts, preferring our own fresh changes over the (laggy) posted state
  vmode() { return this.fresh() ? this.local.mode : (this.st().mode ?? this.local.mode); }
  bank() { const m = this.vmode(); return this.fresh() ? this.local.bank[m] : (this.st().mode === m ? this.st().bank : this.local.bank[m]); }
  // GetVoiceSlot: JAMMI's sound, or in CUBBI the last pad played
  voiceSlot() {
    if (this.vmode() === MODE.CUBBI) return this.lastCubbi || (this.st().mode === MODE.CUBBI ? this.st().slot : 0);
    return this.fresh() || this.st().mode !== MODE.JAMMI ? this.local.slot : (this.st().slot ?? this.local.slot);
  }
  voiceBank() { return this.vmode() === MODE.CUBBI ? this.bank() : (this.fresh() ? this.local.voiceBank : (this.st().voiceBank ?? 0)); }
  fileExists(i) { const f = this.st().files; return !!(f && f[i]); }
  looper() { return this.st().looper || { empty: true }; }
  recording() { return this.fresh() ? this.local.rec : !!this.st().recording; }
  fresh() { return performance.now() - this.local.at < 250; }
  touch() { this.local.at = performance.now(); }

  /** Sync shadows from the engine when we haven't just changed them. */
  sync() {
    const s = this.t.state();
    if (!s || this.fresh()) return;
    this.local.mode = s.mode;
    this.local.bank[s.mode] = s.bank;
    if (s.mode === MODE.JAMMI) this.local.slot = s.slot;
    // GetVoiceBank answers with the CUBBI bank in CUBBI mode; JAMMI's own is what we keep
    if (s.mode === MODE.JAMMI) this.local.voiceBank = s.voiceBank;
    this.local.autoloop = s.autoloop;
    this.local.sustain = s.sustain;
    this.local.pan = s.pan;
    this.local.rec = s.recording;
    if (s.looper && s.looper.reset) { this.ev[0][4] = DEFAULTS[0][4]; this.t.cmd(CMD.RESET_LOOPER_PITCH_QUANT); }
  }

  changed() { this.dispatchEvent(new Event('change')); }
  touched(k) { this.dispatchEvent(new CustomEvent('touched', { detail: { k } })); this.changed(); }
  flash(text) { this.flashMsg = { text, until: performance.now() + 1600 }; this.changed(); }
  serial(fn) { this.queue = this.queue.then(fn).catch((e) => console.error(e)); return this.queue; }

  send(op, a = 0, b = 0) { this.sent[op] = a; this.t.cmd(op, a, b); }
  sendIfChanged(op, a) { if (this.sent[op] !== a) this.send(op, a); }

  /** What NormalPage::Draw pushes to the engine every frame, for the pages showing. */
  applyDraw() {
    const { ev, pages } = this;
    if (pages[0] === 1) this.sendIfChanged(CMD.GAIN, ev[1][0]);
    if (pages[1] === 1) this.sendIfChanged(CMD.ATTACK, ev[1][1]);
    if (pages[2] === 1) this.sendIfChanged(CMD.DECAY, ev[1][2]);
    if (pages[3] === 0) { this.sendIfChanged(CMD.REVERB, ev[0][3]); this.sendIfChanged(CMD.DELAY_FEEDBACK, ev[0][3]); }
    else if (pages[3] === 1) this.sendIfChanged(CMD.SATURATE, ev[1][3]);
    else this.sendIfChanged(CMD.FILTER, ev[2][3]);
    if (pages[5] === 0) this.sendIfChanged(CMD.MAIN_GAIN, ev[0][5]);
    else this.sendIfChanged(CMD.INPUT_GAIN, ev[1][5]);
    this.sendIfChanged(CMD.INPUT_MONITOR, this.switchDown ? 0 : 1);
  }

  // ------------------------------------------------------------ the shift page
  /** ui.h: the star key with the switch down opens the shift page. */
  openMenu() {
    if (this.menuOpen) return;
    this.menuOpen = true;
    // MenuPage::OnFocusGained
    this.fxReset = false;
    this.pitchReset = false;
    this.t.cmd(CMD.RESET_PITCH_QUANT);
    this.t.cmd(CMD.RESET_LOOPER_PITCH_QUANT);
    this.inputToggled = false;
    this.ssBank = this.bank();
    this.copySrc = SLOT_NONE;
    this.selected = this.voiceSlot();
    this.preset = 'none';
  }

  /** ui.h GenerateEvents: close the shift page once MenuPage::IsClosable. */
  tick(now = performance.now()) {
    this.sync();
    if (this.switchDown && this.shiftHeld) this.openMenu();
    if (!this.menuOpen) { this.applyDraw(); return; }
    const s = this.st();
    const p = this.preset;
    const working = p === 'saving' || p === 'copying' || p === 'erasing';
    const closable = now - this.blinkStart > 1000 && (
      (p === 'saving' && !s.copying) || (p === 'copying' && !s.copying) || (p === 'erasing' && !s.erasing)
      || (p === 'none' && !this.shiftHeld) || (!working && !this.switchDown));
    if (!closable) { this.applyDraw(); return; }
    if ((p === 'saving' || p === 'copying') && this.selected === TAPE) {
      this.t.cmd(CMD.LOOPER_OPEN_FILE);
      this.ev[0][4] = DEFAULTS[0][4];
    } else if ((p === 'copying' || p === 'saving') && this.ssMode !== MODE.CUBBI) {
      this.menuSetVoiceSlot(this.selected);
    } else if (p === 'erasing' && this.vmode() === MODE.JAMMI && this.voiceSlot() === this.selected) {
      this.menuSetVoiceSlot(15);
    }
    if (working) this.flash({ saving: 'saved', copying: 'copied', erasing: 'erased' }[p]);
    this.menuOpen = false;
    this.preset = 'none';
    this.selected = SLOT_NONE;
    this.latched = false;
    this.applyDraw();
    this.changed();
  }

  cancelMode() {
    if (['save', 'erase', 'copy-src', 'copy-dest'].includes(this.preset)) { this.preset = 'none'; this.selected = SLOT_NONE; this.changed(); }
  }

  // ------------------------------------------------------------ per-slot settings (PresetManager)
  presetGet(mode, bank, slot) {
    if (slot === 15) return this.presets.chompi;
    return this.presets.v[`${mode}:${bank}:${slot}`] || null;
  }
  presetSet(mode, bank, slot, vals) {
    if (slot < 1 || slot > 15) return;
    if (slot === 15) this.presets.chompi = vals;
    else this.presets.v[`${mode}:${bank}:${slot}`] = vals;
    this.savePresetsSoon();
  }
  savePresetsSoon() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { try { localStorage.setItem(STORE, JSON.stringify(this.presets)); } catch { /* ignore */ } }, 400);
  }

  /** DumpValuePresets: the current knob values belong to the current slot. */
  dump() {
    const { ev } = this;
    this.presetSet(this.vmode(), this.bank(), this.voiceSlot(), [
      ev[0][0], ev[0][1], ev[0][2], ev[1][1], ev[1][2], this.local.autoloop ? 1 : 0, this.local.sustain ? 1 : 0, ev[1][0], this.local.pan,
    ]);
  }

  /** MenuPage::SetVoiceSlot (JAMMI): load the slot and its settings. */
  menuSetVoiceSlot(slot) {
    const { ev } = this;
    const p = this.presetGet(this.vmode(), this.bank(), slot);
    let autoloop = true;
    let sustain = true;
    let pan = 0.5;
    if (!p) {
      ev[0][0] = DEFAULTS[0][0]; ev[0][1] = DEFAULTS[0][1]; ev[0][2] = DEFAULTS[0][2];
      ev[1][0] = DEFAULTS[1][0]; ev[1][1] = DEFAULTS[1][1]; ev[1][2] = DEFAULTS[1][2];
    } else {
      [ev[0][0], ev[0][1], ev[0][2], ev[1][1], ev[1][2]] = p;
      autoloop = !!p[5]; sustain = !!p[6]; ev[1][0] = p[7]; pan = p[8];
    }
    const speed = knobToSpeed(ev[0][0]);
    this.send(CMD.AUTOLOOP, autoloop ? 1 : 0);
    this.send(CMD.SUSTAIN, sustain ? 1 : 0);
    this.send(CMD.PAN, pan);
    this.send(CMD.GLOBAL_PITCH, Math.abs(speed));
    this.send(CMD.REVERSE, speed < 0 ? 1 : 0);
    this.send(CMD.START_FORCE, ev[0][1]);
    this.send(CMD.END_FORCE, ev[0][2]);
    this.send(CMD.GAIN, ev[1][0]);
    this.send(CMD.ATTACK, ev[1][1]);
    this.send(CMD.DECAY, ev[1][2]);
    this.send(CMD.VOICE_SLOT, slot, 1);
    Object.assign(this.local, { autoloop, sustain, pan, slot });
    if (this.vmode() === MODE.JAMMI) this.local.voiceBank = this.bank();
    this.touch();
  }

  /** NormalPage::OpenCubbiSlot: a CUBBI key brings its slot's settings. */
  openCubbiSlot(slot) {
    if (!this.fileExists(slot - 1)) return;
    const { ev } = this;
    const p = this.presetGet(MODE.CUBBI, this.bank(), slot);
    let loop = true;
    let sustain = true;
    let pan = 0.5;
    if (!p) {
      ev[0][0] = DEFAULTS[0][0]; ev[0][1] = DEFAULTS[0][1]; ev[0][2] = DEFAULTS[0][2];
      ev[1][0] = DEFAULTS[1][0]; ev[1][1] = DEFAULTS[1][1]; ev[1][2] = DEFAULTS[1][2];
    } else {
      [ev[0][0], ev[0][1], ev[0][2], ev[1][1], ev[1][2]] = p;
      loop = !!p[5]; sustain = !!p[6]; ev[1][0] = p[7]; pan = p[8];
    }
    this.lastCubbi = slot;
    this.t.cubbi({ pitch: knobToSpeed(ev[0][0]), start: ev[0][1], end: ev[0][2], attack: ev[1][1], decay: ev[1][2], autoloop: loop, sustain, gain: ev[1][0], pan });
  }

  // ------------------------------------------------------------ knobs
  fn(k) {
    const knob = this.KNOBS[k];
    const page = knob.pages[Math.min(this.pages[k], knob.pages.length - 1)];
    return { label: this.menuOpen ? page.shift : page.turn };
  }

  /** ui.h: the speed and tape knobs move one count per detent, the rest three. */
  turn(k, detents) {
    if (!detents) return;
    this.starUsed = true;
    const turns = (k === 0 || k === 4) ? detents : detents * 3;
    if (this.menuOpen) this.serial(() => this.menuTurn(k, turns));
    else this.serial(() => this.normalTurn(k, turns));
    this.touched(k);
  }

  /** MIDI CC 20-25: set a knob's current page outright (ui.h ProcessMidi). */
  absolute(k, v01) {
    if (this.menuOpen) return;
    if (k === 4 && !this.looper().playing) return;
    this.serial(() => this.normalTurn(k, 0, v01));
    this.touched(k);
  }

  /** NormalPage::OnEncoderTurned (`abs` set: a CC's knob position) */
  async normalTurn(k, turns, abs) {
    const { ev } = this;
    const page = this.pages[k];
    const old = ev[page][k];
    let update = true;
    let inc = turns * COARSE;
    if ((k === 0 && page === 0) || (k === 1 && page === 0) || (k === 2 && page === 0) || k === 4) inc = turns * FINE;
    ev[page][k] = clamp(abs !== undefined ? abs : ev[page][k] + inc);

    if (k === 0 && page === 0) this.send(CMD.PITCH_FREE, ev[0][0]);
    else if (k === 4) {
      if (this.looper().playing) this.send(CMD.LOOPER_PITCH_FREE, ev[0][4]);
      else { ev[0][4] = old; this.send(CMD.LOOPER_SCRUB, turns); }
    }

    // keep the end point after the start point
    if (page === 0 && (k === 1 || k === 2)) {
      if (ev[0][1] + 0.01 >= ev[0][2]) ev[page][k] = old;
      else if (k === 1) {
        if (!(await this.t.ask(CMD.START, ev[0][1])) && turns > 0) { update = false; ev[0][1] = old; }
      } else if (!(await this.t.ask(CMD.END, ev[0][2])) && turns < 0) { update = false; ev[0][2] = old; }
    }
    if (k < 3 && update) this.dump();
    this.applyDraw();
    this.changed();
  }

  /** MenuPage::OnEncoderTurned */
  async menuTurn(k, turns) {
    if (this.preset !== 'none') return;
    const { ev } = this;
    const page = this.pages[k];
    const inc = turns * COARSE;
    if (k === 0) {
      if (page === 0) ev[0][0] = await this.t.ask(CMD.PITCH_QUANT, turns, ev[0][0]);
      else { this.local.pan = clamp(this.local.pan + inc); this.send(CMD.PAN, this.local.pan); this.touch(); }
      this.dump();
    } else if ((k === 1 || k === 2) && page === 0) {
      // slide the sample window, start and end together
      if (!(turns > 0 && ev[0][2] + inc > 1) && !(turns < 0 && ev[0][1] + inc < 0)) {
        ev[0][1] += inc;
        ev[0][2] += inc;
        this.send(CMD.START_FORCE, ev[0][1]);
        this.send(CMD.END_FORCE, ev[0][2]);
        this.dump();
      }
      this.pages[1] = 0;
      this.pages[2] = 0;
    } else if (k === 1 || k === 2) {
      // attack and decay together
      const v = clamp((k === 1 ? ev[1][1] : ev[1][2]) + inc);
      this.send(CMD.ATTACK, v);
      this.send(CMD.DECAY, v);
      ev[1][1] = v;
      ev[1][2] = v;
      this.dump();
      this.pages[1] = 1;
      this.pages[2] = 1;
    } else if (k === 3) {
      if (page === 0) { this.delayTime = clamp(this.delayTime + inc); this.send(CMD.DELAY_TIME, this.delayTime); }
      else if (page === 1) { this.warble = clamp(this.warble + inc); this.send(CMD.WARBLE, this.warble); }
      else { this.resonance = clamp(this.resonance + inc); this.send(CMD.RESONANCE, this.resonance); }
    } else if (k === 4) {
      ev[0][4] = await this.t.ask(CMD.LOOPER_PITCH_QUANT, turns, ev[0][4]);
    } else if (k === 5) {
      this.finalComp = clamp(this.finalComp + inc);
      this.send(CMD.FINAL_COMP, this.finalComp);
      this.inputToggled = false;
    }
    this.changed();
  }

  /** Encoder click: NormalPage pages / tape-speed reset; MenuPage resets and toggles. */
  press(k) {
    this.starUsed = true;
    const { ev } = this;
    if (this.menuOpen && k !== 4) {
      if (k === 0) {
        if (this.pages[0] === 0) {
          ev[0][0] = DEFAULTS[0][0];
          this.send(CMD.GLOBAL_PITCH, 1);
          this.send(CMD.REVERSE, 0);
          this.t.cmd(CMD.RESET_PITCH_QUANT);
          this.flash('speed 1x');
        } else {
          ev[1][0] = DEFAULTS[1][0];
          this.local.pan = 0.5;
          this.send(CMD.PAN, 0.5);
          this.send(CMD.GAIN, 0.704);
          this.touch();
          this.flash('level + pan reset');
        }
        this.dump();
        this.ledFlash[0] = { c: COL.white, until: performance.now() + 400 };
      } else if (k === 1) {
        this.local.autoloop = !this.local.autoloop;
        this.send(CMD.AUTOLOOP, this.local.autoloop ? 1 : 0);
        this.touch();
        this.dump();
        this.ledFlash[1] = { c: gray(this.local.autoloop ? 1 : 0), until: performance.now() + 700 };
        this.flash(this.local.autoloop ? 'loop: on' : 'loop: off');
      } else if (k === 2) {
        this.local.sustain = !this.local.sustain;
        this.send(CMD.SUSTAIN, this.local.sustain ? 1 : 0);
        this.touch();
        this.dump();
        this.ledFlash[2] = { c: gray(this.local.sustain ? 1 : 0), until: performance.now() + 700 };
        this.flash(this.local.sustain ? 'hold: on' : 'hold: off (one-shot)');
      } else if (k === 5) {
        this.t.cmd(CMD.MONITOR_NEXT);
        this.inputToggled = true;
        const next = ((this.st().monitor ?? 1) + 1) % 3;
        this.flash(`monitor: ${['headphones', 'everywhere', 'send/return'][next]}`);
      } else if (k === 3) {
        ev[0][3] = DEFAULTS[0][3]; ev[1][3] = DEFAULTS[1][3]; ev[2][3] = DEFAULTS[2][3];
        this.send(CMD.REVERB, ev[0][3]);
        this.send(CMD.DELAY_FEEDBACK, ev[0][3]);
        this.send(CMD.SATURATE, ev[1][3]);
        this.send(CMD.FILTER, ev[2][3]);
        this.delayTime = 0.5; this.resonance = 0; this.warble = 0;
        this.send(CMD.RESONANCE, 0);
        this.send(CMD.DELAY_TIME, 0.5);
        this.send(CMD.WARBLE, 0);
        this.ledFlash[3] = { c: COL.white, until: performance.now() + 400 };
        this.flash('effects reset');
      }
    } else if (k === 4) {
      // reset the tape speed
      ev[0][4] = DEFAULTS[0][4];
      this.send(CMD.LOOPER_PITCH, 1);
      this.t.cmd(CMD.RESET_LOOPER_PITCH_QUANT);
      this.flash('tape speed 1x');
    } else {
      this.pages[k] = (this.pages[k] + 1) % NUM_PAGES[k];
    }
    this.applyDraw();
    this.touched(k);
  }

  /** 0..1 position of what the knob controls now (for its ring). */
  norm(k) {
    const { ev } = this;
    const pg = this.pages[k];
    if (this.menuOpen) {
      if (k === 0) return pg === 0 ? ev[0][0] : this.local.pan;
      if (k === 3) return [this.delayTime, this.warble, this.resonance][pg];
      if (k === 5) return this.finalComp;
    }
    return ev[pg][k];
  }

  valueText(k) {
    const { ev } = this;
    const pg = this.pages[k];
    if (this.menuOpen) {
      if (k === 0) return pg === 0 ? fmtSpeed(knobToSpeed(ev[0][0])) : `pan ${Math.round((this.local.pan - 0.5) * 200)}`;
      if (k === 3) return pct([this.delayTime, this.warble, this.resonance][pg]);
      if (k === 5) return pct(this.finalComp);
    }
    if (k === 0 && pg === 0) return fmtSpeed(knobToSpeed(ev[0][0]));
    if (k === 4) {
      const l = this.looper();
      return l.playing ? `${l.reverse ? 'rev ' : ''}${(l.pitch || 1).toFixed(2)}x` : 'scrub';
    }
    return pct(ev[pg][k]);
  }

  /** For the LED display when a knob moves. */
  readout(k) {
    const knob = this.KNOBS[k];
    const pg = this.pages[k];
    const bipolar = (k === 0 && (pg === 0 || this.menuOpen)) || (k === 4 && this.looper().playing);
    return {
      title: `${knob.name}${knob.pages.length > 1 ? ` p${pg + 1}` : ''}`,
      sub: this.fn(k).label,
      value: this.valueText(k),
      norm: k === 4 && !this.looper().playing ? -1 : clamp(this.norm(k)),
      bipolar,
    };
  }

  /** The knob's LED colour, as NormalPage::Draw (and MenuPage::Draw in shift) light it. */
  ledColor(k, vu = 0) {
    const now = performance.now();
    const f = this.ledFlash[k];
    if (f && now < f.until) return f.c;
    const { ev } = this;
    const pg = this.pages[k];
    const s = this.st();
    const sw = this.switchDown;
    if (this.menuOpen) {
      if (k === 0) return pg === 0 ? quad(COL.medBlue, COL.green, COL.yellow, COL.red, tri(ev[0][0])) : triple(COL.purple, COL.off, COL.yellow, this.local.pan);
      if (k === 3) return gray([this.delayTime, this.warble, this.resonance][pg]);
      if (k === 5) {
        if (this.inputToggled) return [COL.orange, COL.blue, COL.yellow][s.monitor ?? 1];
        return scale(COL.medBlue, this.finalComp * 0.9 + 0.1);
      }
    }
    switch (k) {
      case 0: if (!sw) return COL.off; return pg === 0 ? quad(COL.medBlue, COL.green, COL.yellow, COL.red, tri(ev[0][0])) : triple(COL.blue, COL.pink, COL.red, ev[1][0]);
      case 1: if (!sw) return COL.off; return pg === 0 ? mix(COL.yellow, COL.orange, ev[0][1]) : mix(scale(COL.purple, 0.2), COL.purple, ev[1][1]);
      case 2: if (!sw) return COL.off; return pg === 0 ? mix(COL.orange, COL.red, ev[0][2]) : mix(scale(COL.purple, 0.2), COL.purple, ev[1][2]);
      case 3: if (!sw) return COL.off; return pg === 0 ? triple(COL.teal, COL.medBlue, COL.blue, ev[0][3]) : pg === 1 ? triple(COL.yellow, COL.orange, COL.red, ev[1][3]) : triple(COL.purple, COL.pink, COL.white, ev[2][3]);
      case 4: {
        const l = this.looper();
        if (l.empty) return COL.off;
        if (l.playing) return scale(quad(COL.medBlue, COL.green, COL.yellow, COL.red, tri(ev[0][4])), sw ? 1 : REC_DIM);
        return gray(Math.abs((l.scrub || 0) * 0.5));
      }
      case 5: return pg === 0 ? scale(quad([0.1, 0.1, 0.1], COL.green, COL.yellow, COL.pink, s.vuOut || vu), ev[0][5]) : mix(COL.blue, COL.red, ev[1][5]);
      default: return COL.off;
    }
  }

  // ------------------------------------------------------------ transport
  play(down) {
    if (this.menuOpen) { this.menuButton(33, down); return; }
    this.send(CMD.LOOPER_PLAY_BTN, down ? 1 : 0);
  }

  loop(down) {
    if (this.menuOpen) { this.menuButton(34, down); return; }
    if (!this.recording()) this.send(CMD.LOOPER_REC_BTN, down ? 1 : 0);
  }

  /** Play / loop / star key LEDs (NormalPage::Draw, MenuPage::Draw). */
  transportLeds(now) {
    const l = this.looper();
    const s = this.st();
    const sw = this.switchDown;
    const dim = (c) => (sw ? c : scale(c, REC_DIM));
    let play;
    let loop;
    let star;
    const blink300 = Math.floor(now / 300) % 2 === 0;
    const blink250 = Math.floor(now / 250) % 2 === 0;
    if (this.menuOpen && this.preset === 'none') {
      play = gray(l.dubGain ?? 0);
      loop = play;
    } else if (this.menuOpen && (this.preset === 'copy-src' || this.preset === 'copy-dest')) {
      if (this.selected === TAPE) play = COL.blue;
      else if (this.copySrc === TAPE) play = COL.green;
      else if (!blink250) play = COL.off;
      else if (l.empty && this.preset === 'copy-dest') play = gray(0.4);
      else if (!l.empty) play = scale(COL.pink, 0.4);
      else play = COL.off;
      loop = play;
    } else if (this.menuOpen) {
      play = COL.off; loop = COL.off;
    } else {
      if (l.empty && !l.armed) play = COL.off;
      else if (l.armed) play = COL.white;
      else if (l.firstRec && l.recording) play = COL.teal;
      else if (l.playing) play = scale(COL.teal, 1 - (l.position || 0));
      else play = gray(1 - (l.position || 0));
      play = dim(play);
      if (l.empty && !l.armed) loop = COL.off;
      else if (l.armed) loop = blink300 ? COL.red : COL.off;
      else if (l.firstRec && l.recording) loop = COL.red;
      else if (l.recording) loop = scale(COL.yellow, l.position || 0);
      else loop = gray(l.position || 0);
      loop = dim(loop);
    }
    if (this.menuOpen) {
      if (this.shiftHeld && this.preset === 'none') star = COL.chompi;
      else if (['save', 'erase', 'copy-dest'].includes(this.preset) && this.selected !== SLOT_NONE) star = blink250 ? COL.red : COL.off;
      else if (['saving', 'copying', 'erasing'].includes(this.preset)) star = blink250 ? COL.white : COL.off;
      else star = COL.off;
    } else if (!sw) {
      if (s.copying) star = blink300 ? COL.pink : COL.off;
      else if (this.recording()) star = COL.red;
      else star = quad([0.1, 0.1, 0.1], COL.green, COL.yellow, COL.pink, s.vuIn || 0);
    } else {
      star = this.shiftHeld ? COL.chompi : COL.off;
    }
    return { play, loop, star };
  }

  // ------------------------------------------------------------ mode switch + star key
  setSwitch(down) {
    // NormalPage::SetSwitchState: flipping back down ends a recording
    if (down && !this.switchDown && this.recording() && !this.st().copying) this.stopVoiceRecording();
    this.switchDown = down;
    if (!down) this.latched = false;
    this.applyDraw();
    this.changed();
  }

  stopVoiceRecording() {
    const { ev } = this;
    ev[0][0] = DEFAULTS[0][0]; ev[0][1] = DEFAULTS[0][1]; ev[0][2] = DEFAULTS[0][2];
    ev[1][0] = DEFAULTS[1][0]; ev[1][1] = DEFAULTS[1][1]; ev[1][2] = DEFAULTS[1][2];
    this.t.cmd(CMD.RECORD_STOP);
    // StopRecording drops back to JAMMI on the fresh recording (slot 15)
    Object.assign(this.local, { rec: false, mode: MODE.JAMMI, slot: 15 });
    this.touch();
    this.sent[CMD.GAIN] = undefined; this.sent[CMD.ATTACK] = undefined; this.sent[CMD.DECAY] = undefined;
  }

  /** The star key: shift (switch down) or record (switch up). */
  star(down) {
    if (!this.switchDown) {
      // NormalPage KEY_26 with the switch up: hold to record (record latch off)
      this.starHeld = down;
      const rec = this.recording();
      if (down && !rec) {
        this.t.cmd(CMD.RECORD_START);
        this.local.rec = true;
        this.touch();
      } else if (!down && rec) {
        this.stopVoiceRecording();
        this.flash('recorded: play it');
      }
      this.changed();
      return;
    }
    if (down) {
      if (this.menuOpen && this.selected !== SLOT_NONE && ['save', 'copy-dest', 'erase'].includes(this.preset)) {
        this.starHeld = true;
        this.starUsed = true;
        this.confirm();
        this.changed();
        return;
      }
      this.starHeld = true;
      this.starDownAt = performance.now();
      this.starUsed = false;
      this.openMenu();
    } else {
      // a quick tap with nothing else done toggles the shift latch (a Chompfe convenience)
      const tap = performance.now() - this.starDownAt < 300 && !this.starUsed;
      this.starHeld = false;
      if (tap) this.latched = !this.latched;
    }
    this.changed();
  }

  setKbdShift(on) { if (this.kbdShift !== on) { this.kbdShift = on; if (on && this.switchDown) this.openMenu(); this.changed(); } }

  /** MenuPage KEY_26 with a slot picked: start the save / copy / erase. */
  confirm() {
    const sel = this.selected;
    this.t.cmd(CMD.STOP_ALL);
    if (this.preset === 'save') {
      this.t.copy({ src: 15, srcBank: 0, srcMode: 0, dest: sel, destBank: this.ssBank, destMode: this.ssMode, set: sel !== TAPE, chompi: 1, looper: sel === TAPE ? 2 : 0 });
      this.preset = 'saving';
      if (sel !== TAPE) this.presetSet(this.ssMode, this.ssBank, sel, this.presets.chompi);
    } else if (this.preset === 'copy-dest') {
      let chompi = 0;
      let looper = 0;
      if (this.copySrc === 15) chompi = 1; else if (this.copySrc === TAPE) looper = 1;
      if (sel === 15) chompi = 2; else if (sel === TAPE) looper = 2;
      const set = sel !== TAPE && !(sel === 15 && this.ssMode === MODE.CUBBI);
      this.t.copy({ src: this.copySrc, srcBank: this.csBank === SLOT_NONE ? 0 : this.csBank, srcMode: this.csMode > 1 ? 0 : this.csMode, dest: sel, destBank: this.ssBank, destMode: this.ssMode, set, chompi, looper });
      this.preset = 'copying';
      if (this.copySrc <= 15 && sel <= 15) {
        const v = this.presetGet(this.csMode, this.csBank, this.copySrc);
        if (v) this.presetSet(this.ssMode, this.ssBank, sel, v.slice());
      }
    } else if (this.preset === 'erase') {
      this.t.cmd(CMD.ERASE, sel, this.ssBank);
      this.preset = 'erasing';
      if (sel < 15) delete this.presets.v[`${this.ssMode}:${this.ssBank}:${sel}`];
      this.savePresetsSoon();
    }
    this.blinkStart = performance.now();
    this.dispatchEvent(new CustomEvent('cardchange', { detail: { mode: this.ssMode, bank: this.ssBank } }));
  }

  // ------------------------------------------------------------ keys
  /** A keybed key by index 0..24 (MIDI 48..72). */
  keyDown(i, vel = 127) {
    const note = 48 + i;
    const b = NOTE_TO_BUTTON[note];
    if (b === undefined) return;
    if (this.menuOpen) {
      this.starUsed = true;
      if (this.menuButton(b, true)) { this.changed(); return; }
    }
    this.normalKey(b, note, true, vel);
    this.keyDownAt.set(i, b);
  }

  keyUp(i) {
    const note = 48 + i;
    const b = NOTE_TO_BUTTON[note];
    if (b === undefined) return;
    if (this.menuOpen && this.menuButton(b, false)) return;
    this.normalKey(b, note, false);
    this.keyDownAt.delete(i);
  }

  /** Tap keybed key i with shift held: the shift function printed on it. */
  shiftTap(i) {
    const was = this.kbdShift;
    this.setKbdShift(true);
    this.keyDown(i);
    this.keyUp(i);
    this.setKbdShift(was);
  }

  /** A MIDI note (24..72), as ui.h ProcessMidi maps them onto the keys. */
  midiNote(note, down, vel = 100) {
    const key = note - 24;
    if (key < 0 || key > 48) return;
    const b = MIDI2KEY[key];
    if (down && this.vmode() === MODE.CUBBI) {
      const slot = buttonToSlot(b);
      if (!slot) return;
      this.openCubbiSlot(slot);
    }
    this.t.key(note, down, down ? vel + 1 : 127, b);
  }

  /** NormalPage default branch: a key plays. */
  normalKey(b, note, down, vel = 127) {
    if (down) {
      if (this.vmode() === MODE.CUBBI) {
        const slot = buttonToSlot(b);
        if (!slot) return;
        this.openCubbiSlot(slot);
      }
      this.t.key(note, true, vel, b);
    } else {
      this.t.key(note, false, 127, b);
    }
  }

  /** MenuPage::OnButton for keys and play/loop. Returns true when handled. */
  menuButton(b, rising) {
    if (b === BTN.JAMMI || b === BTN.CUBBI) {
      if (!rising) return false;
      const mode = b === BTN.JAMMI ? MODE.JAMMI : MODE.CUBBI;
      if (this.vmode() === mode) {
        this.t.cmd(CMD.INCREMENT_BANK);
        this.local.bank[mode] = (this.bank() + 1) % 5;
        if (mode === MODE.CUBBI) this.t.cmd(CMD.STOP_ALL);
      } else {
        this.t.cmd(CMD.VOICE_MODE, mode);
        this.local.mode = mode;
        this.touch();
        if (mode === MODE.JAMMI) {
          const vb = this.local.voiceBank;
          this.t.cmd(CMD.BANK, vb);
          this.local.bank[MODE.JAMMI] = vb;
          this.menuSetVoiceSlot(this.local.slot);
        }
        this.t.cmd(CMD.STOP_ALL);
      }
      this.touch();
      this.dispatchEvent(new CustomEvent('bank', { detail: { mode, bank: this.local.bank[mode] } }));
      this.flash(`${mode === MODE.JAMMI ? 'jammi' : 'cubbi'} bank ${'abcde'[this.local.bank[mode]]}`);
      return true;
    }
    if (b === BTN.MIC || b === BTN.LINE || b === BTN.RESAMPLE) {
      if (!rising) return false;
      const src = b === BTN.MIC ? INPUT.MIC : b === BTN.LINE ? INPUT.LINE : INPUT.RESAMPLE;
      this.t.cmd(CMD.INPUT_SOURCE, src);
      this.dispatchEvent(new CustomEvent('input', { detail: src }));
      this.flash(`input: ${['mic', 'line in', 'resample'][src]}`);
      return true;
    }
    if (b === BTN.FX_PRE || b === BTN.FX_POST) {
      if (!rising) return false;
      this.t.cmd(CMD.FX_PRE_LOOPER, b === BTN.FX_PRE ? 1 : 0);
      this.flash(b === BTN.FX_PRE ? 'fx before the tape' : 'fx after the tape');
      return true;
    }
    if (b === BTN.ERASE) {
      if (!rising) return false;
      if (this.preset === 'none') this.preset = 'erase';
      else if (this.preset === 'erase') this.preset = 'none';
      else return true;
      this.selected = SLOT_NONE; this.ssBank = SLOT_NONE; this.ssMode = 2;
      return true;
    }
    if (b === BTN.COPY) {
      if (!rising) return false;
      if (this.preset === 'none') this.preset = 'copy-src';
      else if (this.preset === 'copy-src' || this.preset === 'copy-dest') this.preset = 'none';
      else return true;
      this.copySrc = SLOT_NONE; this.selected = SLOT_NONE; this.ssBank = SLOT_NONE; this.csBank = SLOT_NONE; this.ssMode = 2; this.csMode = 2;
      return true;
    }
    if (b === BTN.SAVE) {
      if (!rising) return false;
      if (!this.fileExists(14)) { this.flash('record something first'); return true; }
      if (this.preset === 'none') this.preset = 'save';
      else if (this.preset === 'save') this.preset = 'none';
      else return true;
      this.copySrc = SLOT_NONE; this.selected = SLOT_NONE; this.ssBank = SLOT_NONE; this.csBank = SLOT_NONE; this.ssMode = 2; this.csMode = 2;
      return true;
    }

    // white keys, play / loop
    if ((b === 33 || b === 34) && this.preset === 'none') this.t.cmd(CMD.LOOPER_DUB_GAIN, b === 33 ? -0.1 : 0.1);
    if (!rising) return !(b < 29);
    let slot = buttonToSlot(b);
    if (b === 33 || b === 34) slot = TAPE;
    if (!slot) return true;
    const bank = this.bank();
    const mode = this.vmode();
    const l = this.looper();
    if (slot === TAPE) {
      if (this.preset === 'copy-dest' && this.copySrc !== TAPE) { this.selected = slot; this.ssBank = bank; this.ssMode = mode; }
      else if (this.preset === 'copy-src' && !l.empty) { this.copySrc = slot; this.csBank = bank; this.csMode = mode; this.preset = 'copy-dest'; }
    } else if (this.preset === 'copy-src' && this.fileExists(slot - 1)) {
      this.copySrc = slot; this.csBank = bank; this.csMode = mode; this.preset = 'copy-dest';
    } else if (this.preset === 'copy-dest' && (this.copySrc !== slot || bank !== this.csBank || mode !== this.csMode)) {
      this.ssBank = bank; this.ssMode = mode; this.selected = slot;
    } else if (this.preset === 'none' && this.fileExists(slot - 1) && mode === MODE.JAMMI) {
      this.ssBank = bank; this.ssMode = mode; this.selected = slot;
      this.menuSetVoiceSlot(slot);
    } else if (this.preset === 'erase' && slot !== 15 && this.fileExists(slot - 1)) {
      this.ssBank = bank; this.ssMode = mode; this.selected = slot;
    } else if (this.preset === 'save' && slot !== 15) {
      this.ssBank = bank; this.ssMode = mode; this.selected = slot;
    }
    return true;
  }

  /** Display prompt while a card operation is in progress. */
  prompt() {
    if (!this.menuOpen) return null;
    const sel = this.selected;
    const picked = sel !== SLOT_NONE && this.ssBank !== SLOT_NONE;
    const name = picked ? slotName(this.ssBank, sel) : '';
    switch (this.preset) {
      case 'save': return picked ? [`save to ${name}?`, 'press * to save'] : ['save recording', 'pick a slot or tape'];
      case 'erase': return picked ? [`erase ${name}?`, 'press * to erase'] : ['erase', 'pick a slot'];
      case 'copy-src': return ['copy', 'pick a slot or tape'];
      case 'copy-dest': {
        const src = slotName(this.csBank === SLOT_NONE ? 0 : this.csBank, this.copySrc);
        return picked ? [`copy ${src} > ${name}?`, 'press * to copy'] : [`copy ${src} to`, 'pick a slot or tape'];
      }
      case 'saving': return ['saving', '...'];
      case 'copying': return ['copying', '...'];
      case 'erasing': return ['erasing', '...'];
      default: return null;
    }
  }

  // ------------------------------------------------------------ key LEDs
  /** LED colour for keybed key i, or null when dark. */
  keyLed(i, { now = performance.now() } = {}) {
    const note = 48 + i;
    const b = NOTE_TO_BUTTON[note];
    const s = this.st();
    const mode = this.vmode();
    if (this.menuOpen) return this.menuKeyLed(b, now);
    // NormalPage::Draw
    const slot = buttonToSlot(b);
    let color = COL.pink;
    if (this.voiceSlot() !== 15 || mode === MODE.CUBBI) color = BANK_COL[this.voiceBank()] || COL.purple;
    const playing = s.playing && s.playing.includes(note);
    const lit = this.switchDown || s.input !== INPUT.MIC;
    if (playing) return COL.white;
    if (mode === MODE.CUBBI && lit) {
      if (slot && this.fileExists(slot - 1) && b === 28) return scale(COL.pink, 0.25);
      if (slot && this.fileExists(slot - 1)) return scale(color, 0.25);
      return null;
    }
    if (mode === MODE.JAMMI && (b === 15 || b === 18 || b === 28) && lit) return scale(color, 0.25);
    return null;
  }

  menuKeyLed(b, now) {
    const s = this.st();
    const mode = this.vmode();
    const bank = this.bank();
    const keyColor = BANK_COL[bank] || COL.yellowGreen;
    const blink = Math.floor(now / 250) % 2 === 0;
    const p = this.preset;
    switch (b) {
      case BTN.JAMMI: return mode === MODE.JAMMI ? keyColor : null;
      case BTN.CUBBI: return mode === MODE.CUBBI ? keyColor : null;
      case BTN.MIC: case BTN.LINE: case BTN.RESAMPLE: {
        const src = { [BTN.MIC]: INPUT.MIC, [BTN.LINE]: INPUT.LINE, [BTN.RESAMPLE]: INPUT.RESAMPLE }[b];
        return s.input === src ? [COL.pink[0], 0.7 * COL.pink[1], 0.7 * COL.pink[2]] : null;
      }
      case BTN.FX_PRE: return s.fxPre ? COL.yellow : null;
      case BTN.FX_POST: return s.fxPre ? null : COL.yellow;
      case BTN.ERASE: return ['erase', 'erasing', 'none'].includes(p) ? COL.red : null;
      case BTN.COPY: return ['copy-src', 'copy-dest', 'copying', 'none'].includes(p) ? COL.green : null;
      case BTN.SAVE: return ['save', 'saving', 'none'].includes(p) ? (this.fileExists(14) ? COL.blue : gray(0.1)) : null;
      default: break;
    }
    const i = buttonToSlot(b);
    if (!i) return null;
    const here = this.ssBank === bank && this.ssMode === mode && this.selected === i;
    if (p === 'save' && i === 15) return COL.pink;
    if (here && p === 'save') return COL.blue;
    if (here && p === 'erase') return COL.red;
    if (here && p === 'copy-dest') return COL.blue;
    if ((here && p === 'copy-src') || (this.csBank === bank && this.copySrc === i && p === 'copy-dest' && this.csMode === mode)) return COL.green;
    if (((bank === this.voiceBank() && this.voiceSlot() === i) || (this.voiceSlot() === 15 && i === 15)) && p === 'none' && mode === MODE.JAMMI) return COL.white;
    if (['save', 'erase', 'copy-src', 'copy-dest'].includes(p)) {
      if (!blink) return null;
      if (p === 'erase' && i === 15) return null;
      if (i === 15 && this.fileExists(i - 1)) return scale(COL.pink, 0.4);
      if (this.fileExists(i - 1)) return scale(keyColor, 0.4);
      if (p === 'save' || p === 'copy-dest') return gray(0.4);
      return null;
    }
    if (i === 15 && this.fileExists(14)) return COL.pink;
    if (this.fileExists(i - 1)) return keyColor;
    return null;
  }

  /** What the display names the current sound. */
  soundLabel() {
    const mode = this.vmode();
    if (mode === MODE.CUBBI) return `cubbi ${'abcde'[this.bank()]}`;
    const slot = this.voiceSlot();
    return slot === 15 ? 'jammi rec' : `jammi ${'abcde'[this.voiceBank()]}${slot}`;
  }
}

function loadPresets() {
  try {
    const p = JSON.parse(localStorage.getItem(STORE));
    if (p && typeof p === 'object' && p.v) return p;
  } catch { /* ignore */ }
  return { chompi: null, v: {} };
}
