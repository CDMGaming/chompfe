# Chompfe

An 8-voice wavetable synth that runs in the browser. Share it as a link, play
it with the computer keyboard, the mouse, or a MIDI controller.

The sound engine is the DSP from the open-source **CHOMPI WAVE** firmware by
[CHOMPI Club](https://github.com/CHOMPI-Club/CHOMPI) (MIT), compiled to
WebAssembly unchanged and run in an AudioWorklet at 48 kHz. The seven factory
wavetables come from the same release. The controls, step grid and controller
support are new.

> Chompfe is an independent project, not affiliated with or endorsed by CHOMPI
> Club or Chase Bliss. CHOMPI is a trademark of CHOMPI Club.

## Status

| Phase | What | State |
|---|---|---|
| 1 | Engine → WASM, factory tables, computer-keyboard play | done |
| 2 | Full on-screen controls, loop recorder + step grid, presets, URL sharing | done |
| 3 | Ableton Push 1 profile | next |
| 4 | Arturia MiniLab mkII profile, generic MIDI learn | |
| 5 | Custom wavetable import + guide | |

## Run it locally

Any static file server works, because the app is just files in `web/`. With
Python:

```bash
python -m http.server 8080 --directory web
```

Then open <http://localhost:8080> and click **tap to wake it up**.

Browsers only allow AudioWorklets on `https://` or `localhost`, so opening
`index.html` straight from disk won't work.

### Playing

- **Keys:** `A S D F G H J K L ; '` are the white keys and `W E T Y U O P` the
  black keys, laid out like a piano. `A` is MIDI note 60.
- **Octave:** `Z` / `X`. **Velocity:** `C` / `V`.
- **Mouse/touch:** the on-screen keys (C3–C5, the hardware's 25-key range).
  Clicking higher on a key plays softer. You can slide between keys.
- **Knobs:** drag up/down (hold Shift for fine), scroll, or focus and use the
  arrow keys. Double-click or Backspace resets.

### The loop (the hardware's note-loop recorder)

| Button | Key | What it does |
|---|---|---|
| **play** | `Space` | Start/stop the loop |
| **loop** | `Enter` | Tap: arm/disarm recording. Hold ~1.25 s: delete the last step |
| **play + loop** | `Space`+`Enter` | Hold both ~1.25 s: clear the loop |
| **rest / mute** | `Q` | While recording: add a rest. Otherwise: hold to mute the loop |

While recording, each key you **let go of** becomes the next step (that's how
the firmware does it), up to 32 steps. Once MIDI input lands (Phase 3),
MIDI keyboards will record too.

The same 32 steps are shown as a grid. Click a step to switch it between note
and rest, click past the end to extend the loop, drag a step up/down (or
scroll, or use the arrow keys) to change its note. Tempo, tap tempo, step
length and gate (10 / 50 / 100 %, the hardware's three choices) are next to it.

### Sounds and links

- **14 sound slots**, like the hardware, saved in your browser. Slots 1–6 start
  with starter sounds; they're starting points I picked from the parameter
  ranges, not tuned by ear, so overwrite them. **save…** / **erase…** then
  click a slot. **init** is the default sound.
- **copy link** puts the whole state (sound, loop, tempo, step length, gate)
  in the URL, about 100 characters, and copies it. Opening the link loads that
  state. Nothing is sent to a server; it's all in the part after `#`.
- The last state is also remembered in this browser between visits.

## Build the engine

The compiled `web/chompfe.wasm` is committed, so you only need this if you
change the C++.

1. Install [Emscripten](https://emscripten.org/docs/getting_started/downloads.html)
   (`emsdk install latest && emsdk activate latest`).
2. `bash engine/build.sh` (looks for `em++` on PATH, else `$EMSDK` or `~/emsdk`).
3. `node tools/render-test.mjs` renders test notes offline into `test-out/*.wav`
   and checks pitch, release, reverb tail and sequencer timing.

To re-vendor from upstream: clone the CHOMPI repo into `upstream/` and run
`bash engine/vendor.sh`. It records the commit in `engine/vendor/UPSTREAM.txt`.

## How it's put together

```
engine/
  vendor/firmware/   DSP headers from firmware/chompi-wave/code/src, byte-identical
  vendor/DaisySP/    DaisySP as shipped with the firmware (Electrosmith, MIT)
  vendor/libDaisy/   just util/FIFO.h (Electrosmith, MIT)
  shim/              stand-ins for the hardware: daisy.h, fatfs.h,
                     FileStreamingManager.h, hardware.h
  src/chompfe.cpp    the C API: init, process, note on/off, params, tables,
                     sequencer, MIDI-out queue
web/
  chompfe.wasm       built engine (no imports, ~40 KB)
  js/worklet.js      AudioWorkletProcessor that hosts the wasm
  js/engine.js       wasm wrapper (shared by the worklet and the Node test)
  js/synth.js        AudioContext graph, table loading, messaging
  js/params.js       parameter names, ranges, value readouts
  js/wavetable.js    WAV parser + 33x2048 table shaping
  js/patch.js        presets, share links, session restore
  js/ui/knob.js      knob control
  js/ui/seqgrid.js   32-step grid
  js/app.js          UI wiring, keyboards, transport
  wavetables/        the 7 factory tables (Serum format)
tools/render-test.mjs  offline render + checks
```

### What changed from the hardware, and why

- **Nothing in the DSP.** `subtractiveEngine.h`, `WavetableManager.h`, the
  filter, reverb, delay, limiter, sequencer and clock are compiled as shipped.
  Only `hardware.h`, the SD-card loader, the LED/page UI and the libDaisy
  platform layer are replaced (see `engine/shim/`).
- **Tables come from memory, not the SD card.** JS parses the WAV and copies
  33 × 2048 floats into the same memory layout the card loader filled.
- **Timing.** The firmware's `System::GetNow()` millisecond clock is derived
  from the number of samples rendered, so the sequencer is locked to the audio.
  The engine runs in 32-sample sub-blocks (the hardware used about 24), because
  it starts one queued note per block and a 128-sample block would smear chords.
- **Output level.** Each voice is scaled by 0.2 and the mix is divided by 8, so
  one note leaves the engine around -35 dBFS. The hardware made that up in its
  analog output stage. Chompfe adds an output gain (default +18 dB, the "out"
  slider) and a limiter after the engine.
- **Loop recording from every note source.** On the hardware only the front
  panel keys record; here every note source will (keyboard, mouse, and MIDI
  once it's added).
- **Step grid.** The firmware has no grid, but its sequence is already 32
  steps of note-or-rest plus a length, so the grid edits that same data.
- **Pitch.** The engine plays an octave below concert pitch for a given MIDI
  note (MIDI 69 → 220 Hz). That is how the firmware maps notes, so it's kept.

## Credits and license

- Engine and factory wavetables: CHOMPI WAVE firmware, © 2026 CHOMPI Club, MIT.
  Electrosmith engineered the original platform and firmware; WAVE was written
  at Chase Bliss.
- DaisySP and libDaisy: © Electrosmith, MIT.
- Reverb, FX engine and limiter: derived from Émilie Gillet's Mutable
  Instruments code, MIT.

See [LICENSE](LICENSE) for the full notices.
