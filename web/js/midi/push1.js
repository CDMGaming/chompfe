// Ableton Push (1st generation) profile.
//
// MIDI facts below come from Ableton's own Push remote script (Live 9/10,
// "Push/sysex.py" and "pushbase/elements.py", "pushbase/colors.py"):
//   SysEx header      F0 47 7F 15
//   LCD write line n  F0 47 7F 15 <18+n> 00 45 00 <68 ASCII bytes> F7   (n = 0..3)
//   LCD clear line n  F0 47 7F 15 <1C+n> 00 00 F7
//   Pads              notes 36..99 on ch 1; pad (row from top r, col c) = 36 + (7-r)*8 + c
//   Encoders 1-8      CC 71..78, relative two's complement; touch = notes 0..7
//   Tempo / swing / master encoders  CC 14 / 15 / 79 (touch notes 10 / 9 / 8)
//   Upper button row  CC 20..27 (bi-colour LEDs)   Lower row CC 102..109 (RGB)
//   Scene buttons     CC 43 (top) .. 36 (bottom)
//   Play 85, Record 86, Tap tempo 3, Mute 60, Delete 118, Shift 49, Scale 58,
//   Note 50, Session 51, Octave down/up 54/55, Arrows left/right 44/45
//   RGB colours (pads, lower row): 0 off, 1 dark grey, 2 grey, 3 white, 5 red,
//     9 amber, 13 yellow, 17 lime, 21 green, 29 turquoise, 37 sky, 45 blue,
//     49 orchid, 53 magenta, 57 pink; +1/+2 = dimmer shades of the same hue
//   Bi-colour buttons: red 4/1, amber 10/7, yellow 16/13, green 22/19 (full/half)
//   Single-colour buttons: 0 off, 1 dim, 4 full
import { ROOTS, SCALES, padNote, inScale } from '../scales.js';
import { CLOCK_DIVS } from '../params.js';

export const id = 'push1';
export const label = 'Push 1';

// "Ableton Push" (Windows), "Ableton Push Live Port" (macOS). The second port
// ("User Port" / "MIDIIN2 (Ableton Push)") is left alone, and Push 2 isn't this.
const isPush1 = (n) => /ableton push/i.test(n) && !/push\s*2/i.test(n);
const isUserPort = (n) => /user port|midiin2|midiout2|push midi 2/i.test(n); // Windows / macOS / Linux names
export function match(name) { return isPush1(name) && !isUserPort(name); }
export function ignore(name) { return isPush1(name) && isUserPort(name); }

const SYSEX = [0xf0, 0x47, 0x7f, 0x15];
const LCD_WIDTH = 68;
// 8 encoder columns over 68 characters: 8,9,8,9,... wide (each 17-char block
// of the LCD sits over two encoders)
const COL_START = [0, 8, 17, 25, 34, 42, 51, 59, 68];

const CC = {
  play: 85, record: 86, tap: 3, mute: 60, del: 118, shift: 49, scale: 58,
  note: 50, session: 51, octDown: 54, octUp: 55, left: 44, right: 45,
  tempo: 14, swing: 15, master: 79,
};
const RGB = { off: 0, dark: 1, grey: 2, white: 3, red: 5, amber: 9, yellow: 13, lime: 17, green: 21, turq: 29, sky: 37, blue: 45, orchid: 49, magenta: 53, pink: 57 };
const dim = (c, level = 2) => (c >= 5 ? c + level : c === RGB.white ? RGB.grey : RGB.dark);

// Encoder-detent amounts. Push encoders send small relative steps, many per turn.
const TICK = 1 / 220;
const FINE_TICK = 1 / 1100;
const STEPPED_TICKS = 4; // detents per step for stepped params (table, frame, ...)

export function create({ output, api, sysex }) {
  const { P, BY_ID } = api;
  const send = (bytes) => { try { output && output.send(bytes); } catch { /* port went away */ } };

  // ---------------------------------------------------------- local state
  let mode = 'session'; // 'session' = steps on top + keys below; 'note' = 8x8 keys
  let page = 0;
  let shift = false;
  let del = false;
  let root = 0;
  let scaleIdx = 0;
  let inKey = true;
  let padOct = 4; // bottom-left pad = root + 12 * padOct (48 = C3 by default)
  const accum = new Map();
  const padsDown = new Map(); // pad note -> { kind: 'step'|'key', i?, note?, consumed? }
  let heldStep = -1;

  // ---------------------------------------------------------- virtual params
  // Things that aren't engine parameters but live on encoder pages.
  const v = {
    len: { short: 'LENGTH', hue: RGB.green, stepped: true,
      get: () => api.seq.length, set: (n) => api.seq.setLength(Math.round(Math.max(0, Math.min(32, n)))),
      fmt: (n) => `${n} steps`, min: 0, max: 32, step: 1, def: 0 },
    out: { short: 'OUT', hue: RGB.white,
      get: () => api.getOutDb(), set: (d) => api.setOutDb(Math.max(0, Math.min(30, d))),
      fmt: (d) => `+${d.toFixed(1)}dB`, min: 0, max: 30, step: 0.5, def: 18 },
    root: { short: 'ROOT', hue: RGB.blue, stepped: true,
      get: () => root, set: (n) => { root = ((Math.round(n) % 12) + 12) % 12; },
      fmt: (n) => ROOTS[n], min: 0, max: 11, step: 1, def: 0, wrap: true },
    scale: { short: 'SCALE', hue: RGB.blue, stepped: true,
      get: () => scaleIdx, set: (n) => { scaleIdx = Math.max(0, Math.min(SCALES.length - 1, Math.round(n))); },
      fmt: (n) => SCALES[n].name, min: 0, max: SCALES.length - 1, step: 1, def: 0 },
    inkey: { short: 'LAYOUT', hue: RGB.blue, stepped: true, toggle: true,
      get: () => (inKey ? 1 : 0), set: (n) => { inKey = n > 0.5; },
      fmt: (n) => (n ? 'in key' : 'chromatc'), min: 0, max: 1, step: 1, def: 1 },
    padoct: { short: 'PAD OCT', hue: RGB.blue, stepped: true,
      get: () => padOct, set: (n) => { padOct = Math.max(1, Math.min(7, Math.round(n))); },
      fmt: (n) => `C${n - 1}`, min: 1, max: 7, step: 1, def: 4 },
  };

  const HUE = {
    [P.TABLE]: RGB.lime, [P.FRAME]: RGB.lime, [P.PITCH]: RGB.lime, [P.OCTAVE]: RGB.lime,
    [P.CUTOFF]: RGB.red, [P.RESONANCE]: RGB.red,
    [P.ATTACK]: RGB.yellow, [P.RELEASE]: RGB.yellow,
    [P.FILTER_LFO_DEPTH]: RGB.sky, [P.FILTER_LFO_RATE]: RGB.sky, [P.FILTER_LFO_ON]: RGB.sky,
    [P.PITCH_LFO_DEPTH]: RGB.turq, [P.PITCH_LFO_RATE]: RGB.turq, [P.PITCH_LFO_ON]: RGB.turq,
    [P.FX]: RGB.orchid, [P.FX_TIME]: RGB.orchid,
    [P.DRIVE]: RGB.white, [P.GAIN]: RGB.white, [P.PAN]: RGB.white,
    [P.TEMPO]: RGB.green, [P.CLOCK_DIV]: RGB.green, [P.GATE]: RGB.green,
  };
  const GATES = [0.1, 0.5, 1];

  // A slot is either an engine param id (number) or a virtual key (string).
  const PAGES = [
    { name: 'Sound', slots: [P.TABLE, P.FRAME, P.PITCH, P.CUTOFF, P.RESONANCE, P.ATTACK, P.RELEASE, P.FX] },
    { name: 'Motion', slots: [P.FILTER_LFO_DEPTH, P.FILTER_LFO_RATE, P.FILTER_LFO_ON, P.PITCH_LFO_DEPTH, P.PITCH_LFO_RATE, P.PITCH_LFO_ON, P.FX_TIME, P.OCTAVE] },
    { name: 'Out/Seq', slots: [P.DRIVE, P.GAIN, P.PAN, P.TEMPO, P.CLOCK_DIV, P.GATE, 'len', 'out'] },
    { name: 'Scale', slots: ['root', 'scale', 'inkey', 'padoct', null, null, null, null] },
  ];
  const SCALE_PAGE = 3;

  function slotInfo(slot) {
    if (slot === null) return null;
    if (typeof slot === 'string') return { ...v[slot], key: slot };
    const p = BY_ID[slot];
    const stepped = p.step >= 1 || slot === P.GATE;
    return {
      short: p.short, hue: HUE[slot] ?? RGB.white, stepped,
      toggle: p.min === 0 && p.max === 1 && p.step === 1,
      get: () => api.get(slot), set: (x) => api.set(slot, x), fmt: p.fmt,
      min: p.min, max: p.max, step: p.step, def: p.def, id: slot,
    };
  }

  function turn(slotIdx, ticks) {
    const s = slotInfo(PAGES[page].slots[slotIdx]);
    if (!s) return;
    if (s.id === P.GATE) { // three gate lengths, like the hardware
      stepAccum(`g`, ticks, (dir) => {
        const i = GATES.findIndex((g) => g >= api.get(P.GATE) - 1e-6);
        api.set(P.GATE, GATES[Math.max(0, Math.min(2, (i < 0 ? 1 : i) + dir))]);
      });
      return;
    }
    if (s.stepped) {
      const per = s.id === P.TEMPO ? 1 : STEPPED_TICKS;
      stepAccum(slotIdx + ':' + page, ticks, (dir) => {
        let n = s.get() + dir * s.step;
        if (s.wrap) n = ((n - s.min) % (s.max - s.min + 1) + (s.max - s.min + 1)) % (s.max - s.min + 1) + s.min;
        s.set(Math.max(s.min, Math.min(s.max, n)));
      }, per);
    } else {
      const range = s.max - s.min;
      s.set(Math.max(s.min, Math.min(s.max, s.get() + ticks * range * (shift ? FINE_TICK : TICK))));
    }
    scheduleRender();
  }

  function stepAccum(key, ticks, fn, per = STEPPED_TICKS) {
    let a = (accum.get(key) || 0) + ticks;
    while (Math.abs(a) >= per) {
      const dir = a > 0 ? 1 : -1;
      fn(dir);
      a -= per * dir;
    }
    accum.set(key, a);
  }

  function resetOrToggle(slotIdx) {
    const s = slotInfo(PAGES[page].slots[slotIdx]);
    if (!s) return;
    if (s.toggle) s.set(s.get() > 0.5 ? 0 : 1);
    else s.set(s.def);
    scheduleRender();
  }

  // ---------------------------------------------------------- pads
  const padIndex = (note) => note - 36; // 0..63, 0 = bottom-left
  const padRowFromTop = (idx) => 7 - Math.floor(idx / 8);
  const padCol = (idx) => idx % 8;
  const scale = () => SCALES[scaleIdx];
  const keyBase = () => root + 12 * padOct;

  function keyNoteForPad(idx) {
    const col = padCol(idx);
    const rowFromBottom = Math.floor(idx / 8);
    if (mode === 'note') return padNote(col, rowFromBottom, keyBase(), scale(), inKey);
    if (rowFromBottom > 3) return null; // top half is steps in session mode
    return padNote(col, rowFromBottom, keyBase(), scale(), inKey);
  }
  function stepForPad(idx) {
    if (mode !== 'session') return -1;
    const r = padRowFromTop(idx);
    return r < 4 ? r * 8 + padCol(idx) : -1;
  }

  function padPress(note, vel) {
    const idx = padIndex(note);
    const step = stepForPad(idx);
    if (step >= 0) {
      if (del) { api.seq.setStep(step, -1); return; }
      if (shift) { api.seq.setLength(step + 1); return; }
      padsDown.set(note, { kind: 'step', i: step, consumed: false });
      heldStep = step;
      scheduleRender();
      return;
    }
    const n = keyNoteForPad(idx);
    if (n === null || n < 0 || n > 127) return;
    if (heldStep >= 0) {
      // step entry: hold a step, hit a key
      api.seq.setStep(heldStep, n);
      for (const d of padsDown.values()) if (d.kind === 'step' && d.i === heldStep) d.consumed = true;
      api.preview(n);
      scheduleRender();
      return;
    }
    padsDown.set(note, { kind: 'key', note: n });
    api.noteOn(`push:${note}`, n, vel);
  }
  function padRelease(note) {
    const d = padsDown.get(note);
    padsDown.delete(note);
    if (!d) return;
    if (d.kind === 'key') api.noteOff(`push:${note}`);
    else {
      if (!d.consumed) api.seq.click(d.i);
      heldStep = [...padsDown.values()].find((x) => x.kind === 'step')?.i ?? -1;
      scheduleRender();
    }
  }

  // ---------------------------------------------------------- input
  function onMessage(d) {
    const st = d[0] & 0xf0;
    if (st === 0x90 || st === 0x80) {
      const note = d[1];
      const on = st === 0x90 && d[2] > 0;
      if (note >= 36 && note <= 99) on ? padPress(note, d[2]) : padRelease(note);
      else if (note <= 7 && on && del) resetOrToggle(note); // touch an encoder while Delete is held
      return;
    }
    if (st !== 0xb0) return;
    const cc = d[1];
    const val = d[2];
    const rel = val < 64 ? val : val - 128;
    const pressed = val > 0;

    if (cc >= 71 && cc <= 78) return turn(cc - 71, rel);
    if (cc === CC.tempo) { stepAccum('tempo', rel, (dir) => api.set(P.TEMPO, api.get(P.TEMPO) + dir), 1); return scheduleRender(); }
    if (cc === CC.swing) { stepAccum('frame', rel, (dir) => api.set(P.FRAME, api.get(P.FRAME) + dir), 2); return scheduleRender(); }
    if (cc === CC.master) { api.setOutDb(Math.max(0, Math.min(30, api.getOutDb() + rel * 0.5))); return scheduleRender(); }

    if (cc >= 20 && cc <= 27) {
      if (!pressed) return;
      const b = cc - 20;
      if (b < PAGES.length) page = b;
      else if (b === 4) api.presets.step(-1);
      else if (b === 5) api.presets.step(1);
      return scheduleRender();
    }
    if (cc >= 102 && cc <= 109) { if (pressed) resetOrToggle(cc - 102); return; }
    if (cc >= 36 && cc <= 43) {
      if (!pressed) return;
      const fromTop = 43 - cc;
      if (fromTop < 3) api.set(P.GATE, GATES[fromTop]);
      else api.set(P.CLOCK_DIV, fromTop - 3);
      return scheduleRender();
    }
    switch (cc) {
      case CC.play: api.play(pressed); break;
      case CC.record: api.loop(pressed); break;
      case CC.mute: api.rest(pressed); break;
      case CC.tap: if (pressed) api.tap(); break;
      case CC.shift: shift = pressed; break;
      case CC.del: del = pressed; break;
      case CC.note: if (pressed) { mode = 'note'; releaseAllPads(); } break;
      case CC.session: if (pressed) { mode = 'session'; releaseAllPads(); } break;
      case CC.scale: if (pressed) page = page === SCALE_PAGE ? 0 : SCALE_PAGE; break;
      case CC.octDown: if (pressed) padOct = Math.max(1, padOct - 1); break;
      case CC.octUp: if (pressed) padOct = Math.min(7, padOct + 1); break;
      case CC.left: if (pressed) page = (page + PAGES.length - 1) % PAGES.length; break;
      case CC.right: if (pressed) page = (page + 1) % PAGES.length; break;
      default: return;
    }
    scheduleRender();
  }

  function releaseAllPads() {
    for (const d of padsDown.values()) d.consumed = true; // a mode switch must not toggle steps
    for (const note of [...padsDown.keys()]) padRelease(note);
    heldStep = -1;
  }

  // ---------------------------------------------------------- output: LCD
  const lcdLast = ['', '', '', ''];
  const lcdChars = (str) => {
    // ASCII only; the Push charset has a few extras we don't need
    const s = str.replace(/±/g, '+-').replace(/[−–]/g, '-');
    const out = [];
    for (let i = 0; i < LCD_WIDTH; i++) {
      const c = s.charCodeAt(i);
      // 0x00-0x1F are Push glyphs (bar blocks etc.), 0x20-0x7E ASCII
      out.push(Number.isNaN(c) ? 32 : c < 127 ? c : 63);
    }
    return out;
  };
  function lcdLine(n, text) {
    if (!sysex || lcdLast[n] === text) return;
    lcdLast[n] = text;
    send([...SYSEX, 0x18 + n, 0x00, 0x45, 0x00, ...lcdChars(text), 0xf7]);
  }
  function lcdClear() {
    if (!sysex) return;
    for (let n = 0; n < 4; n++) { send([...SYSEX, 0x1c + n, 0x00, 0x00, 0xf7]); lcdLast[n] = ''; }
  }
  const fit = (s, w) => {
    s = String(s);
    if (s.length > w) s = s.slice(0, w);
    const pad = w - s.length;
    return ' '.repeat(Math.floor(pad / 2)) + s + ' '.repeat(Math.ceil(pad / 2));
  };
  function columns(cells) {
    let line = '';
    for (let i = 0; i < 8; i++) line += fit(cells[i] ?? '', COL_START[i + 1] - COL_START[i]);
    return line;
  }
  // Bar graph from the LCD's block characters: 0x05 full, 0x03 half, 0x06 empty
  function bar(t, w) {
    const halves = Math.round(Math.max(0, Math.min(1, t)) * 15) + 1; // 1..16 half-cells over 8 cells
    let s = '';
    for (let i = 0; i < 8; i++) {
      const h = halves - i * 2;
      s += h >= 2 ? '\x05' : h === 1 ? '\x03' : '\x06';
    }
    return (s + ' ').slice(0, w);
  }

  function renderLcd() {
    const slots = PAGES[page].slots.map(slotInfo);
    lcdLine(0, columns(slots.map((s) => (s ? s.short : ''))));
    lcdLine(1, columns(slots.map((s) => (s ? s.fmt(s.get()) : ''))));
    let l3 = '';
    slots.forEach((s, i) => {
      const w = COL_START[i + 1] - COL_START[i];
      if (!s || s.toggle) l3 += ' '.repeat(w);
      else l3 += bar((s.get() - s.min) / (s.max - s.min), w);
    });
    lcdLine(2, l3);
    const st = api.state();
    const pageNames = PAGES.map((p, i) => (i === page ? `>${p.name}` : p.name));
    const loop = `${st.seqRecording ? 'REC ' : ''}${st.seqPlaying ? '>' : ''}${st.seqLength ? `${st.seqPlaying ? st.seqIndex + 1 : '-'}/${st.seqLength}` : 'no loop'}`;
    const preset = api.presets.currentName();
    lcdLine(3, columns([...pageNames, '<snd', 'snd>', preset || (mode === 'note' ? 'NOTE' : 'SEQ'), loop]));
  }

  // ---------------------------------------------------------- output: LEDs
  const ledLast = new Map();
  function led(kind, num, value) {
    const k = kind + num;
    if (ledLast.get(k) === value) return;
    ledLast.set(k, value);
    send([kind === 'n' ? 0x90 : 0xb0, num, value]);
  }

  function renderLeds() {
    const st = api.state();
    const sounding = new Set(st.voices);
    const sc = scale();
    // pads
    for (let idx = 0; idx < 64; idx++) {
      const note = 36 + idx;
      let c = RGB.off;
      const step = stepForPad(idx);
      if (step >= 0) {
        const n = api.seq.steps[step];
        const inLoop = step < api.seq.length;
        if (step === heldStep) c = RGB.magenta;
        else if (st.seqPlaying && inLoop && step === st.seqIndex) {
          // the playhead stays bright only while the gate holds the note
          c = n >= 0 ? (st.seqGateOpen ? RGB.white : RGB.green) : RGB.grey;
        } else if (inLoop) c = n >= 0 ? dim(RGB.green, 1) : RGB.dark;
      } else {
        const n = keyNoteForPad(idx);
        if (n !== null) {
          const pressed = [...padsDown.values()].some((d) => d.kind === 'key' && d.note === n);
          if (pressed || sounding.has(n)) c = RGB.green;
          else if (((n - root) % 12 + 12) % 12 === 0) c = RGB.blue;
          else if (inScale(n, root, sc)) c = mode === 'note' ? RGB.white : RGB.grey;
          else c = RGB.off;
        }
      }
      led('n', note, c);
    }
    // upper row: pages, sound prev/next
    for (let b = 0; b < 8; b++) {
      let c = 0;
      if (b < PAGES.length) c = b === page ? 16 : 13; // yellow / yellow half
      else if (b === 4 || b === 5) c = 7; // amber half
      led('c', 20 + b, c);
    }
    // lower row: the button under each encoder (reset / toggle), in the param's colour
    PAGES[page].slots.forEach((slot, i) => {
      const s = slotInfo(slot);
      let c = RGB.off;
      if (s) c = s.toggle ? (s.get() > 0.5 ? s.hue : dim(s.hue)) : dim(s.hue, 1);
      led('c', 102 + i, c);
    });
    // scene buttons: gate x3, step length x5
    const gi = GATES.findIndex((g) => Math.abs(g - api.get(P.GATE)) < 1e-3);
    for (let k = 0; k < 8; k++) {
      const on = k < 3 ? k === gi : k - 3 === Math.round(api.get(P.CLOCK_DIV));
      led('c', 43 - k, on ? 4 : 1);
    }
    led('c', CC.play, st.seqPlaying ? 4 : 1);
    led('c', CC.record, st.seqRecording ? 4 : 1);
    led('c', CC.mute, st.seqMuted ? 4 : 1);
    led('c', CC.tap, 1);
    led('c', CC.note, mode === 'note' ? 4 : 1);
    led('c', CC.session, mode === 'session' ? 4 : 1);
    led('c', CC.scale, page === SCALE_PAGE ? 4 : 1);
    led('c', CC.octDown, padOct > 1 ? 1 : 0);
    led('c', CC.octUp, padOct < 7 ? 1 : 0);
    led('c', CC.left, 1);
    led('c', CC.right, 1);
    led('c', CC.shift, shift ? 4 : 1);
    led('c', CC.del, del ? 4 : 1);
  }

  let pending = 0;
  function scheduleRender() {
    if (pending) return;
    pending = setTimeout(() => {
      pending = 0;
      renderLcd();
      renderLeds();
    }, 16);
  }

  const offParam = api.on('param', scheduleRender);
  const offState = api.on('state', scheduleRender);
  const offPresets = api.on('presets', scheduleRender);

  lcdClear();
  scheduleRender();

  return {
    onMessage,
    // tell the scale page from outside (for tests) and the UI
    get info() { return { mode, page: PAGES[page].name, root: ROOTS[root], scale: scale().name, inKey, padOct }; },
    destroy(sendGoodbye) {
      offParam(); offState(); offPresets();
      clearTimeout(pending);
      releaseAllPads();
      if (sendGoodbye !== false) {
        // leave the hardware dark and blank
        for (let i = 36; i <= 99; i++) send([0x90, i, 0]);
        for (const cc of [...ledLast.keys()].filter((k) => k[0] === 'c')) send([0xb0, +cc.slice(1), 0]);
        lcdClear();
      }
    },
  };
}
