// Wrapper around chompfe.wasm. Used inside the AudioWorklet and by the Node
// render test. No DOM, no Web Audio.

export const RENDER_QUANTUM = 128;

// Must match enum Param in engine/src/chompfe.cpp
export const P = Object.freeze({
  PITCH: 0,
  FRAME: 1,
  TABLE: 2,
  ATTACK: 3,
  RELEASE: 4,
  PITCH_LFO_DEPTH: 5,
  FILTER_LFO_DEPTH: 6,
  PITCH_LFO_RATE: 7,
  FILTER_LFO_RATE: 8,
  FX: 9,
  FX_TIME: 10,
  CUTOFF: 11,
  RESONANCE: 12,
  GAIN: 13,
  PAN: 14,
  DRIVE: 15,
  PITCH_LFO_ON: 16,
  FILTER_LFO_ON: 17,
  OCTAVE: 18,
  TEMPO: 19,
  CLOCK_DIV: 20,
  GATE: 21,
});
export const PARAM_COUNT = 22;

export class ChompfeEngine {
  /** @param {WebAssembly.Module} module compiled chompfe.wasm */
  constructor(module, sampleRate) {
    const instance = new WebAssembly.Instance(module, {});
    this.x = instance.exports;
    this.memory = this.x.memory;
    if (this.x._initialize) this.x._initialize(); // static constructors
    this.x.cf_init(sampleRate);
    this.outL = new Float32Array(this.memory.buffer, this.x.cf_out_ptr(0), RENDER_QUANTUM);
    this.outR = new Float32Array(this.memory.buffer, this.x.cf_out_ptr(1), RENDER_QUANTUM);
  }

  /** Copy a 33x2048 float table into a slot (0..6). */
  loadTable(slot, table) {
    const ptr = this.x.cf_table_ptr(slot);
    if (!ptr) throw new Error(`bad slot ${slot}`);
    new Float32Array(this.memory.buffer, ptr, table.length).set(table);
  }

  /** Render up to 128 frames; returns [L, R] views into wasm memory. */
  render(frames = RENDER_QUANTUM) {
    this.x.cf_process(frames);
    return [this.outL, this.outR];
  }

  noteOn(note, velocity = 127) { this.x.cf_note_on(note, velocity); }
  noteOff(note) { this.x.cf_note_off(note); }
  allNotesOff() { this.x.cf_all_notes_off(); }
  setParam(id, value) { this.x.cf_set_param(id, value); }
  getParam(id) { return this.x.cf_get_param(id); }
  paramDefault(id) { return this.x.cf_param_default(id); }
  frameStep(turns) { this.x.cf_frame_step(turns); }

  seqSetStep(i, note) { this.x.cf_seq_set_step(i, note); }
  seqGetStep(i) { return this.x.cf_seq_get_step(i); }
  seqSetLength(n) { this.x.cf_seq_set_length(n); }
  seqPlay(on) { this.x.cf_seq_play(on ? 1 : 0); }
  seqClear() { this.x.cf_seq_clear(); }
  seqMute(on) { this.x.cf_seq_mute(on ? 1 : 0); }
  seqRecord(on) { this.x.cf_seq_record(on ? 1 : 0); }
  playButton(down) { this.x.cf_play_button(down ? 1 : 0); }
  loopButton(down) { this.x.cf_loop_button(down ? 1 : 0); }
  restButton(down) { this.x.cf_rest_button(down ? 1 : 0); }
  tapTempo() { return this.x.cf_tap_tempo(); }

  /** Snapshot for the UI thread. */
  state() {
    const x = this.x;
    const voices = [];
    const mask = x.cf_voice_mask();
    for (let i = 0; i < 8; i++) if (mask & (1 << i)) voices.push(x.cf_voice_key(i));
    const steps = new Array(32);
    for (let i = 0; i < 32; i++) steps[i] = x.cf_seq_get_step(i);
    return {
      vu: x.cf_vu(),
      voices,
      frame: x.cf_get_param(P.FRAME),
      tempo: x.cf_get_param(P.TEMPO),
      seqPlaying: !!x.cf_seq_playing(),
      seqRecording: !!x.cf_seq_recording(),
      seqMuted: !!x.cf_seq_muted(),
      seqGateOpen: !!x.cf_seq_gate_open(),
      seqIndex: x.cf_seq_index(),
      seqLength: x.cf_seq_get_length(),
      seqFlags: x.cf_seq_flags(), // read-and-clear: 1 full, 2 cleared all, 4 steps removed
      steps,
    };
  }

  /** Drain queued MIDI-out bytes (sequencer notes, transport). */
  drainMidiOut() {
    const out = [];
    for (let ev = this.x.cf_midi_out_pop(); ev !== -1; ev = this.x.cf_midi_out_pop()) {
      const st = ev & 0xff;
      out.push(st >= 0xf8 ? [st] : [st, (ev >> 8) & 0xff, (ev >> 16) & 0xff]);
    }
    return out;
  }
}
