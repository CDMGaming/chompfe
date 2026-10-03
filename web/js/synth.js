// Main-thread handle on the audio engine: builds the AudioContext graph,
// loads the wasm and factory tables, and forwards commands to the worklet.
import { wavToTable } from './wavetable.js';
import { P, PARAM_COUNT } from './engine.js';

// Names from the WAVE quick start guide
export const TABLE_NAMES = ['Classic Console', 'Harmonic Bloom', 'FM Bells & Metal', 'Wavefolder', 'Vowels', 'Degradation', 'Sample Platter'];

export const FACTORY_TABLES = [1, 2, 3, 4, 5, 6, 7].map((i) => `wavetables/wavetable0${i}.wav`);

// The firmware's digital output is quiet: each voice is scaled by .2 and the
// 8-voice mix is divided by 8, so one note peaks around -35 dBFS. The hardware
// made that up in its analog output stage; here a gain + limiter sits after
// the engine instead (the engine itself is unchanged).
export const DEFAULT_OUTPUT_DB = 18;

export class Synth extends EventTarget {
  constructor() {
    super();
    this.ctx = null;
    this.node = null;
    this.state = { vu: 0, voices: [], frame: 0, seqPlaying: false, seqIndex: 0, seqLength: 0 };
    this.params = new Float32Array(PARAM_COUNT);
    this.tableNames = FACTORY_TABLES.map((u) => u.split('/').pop());
    this.tables = new Array(7).fill(null); // main-thread copies, for drawing
    this.custom = new Array(7).fill(null); // name of a user table in a slot, else null
  }

  async start() {
    if (this.ctx) {
      if (this.ctx.state !== 'running') await this.ctx.resume();
      return;
    }
    // 48 kHz like the hardware; the browser resamples to the device if needed.
    const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    this.ctx = ctx;
    const [wasmBytes] = await Promise.all([
      fetch('chompfe.wasm').then((r) => {
        if (!r.ok) throw new Error(`chompfe.wasm: HTTP ${r.status}`);
        return r.arrayBuffer();
      }),
      ctx.audioWorklet.addModule('js/worklet.js'),
    ]);
    const node = new AudioWorkletNode(ctx, 'chompfe', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { wasmBytes },
    });
    this.node = node;

    const ready = new Promise((res) => {
      node.port.onmessage = (e) => {
        const m = e.data;
        if (m.t === 'ready') res();
        else if (m.t === 'state') {
          this.state = m.s;
          this.dispatchEvent(new CustomEvent('state', { detail: m }));
        }
      };
    });

    this.output = ctx.createGain();
    this.output.gain.value = Math.pow(10, DEFAULT_OUTPUT_DB / 20);
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -2;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.12;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    node.connect(this.output).connect(this.limiter).connect(ctx.destination);
    this.limiter.connect(this.analyser);

    await ready;
    await Promise.all(FACTORY_TABLES.map((url, slot) => this.loadTableFromUrl(slot, url)));
    if (ctx.state !== 'running') await ctx.resume();
  }

  /** Put the factory table back in a slot. */
  async loadFactory(slot) {
    await this.loadTableFromUrl(slot, FACTORY_TABLES[slot]);
    this.custom[slot] = null;
  }

  async loadTableFromUrl(slot, url) {
    const buf = await fetch(url).then((r) => {
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
      return r.arrayBuffer();
    });
    this.loadTable(slot, wavToTable(buf).table);
  }

  loadTable(slot, table) {
    this.tables[slot] = table.slice();
    this.node.port.postMessage({ t: 'table', slot, data: table }, [table.buffer]);
  }

  send(msg) { if (this.node) this.node.port.postMessage(msg); }

  noteOn(n, v = 127) { this.send({ t: 'on', n, v }); }
  noteOff(n) { this.send({ t: 'off', n }); }
  allNotesOff() { this.send({ t: 'allOff' }); }
  setParam(id, v) {
    this.params[id] = v;
    this.send({ t: 'param', id, v });
  }
  setOutputDb(db) {
    if (this.output) this.output.gain.setTargetAtTime(Math.pow(10, db / 20), this.ctx.currentTime, 0.02);
  }
}

export { P };
