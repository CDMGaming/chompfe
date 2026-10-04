# Chompfe

**Play it: <https://cdmgaming.github.io/chompfe/>**

A wavetable synth and a sampler with a tape looper, in the browser. Share it
as a link, play it with the computer keyboard, the mouse, or a MIDI controller.

It runs two engines from the open-source CHOMPI firmware by
[CHOMPI Club](https://github.com/CHOMPI-Club/CHOMPI) (MIT), each compiled to
WebAssembly unchanged and run in an AudioWorklet at 48 kHz:

- **WAVE**: the 8-voice wavetable synth with its note loop, and the seven
  factory wavetables.
- **TAPE**: the sampler: built-in instruments (JAMMI) and drum kits (CUBBI)
  from the factory card, recording from the mic, line in or WAVE, a tape
  looper to overdub on, and effects before or after the tape.

The controls, step grid, LED display and controller support are new.

> Chompfe is an independent project, not affiliated with or endorsed by CHOMPI
> Club or Chase Bliss. CHOMPI is a trademark of CHOMPI Club.

## Status

| Phase | What | State |
|---|---|---|
| 1 | Engine → WASM, factory tables, computer-keyboard play | done |
| 2 | Full on-screen controls, loop recorder + step grid, presets, URL sharing | done |
| 3 | Ableton Push 1 profile, MIDI input | done (untested on hardware) |
| 4 | Arturia MiniLab mkII profile, generic MIDI learn | done (untested on hardware) |
| 5 | Your own wavetables + guide | done |
| 6 | TAPE: sampler, factory sounds, tape looper, effects pre/post, recording, WAVE → TAPE bridge | done |

## Run it locally

Any static file server works, because the app is just files in `web/`. For
local use, `tools/serve.mjs` (Node, no dependencies) serves `web/` with caching
turned off, so a reload always picks up changes:

```bash
node tools/serve.mjs
```

`tools/serve.py` does the same with Python, but on Windows it stalls on the
parallel requests TAPE makes when it loads a bank of sounds, so prefer the Node
one. (If you use another server and changes don't show up, hard-reload with
Ctrl+Shift+R.)

Then open <http://localhost:8080> and click **tap to wake it up**.

Browsers only allow AudioWorklets on `https://` or `localhost`, so opening
`index.html` straight from disk won't work.

### The panel

Chompfe is laid out like the WAVE firmware's hardware (its workflow, not its
look): six push-button knobs, a mode switch, a star key, PLAY and LOOP, and a
25-key keybed. It adds an LED display, which the hardware doesn't have, for
readouts, the wavetable, the loop and step-by-step prompts.
**labels** (top right) shows or hides the tags on every control, and the line
under the panel explains whatever you point at.

- **Knobs**: drag up/down, scroll, or focus and use the arrow keys. **Click**
  a knob to flip between its two pages (dots under it). The caption under each
  knob says what it does right now.
- **Shift**: with the MODE switch down, hold the star key, **tap** it to latch,
  or hold your computer's **Shift**. Captions turn yellow to show the shift
  functions.
- **Shift + click a knob** resets that page. Clicking TEMPO in rhythm taps a
  tempo.

| Knob | Page 1 | Page 1 + shift | Page 2 | Page 2 + shift |
|---|---|---|---|---|
| Pitch | fine tune | half-steps | scan the wavetable | change table |
| Attack | attack | coarse attack | vibrato depth | vibrato rate |
| Decay | release | coarse release | filter LFO depth | filter LFO rate |
| Effects | delay ← → reverb | delay time / reverb size | filter | resonance |
| Tempo | tempo | clock divide | | |
| Volume | volume | compressor | pan | compressor |

- **Keys** play notes (C3–C5). In shift, **white keys 1–14** recall sounds and
  **15** is the default sound. **Black keys**: « » octave, gate 10 / 50 / 100%,
  pitch / filter LFO on/off, and ERASE / COPY / SAVE. For those three: press
  it, pick a white key, then press the star key to confirm. The display walks
  you through it.
- **MODE switch up**: the star key adds a rest while recording and mutes the
  loop while held.
- **Computer keys**: `A S D F G H J K L ; '` are white keys and
  `W E T Y U O P` black keys. `Z`/`X` octave, `C`/`V` velocity. With Shift
  held, they reach the keybed's shift functions (`A` = slot 1, `W` = «, ...).
  `Space` = PLAY, `Enter` = LOOP, `Q` = rest.

Below the panel are drawers for things the hardware doesn't have: the loop as
a 32-step grid, sounds and sharing, wavetables (view, import, export), every
parameter on its own knob (handy for MIDI learn), and a cheat sheet.

### TAPE

Click **tape** at the top right of the panel (it remembers). The same face
relabels for the TAPE firmware; the **tape guide** drawer under it has recipes
and the knob table. In short:

- **Sounds.** Shift + JAMMI plays one sound across the keys; shift + a white
  key picks which. Shift + CUBBI turns every white key into its own sound (the
  drum kits). Pressing JAMMI / CUBBI again steps through the banks (a–e; the
  factory card fills a–c). A bank's sounds load the first time you pick it.
- **The tape.** LOOP records, LOOP again sets the length and keeps recording
  on top, LOOP again stops. Pick another sound and overdub. Shift + PLAY / LOOP
  sets how much older layers fade. The TAPE knob changes tape speed (and
  direction), or scrubs when stopped.
- **Effects.** MAGIC: reverb + delay, lo-fi, filter (press for pages; shift
  for delay time, warble, resonance). Shift + FX PRE records them onto the
  tape, shift + FX POST applies them after it.
- **Recording.** Turn on **mic / line in** (or **wave → tape**), pick the
  source with shift + MIC / LINE / RESAMPLE, flip the mode switch up and hold
  the star key. Shift + SAVE stores the take in a slot (or on the tape).
  Shift + COPY / ERASE work the same way.
- **WAVE → TAPE.** With the bridge on, WAVE keeps running underneath as
  TAPE's line input, so a WAVE loop can be recorded as a sound or onto the tape.
- **Your card.** What you save, copy or erase is kept in this browser
  (IndexedDB), like an SD card; per-slot settings (speed, start, end, envelope,
  level, pan) too. "forget my TAPE sounds" in the guide resets it.

Computer keys play TAPE the same way (A = middle C, the sample's own pitch);
Space / Enter are PLAY / LOOP and Q is the star key.

### The loop (the hardware's note-loop recorder)

| Button | Key | What it does |
|---|---|---|
| **play** | `Space` | Start/stop the loop |
| **loop** | `Enter` | Tap: arm/disarm recording. Hold ~1.25 s: delete the last step |
| **play + loop** | `Space`+`Enter` | Hold both ~1.25 s: clear the loop |
| **rest / mute** | `Q` | While recording: add a rest. Otherwise: hold to mute the loop |

Recording works two ways:

- **Loop stopped:** each key you **let go of** becomes the next step (that's
  how the hardware does it), up to 32 steps. **rest** adds an empty step.
- **Loop playing:** each note you play replaces the step under the playhead,
  rounded to the nearer step, and the loop keeps its length (overdub). **rest**
  clears the step under the playhead. This one is a Chompfe addition; the
  hardware always appended.

MIDI keyboards and pads record too.

The same 32 steps are shown as a grid. The **selected note** is the last note
you played (shown next to the loop length). Click a step to put the selected
note there; click a step that already has it to make it a rest (right-click or
Delete also clears). Click past the end to extend the loop. Drag a step up/down
(or scroll, or use the arrow keys) to change its note. Tempo, tap tempo, step
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

## Your own wavetables

Click **load your own…** under the wavetable slots, or drag a file onto a
slot. Chompfe works out what it is:

- **A wavetable** (Serum-style: frames of 2048 samples back to back, or any
  frame size given in the file's `clm` chunk). 33 frames fit exactly; other
  counts are spread across the 33 frames.
- **A recording** (anything else): pick the stretch you want with **start** and
  **end**, and Chompfe turns it into 33 frames that scan through that stretch.

WAV works in every browser. MP3, M4A (phone voice memos), OGG and FLAC work
where the browser can decode them (Chrome and Edge decode all of these;
Safari decodes MP3/M4A).

The new table is loaded into the slot straight away, so you can play while you
adjust. **keep it** saves it in this browser (it's still there next visit);
**cancel** puts the old table back. Under the slots:

- **save .wav** downloads the current slot as a wavetable file. It has the same
  byte layout as the factory files (audio from byte 136, a `clm` chunk), so
  other wavetable synths can open it, and it should also load on the original
  hardware's SD card (not tested on hardware).
- **back to factory** puts the original table back in that slot.

Share links carry settings, not tables, because a table is ~270 KB. If your
sound uses your own table, send the `.wav` along with the link; your friend
drops it into the same slot.

### Making tables from your own recordings

**How it works.** The oscillator plays one 2048-sample cycle at a time, and the
**Frame** knob moves through 33 of them. A good table is a sound that *changes
over time*, captured one cycle at a time: frame 1 is the start of your stretch,
frame 33 the end. When you play, the table follows your keyboard; the pitch of
the recording doesn't matter.

There are two ways to turn a recording into frames (**auto** picks for you):

- **one cycle per frame**: for anything with a clear pitch (voice, a held
  instrument note, another synth). Chompfe finds the pitch, cuts exactly one
  real cycle at 33 points in your stretch and stretches each to 2048 samples.
  This keeps the actual character of the sound.
- **spectral**: for anything without a steady pitch (drums, noise, breath,
  field recordings, chords). Each frame is rebuilt from the sound's spectrum
  at that point (its first 255 partials). Expect breathy, glassy, vocal-ish
  textures rather than a copy of the sound.

**Recording tips**

1. **One held note**, not a melody or chord. Hum, sing, bow, or hold a key.
   Pitches between about 50 Hz and 1 kHz are detected best (most voices and
   instruments).
2. **Make it change on purpose.** That change is what the Frame knob will
   play. Ideas:
   - sing a slow vowel sweep: "ooo → aaa → eee";
   - open or close a filter on another synth while holding a note;
   - pluck a string and let it ring out (bright → dull);
   - blow across a bottle harder and softer;
   - whistle while slowly moving your tongue.
3. **Keep it steady and dry.** Little vibrato, no glide, no reverb or delay on
   the recording (they smear the cycles). A quiet room helps.
4. **A few seconds is plenty.** 1–4 s gives a smooth sweep; trim the attack and
   any silence with **start** / **end**.
5. A phone voice memo is fine. Mono or stereo both work (stereo is mixed down).

**In Chompfe**

1. Drop the file on a slot.
2. Drag **start** and **end** so the highlighted part is the bit you like
   (skip the first moment of a note; it's often noisy).
3. Play some keys and turn **Frame** while the dialog is open. Try both
   conversion modes.
4. **keep it**. Then **save .wav** if you want the file for later or to send
   to a friend.

**Good to know**

- Every table is normalised to the same level as the factory tables, and DC
  offset is removed, so imports don't jump out in volume.
- The engine plays tables as they are, without band-limiting, like the
  original. Very bright tables (lots of high harmonics) get gritty on high
  notes. That's part of the character; use the filter, or the spectral mode,
  which keeps only 255 partials.
- If pitch detection fails ("No steady pitch found"), choose a steadier
  stretch, or use spectral.
- If you'd rather build tables elsewhere: any editor that exports Serum-style
  wavetables (frames of 2048 samples, mono) works, with any number of frames.

## MIDI controllers

Click **connect MIDI** in **Chrome or Edge**. Safari has no Web MIDI.
Firefox puts Web MIDI behind a one-time "site permission add-on" for each
site; on a local server it may just refuse with "WebMIDI requires a site
permission add-on to activate". Use Chrome or Edge for controllers (the
computer keyboard and mouse work everywhere). Allow SysEx when asked; the Push display needs it.
Devices are recognised by port name. Once connected, the MIDI button opens a
panel listing your devices and learned mappings.

### Any MIDI device

Anything without a built-in profile plays notes (any channel, recorded into
the loop), with pitch bend (±2 semitones on top of the Pitch knob), sustain
(CC 64) and the mod wheel on vibrato depth. It also understands the hardware
firmware's own CC map, so a DAW or controller set up for the original works:

| CC | | CC | |
|---|---|---|---|
| 20 | Pitch | 26 | Frame |
| 21 | Attack | 27 | Vibrato depth |
| 22 | Release | 28 | Wobble depth |
| 23 | Delay / Reverb | 29 | Filter |
| 25 | Level | 30 | Pan |
| 14 | Rest / mute key | 15 | Loop key |

With TAPE up, it speaks TAPE's own map instead (ui.h): CC 20–25 set the six
knobs (Speed, Start, End, Magic, Tape, Volume) on their current page, CC 26 /
27 are PLAY / LOOP; notes play TAPE (MIDI 24–72, middle C = the sample's own
pitch; in CUBBI the white keys are the kit).

### MIDI learn

MIDI → **learn a control…**, click anything on screen (a knob, an on/off
switch, the octave/step/gate buttons, a wavetable or sound slot, play / loop /
rest / tap / clear), then move a knob or press a button on any controller.
Chompfe works out whether it's an absolute knob, a relative encoder or a
button; you can change that in the MIDI panel. Mappings are per device, saved
in this browser, and take priority over the built-in layouts. Controls with a
mapping get a small blue dot. **Esc** or **done** ends learn mode.

### Arturia MiniLab mkII

Works with the factory preset (memory 1, "Analog Lab"); the CC/note numbers
were cross-checked against Ardour's MiniLab mkII map and two other drivers.

| Knob | | Knob | |
|---|---|---|---|
| 1 (endless) | Frame scan; click = first frame | 9 (endless) | Wavetable; click = cycle octave |
| 2 | Pitch | 10 | Wobble amount |
| 3 | Attack | 11 | Wobble rate |
| 4 | Release | 12 | Vibrato amount |
| 5 | Filter | 13 | Vibrato rate |
| 6 | Resonance | 14 | Delay time / size |
| 7 | Delay / Reverb | 15 | Squash |
| 8 | Level | 16 | Tempo |

- **Pads 1–7** pick wavetables 1–7 (current one white), **pad 8** plays/stops
  the loop (green = playing, yellow = loop ready).
- **Pads 9–16** (pad bank 2) load sound slots 1–8 (white = current, magenta =
  saved, dark = empty).
- Keys, pitch/mod strips and sustain work as above.
- The MiniLab's knobs are absolute, so the first turn after loading a sound
  jumps the value to where the knob is (same as the hardware's MIDI input).

With TAPE up: knobs 2–6 are Speed, Start, End, Magic and Volume (on their
current page), knob 8 the output level, endless knob 1 the Tape knob (click:
back to 1x) and endless knob 9 the Magic knob (click: next page). Pads 1–8 are
sounds 1–8 (CUBBI: play them; JAMMI: pick one). Pads 9–16: JAMMI, CUBBI, FX
before/after the tape, input (mic → line → resample), PLAY, LOOP, the star key
(press on, press off) and the mode switch.


### Ableton Push (1st generation)

Plug it in. Quit Live first (on Windows only one program can use a MIDI port
at a time). Chompfe switches the Push into Live mode, writes the display and
LEDs on its first port, and listens on both of its ports.

If something doesn't respond, open the MIDI panel: the **Incoming** box shows
every message as it arrives and which port it came on.

```
 [enc1] [enc2] [enc3] [enc4] [enc5] [enc6] [enc7] [enc8]   [tempo] [swing=frame]  [master=out]
 ┌──────────────────────────── LCD ───────────────────────────┐
 │ param names                                                │
 │ values                                                     │
 │ bar graphs                                                 │
 │ Sound  Motion  Out/Seq  Scale  <snd  snd>  sound  loop     │  <- labels for the row below
 └────────────────────────────────────────────────────────────┘
 [Sound][Motion][Out/Seq][Scale][<snd][snd>][   ][   ]   upper row: pages, previous/next sound
 [ r  ][  r  ][   r   ][  r  ][ r  ][ r  ][ r ][ r ]   lower row: reset (or toggle) the knob above
 ┌─────────── pads ───────────┐  [gate 10%]
 │ steps  1-8                 │  [gate 50%]   scene buttons
 │ steps  9-16      (Session) │  [gate 100%]
 │ steps 17-24                │  [1/4] [1/8.] [1/8] [1/8T] [1/16]  step length
 │ steps 25-32                │
 │ in-key keys (4 rows)       │
 └────────────────────────────┘
```

| Page | Encoders 1-8 |
|---|---|
| Sound | Table, Frame, Pitch, Filter, Resonance, Attack, Release, Delay/Reverb |
| Motion | Wobble amount/rate/on, Vibrato amount/rate/on, FX time, Octave |
| Out/Seq | Squash, Level, Pan, Tempo, Step length, Gate, Loop length, Output level |
| Scale | Root, Scale, In key / chromatic, Pad octave |

- **Shift** + encoder = fine. **Delete** + touching an encoder resets it.
- **Session** button: top half is the 32-step loop, bottom half is an in-key
  keyboard. Play a key pad to select a note (it stays sky blue), then tap steps
  to place it; tapping a step that already has that note clears it. Or hold a
  step and hit a key to set just that step,
  **Shift** + step sets the loop length there, **Delete** + step makes it a rest.
  The playing step is white while the gate holds the note, so you can see the
  gate length; green steps have notes, grey ones are rests.
- **Note** button: all 64 pads are an in-key keyboard (rows a fourth apart,
  like Live). Roots are blue, scale notes white, sounding notes green.
  **Octave up/down** shift it; **Scale** jumps to the Scale page.
- **Play** = play, **Record** = loop (record), **Mute** = rest/mute. They keep
  the hold gestures: hold Record to delete the last step, hold Play + Record to
  clear. **Tap Tempo** taps.

**TAPE on the Push.** Upper-row button 8 (">TAPE" on the display) switches
to TAPE, and the Push follows:

- **Encoders 1–6** are TAPE's knobs (Speed, Start, End, Magic, Tape, Volume),
  encoder 7 the output level; the tempo encoder is the Tape knob too. **Shift**
  is TAPE's shift, so Shift + encoder is the knob's shift function.
- **Buttons under encoders 1–6** press the knob (next page; with Shift, its
  reset / toggle). Under 7: the mode switch (red = record mode). Under 8:
  the wave → tape bridge.
- **Upper row 1–7**: JAMMI, CUBBI, MIC, LINE, RESAMPLE, FX PRE, FX POST.
  Button 8 goes back to WAVE.
- **Session mode, top half**: the left 4×4 block is sounds 1–15 plus the tape.
  In JAMMI a tap picks the sound, in CUBBI the block is a drum pad kit, and
  while erasing / copying / saving it picks the slot. Top row on the right:
  ERASE, COPY, SAVE and the star key (confirm).
- The key pads, Note / Session, Scale and octave work as in WAVE, playing TAPE.
- **Play** / **Record** are PLAY / LOOP, **Mute** is the star key (hold it in
  record mode to record).
- The pads and buttons show the firmware's own key and knob colours.

The MIDI details (SysEx display format, pad/encoder/button numbers, LED colour
values) were checked against Ableton's own Push remote script, not guessed.
`node tools/push1-test.mjs` checks the profile against a fake Push.

## Hosting

Every push to `main` publishes `web/` to GitHub Pages
(`.github/workflows/pages.yml`). Any other static host works too; upload the
`web/` folder.

## Build the engine

The compiled `web/chompfe.wasm` and `web/tape.wasm` are committed, so you
only need this if you change the C++.

1. Install [Emscripten](https://emscripten.org/docs/getting_started/downloads.html)
   (`emsdk install latest && emsdk activate latest`).
2. `bash engine/build.sh` builds WAVE, `bash engine/build-tape.sh` builds TAPE
   (both look for `em++` on PATH, else `$EMSDK` or `~/emsdk`).
3. `node tools/render-test.mjs` renders test notes offline into `test-out/*.wav`
   and checks pitch, release, reverb tail and sequencer timing.
   `node tools/push1-test.mjs` and `node tools/controllers-test.mjs` check
   the Push, MiniLab, generic and MIDI-learn code against fake devices.
   `node tools/panel-test.mjs` checks the panel against the WAVE manual.
   `node tools/wavetable-test.mjs` checks importing (pitch detection,
   one-cycle frames, spectral mode) and the export file layout.
   `node tools/tape-test.mjs` checks the TAPE engine (card, boot copier,
   JAMMI / CUBBI, the looper, FX routing, line-in recording) and
   `node tools/tape-ui-test.mjs` drives it through the ported control layer
   (shift page, banks, per-slot settings, record / save / copy / erase, the
   looper keys). Both need the factory samples in `upstream/` (below).

The factory TAPE sounds ship as lossless FLAC (`web/samples/tape/`, ~36 MB
instead of ~112 MB of WAV). `python tools/make-tape-samples.py` makes them from
the card profile in `upstream/` and writes `index.json` with a checksum per
file; the page decodes each FLAC, checks it against that checksum and hands
the engine the original 16-bit WAV bytes.

To re-vendor from upstream: clone the CHOMPI repo into `upstream/` and run
`bash engine/vendor.sh` (WAVE and TAPE sources). It records the commit in
`engine/vendor/UPSTREAM.txt`.

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
  vendor/tape/       TAPE 2.0 engine sources (DSPEngine, looper, sampler, file
                     copier, effects), byte-identical
  vendor/coreJSON/   coreJSON (FreeRTOS / Amazon, MIT), as TAPE ships it
  shim-tape/         TAPE's hardware stand-ins: an in-memory FatFs "SD card"
                     (memfs.cpp), daisy.h; override/ holds the one portability
                     fix (Warble.h, a wasm32 overload ambiguity)
  src/tape.cpp       TAPE's C API: init, process, card files, boot scan, keys,
                     engine setters and getters
web/
  chompfe.wasm       built WAVE engine (no imports, ~40 KB)
  tape.wasm          built TAPE engine (~90 KB)
  samples/tape/      factory TAPE sounds, FLAC, + index.json
  js/worklet.js      AudioWorkletProcessor that hosts both engines
  js/engine.js       WAVE wasm wrapper (shared by the worklet and the Node test)
  js/tape-engine.js  TAPE wasm wrapper (same)
  js/cardstore.js    your TAPE card changes, kept in the browser (IndexedDB)
  js/synth.js        AudioContext graph, table loading, messaging
  js/params.js       parameter names, ranges, value readouts
  js/wavetable.js    WAV parser, table shaping, recording -> table, export
  js/tablestore.js   custom tables saved in the browser (IndexedDB)
  js/ui/importer.js  import dialog
  js/patch.js        presets, share links, session restore
  js/ui/knob.js      knob control
  js/ui/seqgrid.js   32-step grid
  js/app.js          UI wiring, keyboards, transport, controller API
  js/panel/          the instrument: firmware-ui.js (WAVE's control logic,
                     ported), tape-ui.js (TAPE's NormalPage / MenuPage, ported),
                     panel.js (DOM, LEDs, display), ledmatrix.js (display)
  js/midi/manager.js Web MIDI, device detection by port name
  js/midi/push1.js   Push 1 profile
  js/midi/minilab2.js MiniLab mkII profile
  js/midi/generic.js notes, bend, sustain, firmware CC map
  js/midi/learn.js   MIDI learn
  js/scales.js       scales + pad layouts
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
  panel keys record; here every note source does (computer keyboard, mouse,
  MIDI keys and pads).
- **Step grid.** The firmware has no grid, but its sequence is already 32
  steps of note-or-rest plus a length, so the grid edits that same data.
- **Pitch.** The engine plays an octave below concert pitch for a given MIDI
  note (MIDI 69 → 220 Hz). That is how the firmware maps notes, so it's kept.

For TAPE:

- **Nothing in the DSP or the file handling.** The sampler voices, looper,
  file streaming, file copier and effects are compiled as shipped; the SD card
  is an in-memory FatFs, so even save / copy / erase run the firmware's own
  code. The knob, key and shift-page logic (NormalPage.h, MenuPage.h, ui.h) is
  ported to JS line by line.
- **Settings as on the factory card**: record latch off, tape slew on, input
  monitor "both", pitch steps in the shift layer, delay not split.
- **Inputs.** The browser's audio input is both the mic (mono) and the line
  in (stereo); with the bridge on, WAVE replaces the line in. WAVE is lifted
  18 dB on the way in (its usual output gain), and TAPE is trimmed 18 dB on the
  way out, so both engines sit at the same level behind the "out" slider.
- **Output.** The page plays TAPE's line output, not its headphone output, so
  the "headphones only" monitor setting really keeps the input out of the
  speakers.
- **Additions:** a tap on the star key latches shift (as in WAVE here), and the
  LED display (the sample with its start-end window, tape position, prompts).

## Credits and license

- Engines, factory wavetables and factory sounds: CHOMPI WAVE and TAPE 2.0
  firmware and card profiles, © 2026 CHOMPI Club, MIT. Electrosmith engineered
  the original platform and firmware (including TAPE through 1.0.9); TAPE 2.0
  and WAVE were written at Chase Bliss.
- coreJSON: © FreeRTOS / Amazon, MIT.
- DaisySP and libDaisy: © Electrosmith, MIT.
- Reverb, FX engine and limiter: derived from Émilie Gillet's Mutable
  Instruments code, MIT.

See [LICENSE](LICENSE) for the full notices.
