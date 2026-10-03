// Arturia MiniLab mkII profile, for the factory preset (memory 1, "Analog Lab").
//
// Factory assignments, cross-checked against Ardour's shipped map
// (share/midi_maps/Arturia_MiniLab_mkII.map) and two other open-source drivers:
//   Keys            notes on ch 1
//   Knobs 1-8       CC 112, 74, 71, 76, 77, 93, 73, 75   (ch 1)
//   Knobs 9-16      CC 114, 18, 19, 16, 17, 91, 79, 72
//   Knobs 1 and 9   endless/relative, 64 = no move; clicking them sends CC 113 / 115
//   Other knobs     absolute 0..127
//   Pads 1-8        notes 36..43 on ch 10          Pads 9-16  CC 22..29 on ch 1
//   Touch strips    pitch bend, mod wheel (CC 1)   Sustain    CC 64
//   Pad colour      F0 00 20 6B 7F 42 02 00 10 <0x70+pad> <colour> F7
//                   colours: 0 off, 1 red, 4 green, 5 yellow, 16 blue, 17 magenta, 20 cyan, 127 white
//
// Layout here: the top row is the core sound, the bottom row movement/space/
// tempo, pads 1-7 pick wavetables, pad 8 plays/stops the loop, pads 9-16 load
// sound slots 1-8.
export const id = 'minilab2';
export const label = 'MiniLab mkII';

export function match(name) { return /minilab\s*mk\s*ii/i.test(name); }

const COLOR = { off: 0, red: 1, green: 4, yellow: 5, blue: 16, magenta: 17, cyan: 20, white: 127 };

export function create({ input, output, api, sysex }) {
  const { P } = api;
  const send = (b) => { try { output && output.send(b); } catch { /* port went away */ } };
  const src = (note) => `minilab:${input.id}:${note}`;

  // absolute knobs -> params (value/127 across the param's range)
  const KNOBS = {
    74: P.PITCH, 71: P.ATTACK, 76: P.RELEASE, 77: P.CUTOFF, 93: P.RESONANCE, 73: P.FX, 75: P.GAIN,
    18: P.FILTER_LFO_DEPTH, 19: P.FILTER_LFO_RATE, 16: P.PITCH_LFO_DEPTH, 17: P.PITCH_LFO_RATE,
    91: P.FX_TIME, 79: P.DRIVE, 72: P.TEMPO,
  };
  const acc = { 112: 0, 114: 0 };
  const padCC = new Map(); // pad CC -> last press time (pads 9-16 may be momentary or toggle)

  function relative(cc, v, per, fn) {
    acc[cc] += v - 64;
    while (Math.abs(acc[cc]) >= per) {
      const dir = acc[cc] > 0 ? 1 : -1;
      fn(dir);
      acc[cc] -= per * dir;
    }
  }

  function padPress(n) { // 0..15
    if (n < 7) api.set(P.TABLE, n);
    else if (n === 7) { api.play(true); api.play(false); }
    else api.presets.load(n - 8);
  }

  function onMessage(d) {
    const st = d[0] & 0xf0;
    const ch = d[0] & 0x0f;
    if (st === 0x90 || st === 0x80) {
      const on = st === 0x90 && d[2] > 0;
      if (ch === 9 && d[1] >= 36 && d[1] <= 43) { if (on) padPress(d[1] - 36); return; }
      if (on) api.noteOn(src(d[1]), d[1], d[2]); else api.noteOff(src(d[1]));
      return;
    }
    if (st === 0xe0) { api.bend((((d[2] << 7) | d[1]) - 8192) / 8192 * 2); return; }
    if (st !== 0xb0) return;
    const cc = d[1];
    const v = d[2];
    if (cc in KNOBS) {
      const p = api.BY_ID[KNOBS[cc]];
      api.set(p.id, p.min + (v / 127) * (p.max - p.min));
    } else if (cc === 112) {
      relative(112, v, 1, (dir) => api.set(P.FRAME, api.get(P.FRAME) + dir)); // frame scan
    } else if (cc === 114) {
      relative(114, v, 2, (dir) => api.set(P.TABLE, Math.max(0, Math.min(6, api.get(P.TABLE) + dir))));
    } else if (cc === 113 && v > 0) {
      api.set(P.FRAME, 0); // click knob 1: back to the first frame
    } else if (cc === 115 && v > 0) {
      api.set(P.OCTAVE, api.get(P.OCTAVE) >= 1 ? -1 : api.get(P.OCTAVE) + 1); // click knob 9: cycle octave
    } else if (cc >= 22 && cc <= 29) {
      // Momentary pads send 127 then 0; toggle pads send 127 on one press and
      // 0 on the next. Treat a 0 that follows a 127 within 400 ms as a release.
      const now = performance.now();
      if (v > 0) { padCC.set(cc, now); padPress(8 + cc - 22); }
      else if (now - (padCC.get(cc) || 0) > 400) padPress(8 + cc - 22);
    } else if (cc === 64) api.sustain(v >= 64);
    else if (cc === 1) api.set(P.PITCH_LFO_DEPTH, v / 127);
    else if (cc === 123 || cc === 120) api.allNotesOff();
  }

  // ---- pad colours
  const last = new Array(16).fill(-1);
  function padColor(i, c) {
    if (!sysex || last[i] === c) return;
    last[i] = c;
    send([0xf0, 0x00, 0x20, 0x6b, 0x7f, 0x42, 0x02, 0x00, 0x10, 0x70 + i, c, 0xf7]);
  }
  let pending = 0;
  function render() {
    pending = 0;
    const table = Math.round(api.get(P.TABLE));
    for (let i = 0; i < 7; i++) padColor(i, i === table ? COLOR.white : COLOR.blue);
    padColor(7, api.state().seqPlaying ? COLOR.green : api.seq.length ? COLOR.yellow : COLOR.off);
    const cur = api.presets.currentIndex();
    for (let i = 0; i < 8; i++) padColor(8 + i, i === cur ? COLOR.white : api.presets.filled(i) ? COLOR.magenta : COLOR.off);
  }
  const schedule = () => { if (!pending) pending = setTimeout(render, 30); };
  const offs = [api.on('param', schedule), api.on('state', schedule), api.on('presets', schedule)];
  schedule();

  return {
    onMessage,
    destroy(goodbye) {
      offs.forEach((f) => f());
      clearTimeout(pending);
      api.releaseSources(`minilab:${input.id}:`);
      api.bend(0);
      api.sustain(false);
      if (goodbye !== false) for (let i = 0; i < 16; i++) padColor(i, COLOR.off);
    },
  };
}
