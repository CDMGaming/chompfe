// AudioWorkletProcessor hosting chompfe.wasm. The wasm bytes arrive via
// processorOptions and are compiled synchronously here (the module is ~40 KB).
import { ChompfeEngine } from './engine.js';

const STATE_EVERY = 6; // blocks between UI state posts (~62 Hz at 48 kHz; drives Push LEDs too)

class ChompfeProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { wasmBytes } = options.processorOptions;
    this.engine = new ChompfeEngine(new WebAssembly.Module(wasmBytes), sampleRate);
    this.blocks = 0;
    this.port.onmessage = (e) => this.onMessage(e.data);
    this.port.postMessage({ t: 'ready', sampleRate });
  }

  onMessage(m) {
    const e = this.engine;
    switch (m.t) {
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
      default: break;
    }
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const [l, r] = this.engine.render(out[0].length);
    out[0].set(l.subarray(0, out[0].length));
    if (out[1]) out[1].set(r.subarray(0, out[1].length));

    if (++this.blocks >= STATE_EVERY) {
      this.blocks = 0;
      const midi = this.engine.drainMidiOut();
      this.port.postMessage({ t: 'state', s: this.engine.state(), midi });
    }
    return true;
  }
}

registerProcessor('chompfe', ChompfeProcessor);
