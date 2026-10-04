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
    this.tapeLoading = new Map(); // 'mode:bank' -> promise
    this.cardOverrides = new Map(); // your changes to the card: name -> bytes, or null if erased
    this.tapePeaks = new Map(); // 'jammi_a1' -> Float32Array(120), for the LED display
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
        } else if (m.t === 'tchanged') {
          for (const f of m.files) {
            this.cardOverrides.set(f.name, f.data);
            if (/^(jammi|cubbi)_/i.test(f.name)) this.tapePeaks.set(f.name.replace(/\.wav$/i, ''), peaksOfWav(f.data));
          }
          for (const n of m.removed) this.cardOverrides.set(n, null);
          this.dispatchEvent(new CustomEvent('card', { detail: m }));
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
  /** A TAPE key: MIDI note n; `b` is the hardware button when it isn't the keybed's own. */
  tkey(n, down, v = 127, b) { this.send({ t: 'tkey', n, down, v, b }); }
  tcubbi(p) { this.send({ t: 'tcubbi', p }); }
  /** FileCopier request (chompi / looper: 0 none, 1 from RAM, 2 to RAM). */
  tcopy(r) {
    this.send({ t: 'tcopy', srcBank: r.srcBank, srcMode: r.srcMode, destBank: r.destBank, destMode: r.destMode, set: r.set, chompi: r.chompi, looper: r.looper });
    this.tcmd(46, r.src, r.dest); // CMD.COPY
  }

  /** Put one factory bank (mode 0 jammi / 1 cubbi, bank 0..4) on TAPE's card.
   *  Lossless FLAC -> decoded -> checked against the index checksum -> the
   *  original 16-bit WAV bytes. */
  loadTapeBank(mode, bank, onProgress) {
    const key = `${mode}:${bank}`;
    if (this.tapeBanks.has(key)) return Promise.resolve();
    if (!this.tapeLoading.has(key)) {
      this.tapeLoading.set(key, this.fetchTapeBank(mode, bank, onProgress).finally(() => this.tapeLoading.delete(key)));
    }
    return this.tapeLoading.get(key);
  }

  /** True if the factory card or your own changes have anything in that bank. */
  async tapeBankExists(mode, bank) {
    if (!this.tapeIndex) this.tapeIndex = await fetch('samples/tape/index.json').then((r) => r.json());
    for (let slot = 1; slot <= 14; slot++) {
      const name = sampleName(mode, bank, slot);
      if (this.cardOverrides.get(name)) return true;
      if (this.tapeIndex[name.replace('.wav', '')] && !this.cardOverrides.has(name)) return true;
    }
    return false;
  }

  /** Files on your card outside the factory banks (the tape, say). */
  async loadCardExtras() {
    const files = [];
    for (const [name, data] of this.cardOverrides) {
      if (data && !/^(jammi|cubbi)_/i.test(name)) files.push({ name, data: data.slice() });
    }
    if (files.length) await this.request({ t: 'tfiles', files }, files.map((f) => f.data.buffer));
    return files.map((f) => f.name);
  }

  async fetchTapeBank(mode, bank, onProgress) {
    const key = `${mode}:${bank}`;
    if (!this.tapeIndex) this.tapeIndex = await fetch('samples/tape/index.json').then((r) => r.json());
    const files = [];
    const names = [];
    for (let slot = 1; slot <= 14; slot++) {
      const name = sampleName(mode, bank, slot);
      const base = name.replace('.wav', '');
      const own = this.cardOverrides.get(name);
      if (own) files.push({ name, data: own.slice() }); // yours wins
      else if (this.tapeIndex[base] && !this.cardOverrides.has(name)) names.push([slot, base]);
      if (own) this.tapePeaks.set(base, peaksOfWav(own));
    }
    let done = 0;
    if (names.length && !this.ctx) throw new Error('audio is not running yet');
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
      this.tapePeaks.set(base, peaks(L, Rch));
      if (onProgress) onProgress(++done, names.length);
    });
    await this.request({ t: 'tfiles', files }, files.map((f) => f.data.buffer));
    this.tapeBanks.add(key);
  }

  /** A RAM buffer as 16-bit stereo: 0 = the last recording, 1 = the tape. */
  async tapeRam(which) { return (await this.request({ t: 'tram', which })).data; }

  /** A file from TAPE's card (Uint8Array), or null. */
  async tapeFile(name) { return (await this.request({ t: 'tgetfile', name })).data; }

  /** Put your own sound on the card (16-bit stereo, 48 kHz), and keep it. */
  async putTapeSound(name, pcm) {
    const data = wavBytes(pcm);
    this.cardOverrides.set(name, data.slice());
    this.tapePeaks.set(name.replace(/\.wav$/i, ''), peaksOfWav(data));
    await this.request({ t: 'tfiles', files: [{ name, data }] }, [data.buffer]);
    return this.cardOverrides.get(name);
  }

  /** Any audio file -> 16-bit stereo at the engine's rate. */
  async decodeToPcm(arrayBuffer, maxSeconds = 300) {
    const audio = await this.ctx.decodeAudioData(arrayBuffer);
    const n = Math.min(audio.length, Math.round(maxSeconds * audio.sampleRate));
    const L = audio.getChannelData(0);
    const R = audio.numberOfChannels > 1 ? audio.getChannelData(1) : L;
    const pcm = new Int16Array(n * 2);
    for (let i = 0; i < n; i++) {
      pcm[2 * i] = Math.max(-32768, Math.min(32767, Math.round(L[i] * 32767)));
      pcm[2 * i + 1] = Math.max(-32768, Math.min(32767, Math.round(R[i] * 32767)));
    }
    return { pcm, seconds: n / audio.sampleRate, cut: n < audio.length };
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

  disableInput() {
    if (!this.inputStream) return;
    this.inputNode.disconnect();
    for (const t of this.inputStream.getTracks()) t.stop();
    this.inputStream = null;
    this.inputNode = null;
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

// Peak level in 120 columns (the LED display's width).
function peaks(L, R, cols = 120) {
  const out = new Float32Array(cols);
  const per = Math.max(1, Math.floor(L.length / cols));
  for (let c = 0; c < cols; c++) {
    let m = 0;
    const end = Math.min(L.length, (c + 1) * per);
    for (let i = c * per; i < end; i += 4) m = Math.max(m, Math.abs(L[i]), Math.abs(R[i]));
    out[c] = m;
  }
  return out;
}

// Peaks of a 16-bit stereo WAV from the card (44-byte header).
function peaksOfWav(bytes) {
  const n = Math.floor((bytes.length - 44) / 4);
  const pcm = new Int16Array(bytes.buffer, bytes.byteOffset + 44, n * 2);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = pcm[2 * i] / 32768; R[i] = pcm[2 * i + 1] / 32768; }
  return peaks(L, R);
}
