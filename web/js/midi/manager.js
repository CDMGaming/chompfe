// Web MIDI: finds devices, picks a controller profile for each input by its
// port name, and pairs it with the matching output (for LEDs / displays).
//
// A profile module exports:
//   id, label
//   match(portName) -> true if this profile drives that port
//   sibling(portName) -> optional; true for a device's second port, whose
//                        messages go to the same profile instance
//   create({ input, output, api, sysex }) -> { onMessage(data), destroy() }
import * as push1 from './push1.js';
import * as minilab2 from './minilab2.js';
import * as generic from './generic.js';
import { MidiLearn } from './learn.js';

const PROFILES = [push1, minilab2]; // generic is the fallback, not listed

export class MidiManager extends EventTarget {
  constructor(api) {
    super();
    this.api = api;
    this.access = null;
    this.sysex = false;
    this.bound = new Map(); // input id -> { input, output, profile, instance }
    this.learn = new MidiLearn(api);
    this.monitor = []; // last incoming messages, for the MIDI panel
  }

  static supported() {
    return typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function';
  }

  /** Has the user already granted MIDI (so we can connect without a prompt)? */
  static async alreadyGranted() {
    try {
      const st = await navigator.permissions.query({ name: 'midi', sysex: true });
      return st.state === 'granted';
    } catch {
      return false;
    }
  }

  async enable() {
    if (this.access) return;
    // SysEx is needed for the Push LCD. If it's refused, carry on without it.
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: true });
      this.sysex = true;
    } catch {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
      this.sysex = false;
    }
    this.access.addEventListener('statechange', () => this.scan());
    window.addEventListener('pagehide', () => this.disconnectAll());
    this.scan();
  }

  scan() {
    const inputs = [...this.access.inputs.values()].filter((i) => i.state === 'connected');
    const outputs = [...this.access.outputs.values()];
    const live = new Set(inputs.map((i) => i.id));
    const siblingOf = (name) => PROFILES.find((p) => p.sibling && p.sibling(name));

    // main ports first, so a device's second port can join its profile below
    for (const input of inputs) {
      const name = input.name || '';
      if (this.bound.has(input.id) || siblingOf(name)) continue;
      const profile = PROFILES.find((p) => p.match(name)) || generic;
      const output = profile === generic ? null
        : outputs.find((o) => o.state === 'connected' && profile.match(o.name || '')) || null;
      const instance = profile.create({ input, output, api: this.api, sysex: this.sysex });
      input.onmidimessage = (e) => this.route(name, instance, e.data);
      this.bound.set(input.id, { input, output, profile, instance, siblings: [] });
    }
    // A device's second port (e.g. the Push "User" port): feed it to the same
    // profile instance, because the device may send its controls there.
    for (const input of inputs) {
      const name = input.name || '';
      const profile = siblingOf(name);
      if (!profile) continue;
      const owner = [...this.bound.values()].find((b) => b.profile === profile);
      if (!owner || owner.siblings.includes(input)) continue;
      input.onmidimessage = (e) => this.route(name, owner.instance, e.data);
      owner.siblings.push(input);
    }

    for (const [id, b] of this.bound) {
      b.siblings = b.siblings.filter((s) => live.has(s.id) || ((s.onmidimessage = null), false));
      if (!live.has(id)) {
        b.instance.destroy(false);
        b.input.onmidimessage = null;
        for (const s of b.siblings) s.onmidimessage = null;
        this.bound.delete(id);
      }
    }
    this.dispatchEvent(new Event('change'));
  }

  route(port, instance, data) {
    this.monitor.push({ port, data: Array.from(data), t: performance.now() });
    if (this.monitor.length > 40) this.monitor.shift();
    this.dispatchEvent(new Event('message'));
    // learned mappings first, so MIDI learn can override a profile
    if (!this.learn.handle(port, data)) instance.onMessage(data);
  }

  disconnectAll() {
    for (const b of this.bound.values()) b.instance.destroy(true);
  }

  /** For the status line: [{ name, label }] */
  devices() {
    return [...this.bound.values()].map((b) => ({
      name: [b.input.name, ...b.siblings.map((s) => s.name)].join(' + '),
      label: b.profile.label,
    }));
  }
}
