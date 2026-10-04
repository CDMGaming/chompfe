// Main-thread handle on the audio engine: builds the AudioContext graph,
// loads the wasm and factory tables, and forwards commands to the worklet.
import { wavToTable } from './wavetable.js';
import { P, PARAM_COUNT } from './engine.js';
import { wavBytes, sampleName } from './tape-engine.js';

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
    this.pending = new Map(); // request id -> resolver
    this.nextId = 1;
    this.tapeState = null;
    this.tapeBanks = new Set(); // 'mode:bank' loaded onto the card
    this.tapeIndex = null;
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
      numberOfInputs: 1, // mic / line in for TAPE
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
          if (m.tape) this.tapeState = m.tape;
          this.dispatchEvent(new CustomEvent('state', { detail: m }));
        } else if (m.id !== undefined && this.pending.has(m.id)) {
          this.pending.get(m.id)(m);
          this.pending.delete(m.id);
        } else if (m.t === 'tapeReady' && this.tapeReadyCb) {
          this.tapeReadyCb();
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

  send(msg, transfer) { if (this.node) this.node.port.postMessage(msg, transfer || []); }

  request(msg, transfer) {
    const id = this.nextId++;
    return new Promise((res) => {
      this.pending.set(id, res);
      this.send({ ...msg, id }, transfer);
    });
  }

  // ------------------------------------------------------------ TAPE
  /** Create the TAPE engine in the worklet (once). */
  async enableTape() {
    if (this.tapeOn) return;
    const bytes = await fetch('tape.wasm').then((r) => {
      if (!r.ok) throw new Error(`tape.wasm: HTTP ${r.status}`);
      return r.arrayBuffer();
    });
    await new Promise((res) => { this.tapeReadyCb = res; this.send({ t: 'tapeInit', wasmBytes: bytes }); });
    this.tapeOn = true;
  }

  setMode(mode) { this.send({ t: 'mode', mode }); }
  setBridge(on) { this.send({ t: 'bridge', on }); }
  tcmd(op, a = 0, b = 0) { this.send({ t: 'tcmd', op, a, b }); }
  async tcmdResult(op, a = 0, b = 0) { return (await this.request({ t: 'tcmd', op, a, b })).v; }
  tkey(n, down, v = 127) { this.send({ t: 'tkey', n, down, v }); }

  /** Put one factory bank (mode 0 jammi / 1 cubbi, bank 0..4) on TAPE's card.
   *  Lossless FLAC -> decoded -> checked against the index checksum -> the
   *  original 16-bit WAV bytes. */
  async loadTapeBank(mode, bank, onProgress) {
    const key = `${mode}:${bank}`;
    if (this.tapeBanks.has(key)) return;
    if (!this.tapeIndex) this.tapeIndex = await fetch('samples/tape/index.json').then((r) => r.json());
    const files = [];
    const names = [];
    for (let slot = 1; slot <= 14; slot++) {
      const base = sampleName(mode, bank, slot).replace('.wav', '');
      if (this.tapeIndex[base]) names.push([slot, base]);
    }
    let done = 0;
    await pool(names, 4, async ([slot, base]) => {
      const buf = await fetchRetry(`samples/tape/${base}.flac`);
      const audio = await this.ctx.decodeAudioData(buf);
      const L = audio.getChannelData(0);
      const Rch = audio.numberOfChannels > 1 ? audio.getChannelData(1) : L;
      const pcm = new Int16Array(audio.length * 2);
      for (let i = 0; i < audio.length; i++) {
        pcm[2 * i] = toInt16(L[i]);
        pcm[2 * i + 1] = toInt16(Rch[i]);
      }
      const meta = this.tapeIndex[base];
      if (meta.fnv97 !== undefined && fnv97(pcm) !== meta.fnv97) console.warn(`${base}: decoded samples differ from the original`);
      files.push({ name: `${base}.wav`, data: wavBytes(pcm) });
      if (onProgress) onProgress(++done, names.length);
    });
    await this.request({ t: 'tfiles', files }, files.map((f) => f.data.buffer));
    this.tapeBanks.add(key);
  }

  /** Browser audio input (mic / line) into TAPE. */
  async enableInput() {
    if (this.inputStream) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 },
    });
    this.inputStream = stream;
    this.inputNode = this.ctx.createMediaStreamSource(stream);
    this.inputNode.connect(this.node);
  }

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

// FNV-1a over every 97th interleaved sample (as uint16), matching
// tools/make-tape-samples.py
function fnv97(pcm) {
  let h = 2166136261;
  for (let i = 0; i < pcm.length; i += 97) {
    h ^= pcm[i] & 0xffff;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

// Fetch with a few retries (flaky connections, busy dev servers).
async function fetchRetry(url, tries = 3) {
  let err;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
      return await r.arrayBuffer();
    } catch (e) {
      err = e;
      await new Promise((res) => setTimeout(res, 300 * (i + 1)));
    }
  }
  throw err;
}

// Run fn over items, at most `limit` at a time.
async function pool(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
}

// Undo the decoder's int16 -> float scaling exactly. Browsers differ: Chrome
// divides positive samples by 32767 and negative ones by 32768, others use
// 32768 throughout. Whichever scale lands on a whole number is the original.
function toInt16(v) {
  const a = v * 32768;
  const b = v * 32767;
  const x = Math.abs(a - Math.round(a)) <= Math.abs(b - Math.round(b)) ? a : b;
  return Math.max(-32768, Math.min(32767, Math.round(x)));
}
