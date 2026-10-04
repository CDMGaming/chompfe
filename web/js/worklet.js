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

const STATE_EVERY = 6; // blocks between UI state posts (~62 Hz at 48 kHz; drives Push LEDs too)

class ChompfeProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { wasmBytes } = options.processorOptions;
    this.engine = new ChompfeEngine(new WebAssembly.Module(wasmBytes), sampleRate);
    this.tape = null;
    this.mode = 'wave';
    this.bridge = false;
    this.blocks = 0;
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
          this.tape = new TapeEngine(new WebAssembly.Module(m.wasmBytes), sampleRate);
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
        this.port.postMessage({ t: 'tfilesDone', id: m.id });
        break;
      case 'tremove':
        if (tp) { for (const n of m.names) tp.removeFile(n); tp.boot(); }
        break;
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
      case 'tkey': if (tp) tp.key(m.n, m.down, m.v); break;
      case 'tcubbi': if (tp) tp.openCubbiSlot(m.p); break;
      case 'tcopy': if (tp) tp.x.tp_copy_setup(m.srcBank, m.srcMode, m.destBank, m.destMode, m.set ? 1 : 0, m.chompi, m.looper); break;
      default: break;
    }
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
        tp.in[2].set(wl.subarray(0, n));
        tp.in[3].set(wr.subarray(0, n));
      }
      tp.render(n);
      out[0].set(tp.out[2].subarray(0, n));
      if (out[1]) out[1].set(tp.out[3].subarray(0, n));
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
    }
    return true;
  }
}

registerProcessor('chompfe', ChompfeProcessor);
