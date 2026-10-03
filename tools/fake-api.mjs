// A stand-in for the app's controller API (web/js/app.js `api`), recording
// what controller code asks it to do. Used by the offline controller tests.
import { P } from '../web/js/engine.js';
import { PARAMS, BY_ID } from '../web/js/params.js';

export function fakeApi() {
  const values = Object.fromEntries(PARAMS.map((p) => [p.id, p.def]));
  const listeners = { param: [], state: [], presets: [] };
  const log = { notes: [], transport: [], bends: [], sustain: [], presetLoads: [] };
  const seq = { steps: new Array(32).fill(-1), length: 0 };
  const state = { vu: 0, voices: [], seqPlaying: false, seqRecording: false, seqMuted: false, seqGateOpen: false, seqIndex: 0, seqLength: 0, steps: seq.steps };
  const presets = new Array(14).fill(null).map((_, i) => (i < 6 ? { name: `s${i}` } : null));
  let current = -1;
  let outDb = 18;
  const api = {
    P, BY_ID, PARAMS,
    get: (id) => values[id],
    set: (id, v) => {
      const p = BY_ID[id];
      v = Math.min(p.max, Math.max(p.min, v));
      if (p.step) v = Math.round(v / p.step) * p.step;
      values[id] = v;
      listeners.param.forEach((f) => f(id));
    },
    getOutDb: () => outDb, setOutDb: (d) => { outDb = d; },
    noteOn: (src, n, v) => log.notes.push(['on', src, n, v]),
    noteOff: (src) => log.notes.push(['off', src]),
    releaseSources: (prefix) => log.notes.push(['releaseSources', prefix]),
    allNotesOff: () => log.notes.push(['allOff']),
    sustain: (on) => log.sustain.push(on),
    bend: (st) => log.bends.push(st),
    preview: () => {},
    play: (d) => log.transport.push(['play', d]), loop: (d) => log.transport.push(['loop', d]),
    rest: (d) => log.transport.push(['rest', d]), tap: () => log.transport.push(['tap']),
    state: () => state,
    seq: {
      get steps() { return seq.steps; }, get length() { return seq.length; },
      click: (i) => { if (i >= seq.length) seq.length = i + 1; seq.steps[i] = seq.steps[i] >= 0 ? -1 : 60; },
      setStep: (i, n) => { if (i >= seq.length) seq.length = i + 1; seq.steps[i] = n; },
      setLength: (n) => { seq.length = n; },
      clear: () => { seq.steps.fill(-1); seq.length = 0; log.transport.push(['clear']); },
    },
    presets: {
      load: (i) => { if (presets[i]) { current = i; log.presetLoads.push(i); listeners.presets.forEach((f) => f()); } },
      filled: (i) => !!presets[i],
      currentIndex: () => current,
      currentName: () => (current >= 0 ? presets[current].name : ''),
      step: (dir) => log.presetLoads.push(`step${dir}`),
    },
    on: (t, f) => { listeners[t].push(f); return () => { listeners[t] = listeners[t].filter((x) => x !== f); }; },
  };
  return { api, values, log, seq, state };
}

export function checker() {
  let fail = 0;
  const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fail++; };
  const done = () => {
    console.log(fail ? `\n${fail} check(s) failed` : '\nall checks passed');
    process.exit(fail ? 1 : 0);
  };
  return { check, done };
}

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
