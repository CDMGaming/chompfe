// AudioWorkletProcessor hosting both engines: chompfe.wasm (WAVE) always, and
// tape.wasm (TAPE) once it's first needed. The wasm bytes arrive by message
// and are compiled synchronously here.
//
// Modes:  'wave'  -> WAVE renders to the output.
//         'tape'  -> TAPE renders to the output (its master/line out, so the
//                    input monitor stays in the "headphones" and can't feed
//                    back through speakers). With the bridge on, WAVE keeps
//                    running underneath and is TAPE's line input, so WAVE's
//                    loop can be sampled / looped / effected in TAPE.
import { ChompfeEngine } from './engine.js';
import { TapeEngine } from './tape-engine.js';

// WAVE's samples come out ~18 dB under line level (the app's output gain makes
// that up, as the hardware's analog stage did); TAPE's are at line level. So
// the bridge lifts WAVE into TAPE's line in, and TAPE is trimmed to sit at the
// same loudness as WAVE behind the shared output gain.
const WAVE_TO_LINE = Math.pow(10, 18 / 20);
const TAPE_TRIM = Math.pow(10, -18 / 20);

const STATE_EVERY = 6; // blocks between UI state posts (~62 Hz at 48 kHz; drives Push LEDs too)
const CARD_EVERY = 40; // state posts between looks for card changes (~0.6 s)

// the card files worth keeping (not the *_double copies the boot scan makes,
// not the scratch file a recording streams into)
const keepFile = (name) => /\.wav$/i.test(name) && !/_double\.wav$/i.test(name) && !/^temp_rec/i.test(name);

class ChompfeProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { wasmBytes } = options.processorOptions;
    this.engine = new ChompfeEngine(new WebAssembly.Module(wasmBytes), sampleRate);
    this.tape = null;
    this.mode = 'wave';
    this.bridge = false;
    this.blocks = 0;
    this.cardPosts = 0;
    this.port.onmessage = (e) => this.onMessage(e.data);
    this.port.postMessage({ t: 'ready', sampleRate });
  }

  onMessage(m) {
    const e = this.engine;
    const tp = this.tape;
    switch (m.t) {
      // ---- WAVE
      case 'on': e.noteOn(m.n, m.v); break;
      case 'off': e.noteOff(m.n); break;
      case 'allOff': e.allNotesOff(); break;
      case 'param': e.setParam(m.id, m.v); break;
      case 'params': for (const [id, v] of m.list) e.setParam(id, v); break;
      case 'frameStep': e.frameStep(m.turns); break;
      case 'table': e.loadTable(m.slot, m.data); break;
      case 'seqStep': e.seqSetStep(m.i, m.n); break;
      case 'seqSteps': m.notes.forEach((n, i) => e.seqSetStep(i, n)); break;
      case 'seqLength': e.seqSetLength(m.n); break;
      case 'seqPlay': e.seqPlay(m.on); break;
      case 'seqClear': e.seqClear(); break;
      case 'seqMute': e.seqMute(m.on); break;
      case 'seqRecord': e.seqRecord(m.on); break;
      case 'playBtn': e.playButton(m.down); break;
      case 'loopBtn': e.loopButton(m.down); break;
      case 'restBtn': e.restButton(m.down); break;
      case 'tap': e.tapTempo(); break;

      // ---- TAPE
      case 'tapeInit':
        if (!this.tape) {
          // monitor "both" as on the factory card (options.json Monitor Position 1)
          this.tape = new TapeEngine(new WebAssembly.Module(m.wasmBytes), sampleRate, { monitorMode: 1 });
          this.tape.boot();
        }
        this.port.postMessage({ t: 'tapeReady' });
        break;
      case 'mode': this.mode = m.mode; break;
      case 'bridge': this.bridge = !!m.on; break;
      case 'tfiles':
        if (!tp) break;
        for (const f of m.files) tp.putFile(f.name, f.data);
        tp.boot(); // headers + *_double files, then the slot table refresh
        tp.changes(); // those writes were ours, not the player's
        this.port.postMessage({ t: 'tfilesDone', id: m.id });
        break;
      case 'tremove':
        if (tp) { for (const n of m.names) tp.removeFile(n); tp.boot(); tp.changes(); }
        break;
      case 'tram': {
        const data = tp ? tp.ram(m.which) : new Int16Array(0);
        this.port.postMessage({ t: 'tram', id: m.id, data }, [data.buffer]);
        break;
      }
      case 'tgetfile':
        this.port.postMessage({ t: 'tfile', id: m.id, name: m.name, data: tp ? tp.getFile(m.name) : null });
        break;
      case 'tcmd': {
        if (!tp) break;
        const v = tp.cmd(m.op, m.a || 0, m.b || 0);
        if (m.id !== undefined) this.port.postMessage({ t: 'tres', id: m.id, v });
        break;
      }
      case 'tcmds': if (tp) for (const [op, a, b] of m.list) tp.cmd(op, a || 0, b || 0); break;
      case 'tkey':
        if (!tp) break;
        if (m.b !== undefined) tp.x.tp_key(m.b, m.n, m.down ? 1 : 0, m.v);
        else tp.key(m.n, m.down, m.v);
        break;
      case 'tcubbi': if (tp) tp.openCubbiSlot(m.p); break;
      case 'tcopy': if (tp) tp.x.tp_copy_setup(m.srcBank, m.srcMode, m.destBank, m.destMode, m.set ? 1 : 0, m.chompi, m.looper); break;
      default: break;
    }
  }

  /** Send the files the firmware changed to the page, which keeps them. */
  postCardChanges(tp) {
    const ch = tp.changes().filter(([, name]) => keepFile(name));
    if (!ch.length) return;
    const files = [];
    const removed = [];
    for (const [op, name] of ch) {
      const data = op === '+' ? tp.getFile(name) : null;
      if (data) files.push({ name, data });
      else removed.push(name);
    }
    this.port.postMessage({ t: 'tchanged', files, removed }, files.map((f) => f.data.buffer));
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const n = out[0].length;
    const tp = this.tape;

    if (this.mode === 'tape' && tp) {
      // the browser's audio input (if any) is the mic (mono) and the line in (stereo)
      const inp = inputs[0] || [];
      const a = inp[0];
      const b = inp[1] || inp[0];
      for (let i = 0; i < n; i++) {
        const l = a ? a[i] : 0;
        const r = b ? b[i] : 0;
        tp.in[0][i] = 0.5 * (l + r);
        tp.in[2][i] = l;
        tp.in[3][i] = r;
      }
      if (this.bridge) {
        const [wl, wr] = this.engine.render(n);
        for (let i = 0; i < n; i++) {
          tp.in[2][i] = wl[i] * WAVE_TO_LINE;
          tp.in[3][i] = wr[i] * WAVE_TO_LINE;
        }
      }
      tp.render(n);
      for (let i = 0; i < n; i++) out[0][i] = tp.out[2][i] * TAPE_TRIM;
      if (out[1]) for (let i = 0; i < n; i++) out[1][i] = tp.out[3][i] * TAPE_TRIM;
    } else {
      const [l, r] = this.engine.render(n);
      out[0].set(l.subarray(0, n));
      if (out[1]) out[1].set(r.subarray(0, n));
    }

    if (++this.blocks >= STATE_EVERY) {
      this.blocks = 0;
      const midi = this.engine.drainMidiOut();
      const msg = { t: 'state', s: this.engine.state(), midi };
      if (tp) msg.tape = tp.state();
      this.port.postMessage(msg);
      if (tp && ++this.cardPosts >= CARD_EVERY && !msg.tape.copying && !msg.tape.erasing && !msg.tape.recording) {
        this.cardPosts = 0;
        this.postCardChanges(tp);
      }
    }
    return true;
  }
}

registerProcessor('chompfe', ChompfeProcessor);
