// Wrapper around tape.wasm (the TAPE firmware's sampler / looper / FX engine).
// Used by the AudioWorklet and by the Node tests. No DOM, no Web Audio.

export const RENDER_QUANTUM = 128;

// Must match enum Cmd in engine/src/tape.cpp
export const CMD = Object.freeze({
  VOICE_MODE: 0, BANK: 1, VOICE_SLOT: 2, PITCH_FREE: 3, START: 4, END: 5, START_FORCE: 6, END_FORCE: 7,
  ATTACK: 8, DECAY: 9, GAIN: 10, PAN: 11, AUTOLOOP: 12, SUSTAIN: 13, REVERB: 14, DELAY_FEEDBACK: 15,
  DELAY_TIME: 16, SATURATE: 17, WARBLE: 18, FILTER: 19, RESONANCE: 20, MAIN_GAIN: 21, INPUT_GAIN: 22,
  FINAL_COMP: 23, LOOPER_PITCH_FREE: 24, LOOPER_PITCH: 25, LOOPER_SCRUB: 26, LOOPER_PLAY_BTN: 27,
  LOOPER_REC_BTN: 28, LOOPER_TOGGLE_REC: 29, LOOPER_DUB_GAIN: 30, FX_PRE_LOOPER: 31, INPUT_SOURCE: 32,
  INPUT_MONITOR: 33, MONITOR_NEXT: 34, RECORD_START: 35, RECORD_STOP: 36, PITCH_QUANT: 37,
  LOOPER_PITCH_QUANT: 38, RESET_PITCH_QUANT: 39, RESET_LOOPER_PITCH_QUANT: 40, STOP_ALL: 41,
  GLOBAL_PITCH: 42, REVERSE: 43, INCREMENT_BANK: 44, ERASE: 45, COPY: 46,
  LOOPER_OPEN_FILE: 47, TOGGLE_AUTOLOOP: 48, TOGGLE_SUSTAIN: 49,
});

// Must match enum Get in engine/src/tape.cpp
export const GET = Object.freeze({
  VOICE_MODE: 0, BANK: 1, VOICE_SLOT: 2, VOICE_BANK: 3, FILE_EXISTS: 4, LOOPER_EMPTY: 5, LOOPER_ARMED: 6,
  LOOPER_FIRST_REC: 7, LOOPER_RECORDING: 8, LOOPER_PLAYING: 9, LOOPER_POSITION: 10, LOOPER_PITCH: 11,
  LOOPER_DUB_GAIN: 12, LOOPER_REVERSE: 13, RECORDING: 14, VU_IN: 15, VU_OUT: 16, FX_PRE: 17,
  INPUT_SOURCE: 18, MONITOR_MODE: 19, ANY_VOICES: 20, AUTOLOOP: 21, SUSTAIN: 22, GLOBAL_PITCH: 23,
  REVERSE: 24, PAN: 25, LOOPER_RESET: 26, COPYING: 27, ERASING: 28, BOOTING: 29, LOOPER_SCRUB: 30,
});

export const MODE = Object.freeze({ JAMMI: 0, CUBBI: 1 });
export const INPUT = Object.freeze({ MIC: 0, LINE: 1, RESAMPLE: 2 });

// The 25 keys as the firmware sees them: Hardware::SwId button ids, indexed by
// MIDI note 48..72 (inverse of NormalPage's key_map). In CUBBI mode the white
// keys are slots 1..15 (KeyToSlot); black keys are not slots.
export const NOTE_TO_BUTTON = {
  48: 15, 49: 7, 50: 8, 51: 12, 52: 9, 53: 10, 54: 13, 55: 11, 56: 14, 57: 16, 58: 21, 59: 17,
  60: 18, 61: 22, 62: 19, 63: 23, 64: 20, 65: 24, 66: 29, 67: 25, 68: 30, 69: 26, 70: 31, 71: 27, 72: 28,
};
export function buttonToSlot(b) {
  if (b === 7) return 0;
  if (b < 12) return b - 6;
  if (b < 15) return 0;
  if (b === 15) return 1;
  if (b < 21) return b - 10;
  if (b < 24) return 0;
  if (b < 29) return b - 13;
  return 0;
}

/** "jammi_a1.wav" etc., as Engine::GetFileNameForSlot builds them. */
export function sampleName(mode, bank, slot, dbl = false) {
  return `${mode === MODE.CUBBI ? 'cubbi' : 'jammi'}_${'abcde'[bank]}${slot}${dbl ? '_double' : ''}.wav`;
}

/** Interleaved int16 stereo -> 44-byte-header WAV bytes (the card's format). */
export function wavBytes(interleaved, sampleRate = 48000) {
  const dataBytes = interleaved.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < 4; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + dataBytes, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, dataBytes, true);
  new Int16Array(buf, 44).set(interleaved);
  return new Uint8Array(buf);
}

export class TapeEngine {
  /** @param {WebAssembly.Module} module compiled tape.wasm */
  constructor(module, sampleRate, { recordLatch = false, tapeSlew = true, monitorMode = 0 } = {}) {
    const instance = new WebAssembly.Instance(module, {
      env: { emscripten_notify_memory_growth: () => this.views() },
    });
    this.x = instance.exports;
    if (this.x._initialize) this.x._initialize();
    this.x.tp_init(sampleRate, recordLatch ? 1 : 0, tapeSlew ? 1 : 0, monitorMode);
    this.views();
  }

  // memory can grow when samples are added; re-make the views when it does
  views() {
    const buf = this.x.memory.buffer;
    this.buf = buf;
    this.in = [0, 1, 2, 3].map((c) => new Float32Array(buf, this.x.tp_in_ptr(c), RENDER_QUANTUM));
    this.out = [0, 1, 2, 3].map((c) => new Float32Array(buf, this.x.tp_out_ptr(c), RENDER_QUANTUM));
  }

  checkViews() { if (this.buf !== this.x.memory.buffer) this.views(); }

  setName(name) {
    const p = this.x.tp_name_buf();
    const u8 = new Uint8Array(this.x.memory.buffer, p, 64);
    let i = 0;
    for (; i < name.length && i < 63; i++) u8[i] = name.charCodeAt(i);
    u8[i] = 0;
  }

  /** Put a file on the in-memory card. */
  putFile(name, bytes) {
    this.setName(name);
    const p = this.x.tp_fs_put(bytes.length);
    if (!p) throw new Error(`out of memory for ${name}`);
    new Uint8Array(this.x.memory.buffer, p, bytes.length).set(bytes);
    this.checkViews();
  }

  /** Copy of a file on the card, or null. */
  getFile(name) {
    this.setName(name);
    const n = this.x.tp_fs_size();
    if (n < 0) return null;
    const p = this.x.tp_fs_get();
    return new Uint8Array(this.x.memory.buffer, p, n).slice();
  }

  removeFile(name) { this.setName(name); return !!this.x.tp_fs_remove(); }

  /** Copy of a RAM buffer (0 = the recording, 1 = the tape), interleaved stereo int16. */
  ram(which) {
    const n = this.x.tp_ram_len(which);
    return new Int16Array(this.x.memory.buffer, this.x.tp_ram_ptr(which), n).slice();
  }

  /** Files the firmware wrote / deleted since the last call: [['+'|'-', name]]. */
  changes() {
    const p = this.x.tp_fs_changes();
    const u8 = new Uint8Array(this.x.memory.buffer, p, 8192);
    const out = [];
    let line = '';
    for (let i = 0; i < u8.length && u8[i]; i++) {
      if (u8[i] === 10) { if (line) out.push([line[0], line.slice(1)]); line = ''; } else line += String.fromCharCode(u8[i]);
    }
    return out;
  }

  /** Run the boot scan (headers + *_double files) to completion. */
  boot(maxSteps = 1e7) {
    this.x.tp_boot_begin();
    let steps = 0;
    while (this.x.tp_boot_pump(4096) && steps < maxSteps) steps += 4096;
    this.checkViews();
  }

  /** Render up to 128 frames. Inputs (mic, -, lineL, lineR) are read from this.in. */
  render(frames = RENDER_QUANTUM) {
    this.checkViews();
    this.x.tp_process(frames);
    return [this.out[0], this.out[1]];
  }

  /** Key on the 25-key bed by MIDI note 48..72. */
  key(note, down, velocity = 127) {
    const b = NOTE_TO_BUTTON[note];
    if (b === undefined) return;
    this.x.tp_key(b, note, down ? 1 : 0, velocity);
  }

  openCubbiSlot(p) {
    this.x.tp_open_cubbi_slot(p.pitch, p.start, p.end, p.attack, p.decay, p.autoloop ? 1 : 0, p.sustain ? 1 : 0, p.gain, p.pan);
  }

  cmd(op, a = 0, b = 0) { return this.x.tp_cmd(op, a, b); }
  get(what, arg = 0) { return this.x.tp_get(what, arg); }
  keyPlaying(note) { const b = NOTE_TO_BUTTON[note]; return b !== undefined && !!this.x.tp_key_playing(b); }

  state() {
    const g = (w, a) => this.x.tp_get(w, a);
    const playing = [];
    for (let n = 48; n <= 72; n++) if (this.keyPlaying(n)) playing.push(n);
    const files = [];
    for (let s = 0; s < 15; s++) files.push(!!g(GET.FILE_EXISTS, s));
    return {
      mode: g(GET.VOICE_MODE), bank: g(GET.BANK), slot: g(GET.VOICE_SLOT), voiceBank: g(GET.VOICE_BANK), files,
      looper: {
        empty: !!g(GET.LOOPER_EMPTY), armed: !!g(GET.LOOPER_ARMED), firstRec: !!g(GET.LOOPER_FIRST_REC),
        recording: !!g(GET.LOOPER_RECORDING), playing: !!g(GET.LOOPER_PLAYING), position: g(GET.LOOPER_POSITION),
        pitch: g(GET.LOOPER_PITCH), dubGain: g(GET.LOOPER_DUB_GAIN), reverse: !!g(GET.LOOPER_REVERSE),
        scrub: g(GET.LOOPER_SCRUB), reset: !!g(GET.LOOPER_RESET),
      },
      recording: !!g(GET.RECORDING), vuIn: g(GET.VU_IN), vuOut: g(GET.VU_OUT), fxPre: !!g(GET.FX_PRE),
      input: g(GET.INPUT_SOURCE), monitor: g(GET.MONITOR_MODE), anyVoices: !!g(GET.ANY_VOICES),
      autoloop: !!g(GET.AUTOLOOP), sustain: !!g(GET.SUSTAIN), pitch: g(GET.GLOBAL_PITCH), reverse: !!g(GET.REVERSE),
      pan: g(GET.PAN), copying: !!g(GET.COPYING), erasing: !!g(GET.ERASING), booting: !!g(GET.BOOTING), playing,
    };
  }
}
