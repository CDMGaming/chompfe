// MIDI learn: map any knob/button/key on any device to a control on screen.
//
// Flow: arm a target (a param, a wavetable slot, a sound slot, a transport
// action), then move a control on the device. A mapping remembers the port
// name, message type, channel and number, and for knobs whether they send
// absolute values or relative steps (detected from the first few messages).
// Mappings are checked before the device's profile, so they can override it.

const KEY = 'chompfe.midimap.v1';

function load() {
  try {
    const m = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(m) ? m : [];
  } catch {
    return [];
  }
}

// Relative encodings in the wild:
//   rel2c  two's complement: 1..63 up, 127..65 down (Push, many encoders)
//   rel64  offset binary: 65.. up, ..63 down, 64 = no move (Arturia relative #1)
export const MODES = ['abs', 'rel64', 'rel2c'];
const delta = (mode, v) => (mode === 'rel64' ? v - 64 : v < 64 ? v : v - 128);

export class MidiLearn extends EventTarget {
  constructor(api) {
    super();
    this.api = api;
    this.maps = load();
    this.target = null; // armed target
    this.pending = null; // messages collected while deciding abs vs relative
    this.accum = new Map();
    this.lastPress = new Map();
  }

  save() {
    try { localStorage.setItem(KEY, JSON.stringify(this.maps)); } catch { /* storage blocked */ }
    this.dispatchEvent(new Event('change'));
  }

  arm(target) {
    this.target = target;
    this.pending = null;
    this.dispatchEvent(new Event('armed'));
  }

  disarm() {
    this.target = null;
    this.pending = null;
    this.dispatchEvent(new Event('armed'));
  }

  remove(i) { this.maps.splice(i, 1); this.save(); }
  clear() { this.maps = []; this.save(); }
  setMode(i, mode) { this.maps[i].mode = mode; this.save(); }

  /** Called for every incoming message. Returns true if it was consumed. */
  handle(port, d) {
    const st = d[0] & 0xf0;
    const ch = d[0] & 0x0f;
    let type;
    if (st === 0xb0) type = 'cc';
    else if (st === 0x90 || st === 0x80) type = 'note';
    else return false;
    const num = d[1];
    const val = st === 0x80 ? 0 : d[2];

    if (this.target) {
      if (type === 'note' && val === 0) return true; // wait for a press
      this.collect(port, type, ch, num, val);
      return true;
    }

    const m = this.maps.find((x) => x.port === port && x.type === type && x.ch === ch && x.num === num);
    if (!m) return false;
    this.apply(m, type, val);
    return true;
  }

  // Wait for up to three messages from the same control (or 350 ms) to tell
  // an absolute knob from a relative encoder or a button.
  collect(port, type, ch, num, val) {
    const p = this.pending;
    if (!p || p.port !== port || p.type !== type || p.ch !== ch || p.num !== num) {
      clearTimeout(p && p.timer);
      this.pending = { port, type, ch, num, vals: [val], timer: setTimeout(() => this.finish(), 350) };
    } else {
      p.vals.push(val);
    }
    if (type === 'note' || this.pending.vals.length >= 3) this.finish();
  }

  finish() {
    const p = this.pending;
    if (!p || !this.target) return;
    clearTimeout(p.timer);
    let mode = 'abs';
    if (p.type === 'note') mode = 'button';
    else {
      const vs = p.vals;
      const same = vs.every((x) => x === vs[0]);
      if (vs.length > 1 && same && (vs[0] <= 7 || vs[0] >= 121)) mode = 'rel2c';
      else if (vs.length > 1 && same && vs[0] >= 57 && vs[0] <= 71 && vs[0] !== 64) mode = 'rel64';
      else if (vs.every((x) => x === 0 || x === 127)) mode = 'button';
    }
    // one control drives one target: replace older mappings of either
    const t = this.target;
    this.maps = this.maps.filter((m) => !(m.port === p.port && m.type === p.type && m.ch === p.ch && m.num === p.num));
    this.maps.push({ port: p.port, type: p.type, ch: p.ch, num: p.num, mode, target: t });
    this.target = null;
    this.pending = null;
    this.save();
    this.dispatchEvent(new CustomEvent('learned', { detail: this.maps[this.maps.length - 1] }));
    this.dispatchEvent(new Event('armed'));
  }

  apply(m, type, val) {
    const { api } = this;
    const t = m.target;
    const pressed = val >= 64;
    const isButton = m.mode === 'button' || type === 'note';
    // a button-style control: act on the press edge (and release for transport)
    const edge = () => {
      const key = `${m.port}|${m.type}|${m.ch}|${m.num}`;
      const was = this.lastPress.get(key) || false;
      this.lastPress.set(key, pressed);
      return pressed && !was ? 'down' : !pressed && was ? 'up' : null;
    };

    if (t.kind === 'action') {
      const e = isButton ? edge() : pressed ? 'down' : 'up';
      if (!e) return;
      if (t.name === 'play') api.play(e === 'down');
      else if (t.name === 'loop') api.loop(e === 'down');
      else if (t.name === 'rest') api.rest(e === 'down');
      else if (t.name === 'tap' && e === 'down') api.tap();
      else if (t.name === 'clear' && e === 'down') api.seq.clear();
      else if (t.name === 'next' && e === 'down') api.presets.step(1);
      else if (t.name === 'prev' && e === 'down') api.presets.step(-1);
      return;
    }
    if (t.kind === 'table') { if (edge() === 'down' || (!isButton && pressed)) api.set(api.P.TABLE, t.i); return; }
    if (t.kind === 'preset') { if (edge() === 'down') api.presets.load(t.i); return; }
    if (t.kind !== 'param') return;

    const p = api.BY_ID[t.id];
    const stepped = p.step >= 1;
    const isToggle = stepped && p.min === 0 && p.max === 1;
    if (isButton) {
      if (edge() !== 'down') return;
      if (isToggle) api.set(t.id, api.get(t.id) > 0.5 ? 0 : 1);
      else if (stepped) api.set(t.id, api.get(t.id) + p.step > p.max ? p.min : api.get(t.id) + p.step); // cycle
      else api.set(t.id, p.def); // a button on a knob resets it
      return;
    }
    if (m.mode === 'abs') {
      api.set(t.id, p.min + (val / 127) * (p.max - p.min));
      return;
    }
    const dv = delta(m.mode, val);
    if (stepped) {
      const key = m.port + m.num;
      let a = (this.accum.get(key) || 0) + dv;
      while (Math.abs(a) >= 3) {
        const dir = a > 0 ? 1 : -1;
        api.set(t.id, api.get(t.id) + dir * p.step);
        a -= 3 * dir;
      }
      this.accum.set(key, a);
    } else {
      api.set(t.id, api.get(t.id) + dv * (p.max - p.min) / 200);
    }
  }
}

/** Human label for a mapping's source, e.g. "CC 74 ch1" / "note 36 ch10". */
export function sourceLabel(m) {
  return `${m.type === 'cc' ? 'CC' : 'note'} ${m.num} ch${m.ch + 1}`;
}
