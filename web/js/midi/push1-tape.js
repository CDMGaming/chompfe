// Push 1 in TAPE mode. The same Push, relabelled for the TAPE firmware:
//   Encoders 1-6       TAPE's six knobs (Speed Start End Magic Tape Volume);
//                      hold Shift for their shift functions, as on the panel
//   Encoder 7          output level        Tempo encoder: the Tape knob
//   Buttons under 1-6  knob press (next page; with Shift: the knob's reset/toggle)
//   Button under 7     the mode switch (up = record mode)
//   Button under 8     wave -> tape bridge
//   Upper row 1-7      JAMMI CUBBI MIC LINE RESAMPLE FX-PRE FX-POST (shift functions)
//   Upper row 8        back to WAVE
//   Session mode, top half:
//     left 4x4         sound slots 1-15 + the tape: in JAMMI a tap picks the
//                      sound, in CUBBI it plays it (drum pads); while erasing /
//                      copying / saving it picks the slot
//     right, top row   ERASE COPY SAVE and the star key (confirm)
//   Bottom half / Note mode: keys, as in WAVE (scale, octave, layout)
//   Play / Record      PLAY / LOOP         Mute: the star key   Shift: shift
// LEDs come from the firmware's own key / knob colours, matched to the
// Push palette.

const WHITE_NOTES = [48, 50, 52, 53, 55, 57, 59, 60, 62, 64, 65, 67, 69, 71, 72]; // slots 1..15
const BLACK = { JAMMI: 1, CUBBI: 3, MIC: 6, LINE: 8, RESAMPLE: 10, FX_PRE: 13, FX_POST: 15, ERASE: 18, COPY: 20, SAVE: 22 }; // keybed index
const UPPER = [BLACK.JAMMI, BLACK.CUBBI, BLACK.MIC, BLACK.LINE, BLACK.RESAMPLE, BLACK.FX_PRE, BLACK.FX_POST];
const UPPER_NAMES = ['JAMMI', 'CUBBI', 'MIC', 'LINE', 'RESAMPL', 'FX PRE', 'FX POST', '> WAVE'];
const FUNC_PADS = [BLACK.ERASE, BLACK.COPY, BLACK.SAVE, 'star']; // right block, top row

// Push RGB palette (pushbase/colors.py), as unit colours, to match firmware colours
const PALETTE = [
  [5, [1, 0, 0]], [9, [1, 0.5, 0]], [13, [1, 1, 0]], [17, [0.55, 1, 0]], [21, [0, 1, 0]],
  [29, [0, 1, 0.8]], [37, [0, 0.6, 1]], [45, [0, 0, 1]], [49, [0.6, 0.1, 1]], [53, [1, 0, 1]], [57, [1, 0.35, 0.6]],
];

/** A firmware colour [r,g,b] 0..1 -> Push RGB pad value. */
export function pushColor(c) {
  if (!c) return 0;
  const m = Math.max(c[0], c[1], c[2]);
  if (m < 0.05) return 0;
  const n = c.map((x) => x / m);
  const shade = m > 0.6 ? 0 : m > 0.22 ? 1 : 2;
  if (Math.min(n[0], n[1], n[2]) > 0.7) return [3, 2, 1][shade]; // white / grey / dark
  let best = PALETTE[0];
  let bd = Infinity;
  for (const p of PALETTE) {
    const d = (p[1][0] - n[0]) ** 2 + (p[1][1] - n[1]) ** 2 + (p[1][2] - n[2]) ** 2;
    if (d < bd) { bd = d; best = p; }
  }
  return best[0] + shade;
}

export function createTapeLayer({ api, led, lcdLine, columns, fit, bar, CC }) {
  const ui = () => api.tape;
  const accum = new Map();
  let shift = false;
  const padsDown = new Map(); // pad note -> what it did

  function ticks(k, rel) {
    // the speed and tape knobs move a fine step per tick, the others 1/3 of a detent
    const per = k === 0 || k === 4 ? 1 : 3;
    let a = (accum.get(k) || 0) + rel;
    const d = Math.trunc(a / per);
    a -= d * per;
    accum.set(k, a);
    if (d) ui().turn(k, d);
  }

  /** Tap a keybed key with shift held (the firmware's shift functions). */
  const shiftTap = (idx) => ui().shiftTap(idx);

  // top-half pads in session mode: (row from top r < 4, col c)
  function topPad(r, c) {
    if (c < 4) {
      const n = r * 4 + c; // 0..15
      return n < 15 ? { kind: 'slot', slot: n + 1 } : { kind: 'tape' };
    }
    if (r === 0) return { kind: 'func', what: FUNC_PADS[c - 4] };
    return null;
  }

  function padPress(note, r, c, vel) {
    const t = ui();
    const p = topPad(r, c);
    if (!p) return true;
    if (p.kind === 'slot') {
      const idx = WHITE_NOTES[p.slot - 1] - 48;
      const st = api.tapeState() || {};
      if (t.menuOpen) { t.keyDown(idx); padsDown.set(note, { idx, menu: true }); }
      else if (st.mode === 1) { t.keyDown(idx, vel); padsDown.set(note, { idx }); } // CUBBI: drum pad
      else shiftTap(idx); // JAMMI: pick the sound
    } else if (p.kind === 'tape') {
      if (t.menuOpen) { t.play(true); padsDown.set(note, { tape: true }); }
    } else if (p.what === 'star') {
      t.star(true);
      padsDown.set(note, { star: true });
    } else {
      shiftTap(p.what);
    }
    return true;
  }

  function padRelease(note) {
    const d = padsDown.get(note);
    padsDown.delete(note);
    if (!d) return;
    const t = ui();
    if (d.star) t.star(false);
    else if (d.tape) t.play(false);
    else if (d.idx !== undefined) t.keyUp(d.idx);
  }

  /** Returns true when the message was TAPE's to handle. */
  function onMessage(d, { padRowFromTop, padCol, sessionTop }) {
    const t = ui();
    const st = d[0] & 0xf0;
    if (st === 0x90 || st === 0x80) {
      const note = d[1];
      const on = st === 0x90 && d[2] > 0;
      if (note >= 36 && note <= 99) {
        const idx = note - 36;
        const r = padRowFromTop(idx);
        if (sessionTop && r < 4) {
          if (on) padPress(note, r, padCol(idx), d[2]);
          else padRelease(note);
          return true;
        }
        return false; // keys: the WAVE layout's own key pads, routed to TAPE by the app
      }
      return note <= 10; // encoder touches: nothing to do
    }
    if (st !== 0xb0) return false;
    const cc = d[1];
    const val = d[2];
    const rel = val < 64 ? val : val - 128;
    const pressed = val > 0;
    if (cc >= 71 && cc <= 76) { ticks(cc - 71, rel); return true; }
    if (cc === 77) { api.setOutDb(Math.max(0, Math.min(30, api.getOutDb() + rel * 0.5))); return true; }
    if (cc === 78) return true;
    if (cc === CC.tempo) { ticks(4, rel); return true; }
    if (cc === CC.swing) return true;
    if (cc >= 102 && cc <= 107) { if (pressed) t.press(cc - 102); return true; }
    if (cc === 108) { if (pressed) t.setSwitch(!t.switchDown); return true; }
    if (cc === 109) { if (pressed) api.setBridge(!api.bridge()); return true; }
    if (cc >= 20 && cc <= 27) {
      if (!pressed) return true;
      const b = cc - 20;
      if (b < 7) shiftTap(UPPER[b]);
      else api.setEngine('wave');
      return true;
    }
    if (cc >= 36 && cc <= 43) return true; // scene buttons: unused in TAPE
    if (cc === CC.shift) { shift = pressed; t.setKbdShift(pressed); return true; }
    if (cc === CC.tap || cc === CC.del) return true;
    return false; // play / record / mute go through the api; note / session / scale / octave as in WAVE
  }

  function renderLcd() {
    const t = ui();
    const ts = api.tapeState();
    if (!ts) {
      lcdLine(0, columns(['TAPE', '', '', '', '', '', '', '']));
      lcdLine(1, columns(['waking', 'up...', '', '', '', '', '', '']));
      lcdLine(2, ' '.repeat(68));
      lcdLine(3, ' '.repeat(68));
      return;
    }
    const names = t.KNOBS.map((k) => k.name.toUpperCase());
    lcdLine(0, columns([...names, 'OUT', t.switchDown ? '' : 'REC MODE']));
    const ro = [0, 1, 2, 3, 4, 5].map((k) => t.readout(k));
    lcdLine(1, columns([...ro.map((r) => r.value), `+${api.getOutDb().toFixed(1)}dB`, api.bridge() ? 'BRIDGE' : '']));
    let l2 = '';
    ro.forEach((r, i) => {
      const w = [8, 9, 8, 9, 8, 9][i];
      l2 += t.menuOpen || r.norm < 0 ? fit(r.sub, w) : bar(r.norm, w);
    });
    l2 += fit(t.menuOpen ? 'SHIFT' : '', 8) + fit(t.latched ? 'latched' : '', 9);
    lcdLine(2, l2);
    const prompt = t.prompt();
    if (prompt) {
      lcdLine(3, fit(`${prompt[0]}  -  ${prompt[1]}`, 68));
      return;
    }
    const l = ts.looper;
    const tape = l.empty ? 'tape empty' : `${l.recording ? (l.firstRec ? 'REC' : 'DUB') : l.playing ? 'PLAY' : 'PAUSE'} ${Math.round(l.position * 100)}%`;
    lcdLine(3, columns([t.soundLabel(), '', ['mic', 'line in', 'resample'][ts.input] || '', ts.fxPre ? 'fx>tape' : 'tape>fx', tape, '', t.recording() ? 'RECORDING' : '', '']));
  }

  function renderLeds({ sessionTop, keyLedFor }) {
    const t = ui();
    const now = performance.now();
    const ts = api.tapeState() || {};
    for (let idx = 0; idx < 64; idx++) {
      const note = 36 + idx;
      const r = 7 - Math.floor(idx / 8);
      const c = idx % 8;
      if (sessionTop && r < 4) {
        const p = topPad(r, c);
        let col = 0;
        if (p && p.kind === 'slot') {
          col = pushColor(t.keyLed(WHITE_NOTES[p.slot - 1] - 48, { now }));
          // outside the shift page TAPE only lights a few keys; show what's on the card
          if (!col && !t.menuOpen && ts.files && ts.files[p.slot - 1]) col = 1;
        } else if (p && p.kind === 'tape') {
          col = t.menuOpen ? pushColor(t.transportLeds(now).play) : 0;
        } else if (p && p.what === 'star') {
          col = pushColor(t.transportLeds(now).star) || 1;
        } else if (p) {
          col = pushColor(t.menuKeyLed(NOTE_BUTTON[p.what], now)) || 1;
        }
        led('n', note, col);
      } else {
        led('n', note, keyLedFor(idx, new Set(ts.playing || [])));
      }
    }
    // upper row: bi-colour (amber when on)
    for (let b = 0; b < 8; b++) {
      let on = false;
      if (b < 7) on = !!t.menuKeyLed(NOTE_BUTTON[UPPER[b]], now);
      led('c', 20 + b, b === 7 ? 13 : on ? 10 : 7);
    }
    // lower row: each knob's LED colour; then the mode switch and the bridge
    for (let k = 0; k < 6; k++) led('c', 102 + k, pushColor(t.ledColor(k, ts.vuOut || 0)) || 1);
    led('c', 108, t.switchDown ? 1 : 5);
    led('c', 109, api.bridge() ? 37 : 1);
    for (let k = 0; k < 8; k++) led('c', 43 - k, 0);
    const tl = t.transportLeds(now);
    const single = (c) => { const m = c ? Math.max(...c) : 0; return m > 0.5 ? 4 : m > 0.05 ? 1 : 0; };
    led('c', CC.play, single(tl.play) || 1);
    led('c', CC.record, single(tl.loop) || 1);
    led('c', CC.mute, single(tl.star) || 1);
    led('c', CC.shift, shift || t.menuOpen ? 4 : 1);
    led('c', CC.tap, 0);
    led('c', CC.del, 0);
  }

  return {
    onMessage,
    renderLcd,
    renderLeds,
    release() { for (const n of [...padsDown.keys()]) padRelease(n); if (shift) { shift = false; ui().setKbdShift(false); } },
  };
}

// keybed index -> hardware button id (for menuKeyLed)
const NOTE_BUTTON = {
  1: 7, 3: 12, 6: 13, 8: 14, 10: 21, 13: 22, 15: 23, 18: 29, 20: 30, 22: 31,
};
