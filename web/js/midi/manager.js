// Web MIDI: finds devices, picks a controller profile for each input by its
// port name, and pairs it with the matching output (for LEDs / displays).
//
// A profile module exports:
//   id, label
//   match(portName) -> true if this profile drives that port
//   ignore(portName) -> optional; true for sibling ports to leave alone
//   create({ input, output, api, sysex }) -> { onMessage(data), destroy() }
import * as push1 from './push1.js';
import * as generic from './generic.js';

const PROFILES = [push1]; // generic is the fallback, not listed

export class MidiManager extends EventTarget {
  constructor(api) {
    super();
    this.api = api;
    this.access = null;
    this.sysex = false;
    this.bound = new Map(); // input id -> { input, output, profile, instance }
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
    const inputs = [...this.access.inputs.values()];
    const outputs = [...this.access.outputs.values()];
    const live = new Set();
    for (const input of inputs) {
      if (input.state !== 'connected') continue;
      live.add(input.id);
      if (this.bound.has(input.id)) continue;
      const name = input.name || '';
      if (PROFILES.some((p) => p.ignore && p.ignore(name))) continue;
      const profile = PROFILES.find((p) => p.match(name)) || generic;
      const output = profile === generic ? null
        : outputs.find((o) => o.state === 'connected' && profile.match(o.name || '')) || null;
      const instance = profile.create({ input, output, api: this.api, sysex: this.sysex });
      input.onmidimessage = (e) => instance.onMessage(e.data);
      this.bound.set(input.id, { input, output, profile, instance });
    }
    for (const [id, b] of this.bound) {
      if (!live.has(id)) {
        b.instance.destroy(false);
        b.input.onmidimessage = null;
        this.bound.delete(id);
      }
    }
    this.dispatchEvent(new Event('change'));
  }

  disconnectAll() {
    for (const b of this.bound.values()) b.instance.destroy(true);
  }

  /** For the status line: [{ name, label }] */
  devices() {
    return [...this.bound.values()].map((b) => ({ name: b.input.name, label: b.profile.label }));
  }
}
