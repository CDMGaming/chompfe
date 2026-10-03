# Redesign plan: WAVE-style panel + LED display (built 2026-10-03; kept for reference)

Decisions (from Felix, 2026-10-03):
- **Layout:** the WAVE-style instrument panel is the main view. Collapsible
  drawers below hold the extras: 32-step grid, sounds/sharing, wavetables
  (import), MIDI, an "all parameters" rack (keep it: MIDI learn needs
  single-param targets), and a cheat sheet.
- **Style:** light, cozy, illustrated (reference: temeculadsp.com/nibbi/play).
  Cream page, hand-drawn doodle frame, chunky pastel instrument. All our own
  artwork and mascot. No CHOMPI name, character or panel look (TRADEMARKS.md):
  copy the workflow and control layout only. Avoid CHOMPI's key colours
  (pink ✱ key, teal play, yellow loop).
- **Shift:** shift layers are fine if they're clearly labelled. Labels swap
  or highlight while shift is held. Add a label on/off toggle and a hint line
  that explains the hovered control.

## Source: official WAVE Quick Start Guide (chompiclub.com/manuals, beta 1.1)

Panel: mode switch, ✱ key (shift/rest), knobs PITCH, ATTACK, DECAY, EFFECTS,
TRANSPORT (big), VOLUME, each with an LED; PLAY, LOOP; 10 black + 15 white keys
(MIDI 48-72).

| Knob | P1 turn | P1 shift+turn | P2 turn | P2 shift+turn |
|---|---|---|---|---|
| Pitch | fine tune (.003/detent) | half-steps | scan frame (1/detent) | change table (2 detents) |
| Attack | attack (.003) | coarse (.03) | pitch LFO depth | pitch LFO rate |
| Decay | release (.003) | coarse (.03) | filter LFO depth | filter LFO rate |
| Effects | delay <-> reverb | delay time / size | filter | resonance |
| Transport (1 page) | tempo (+1 unit) | clock div (12 detents/step) | | |
| Volume | volume | compressor | pan | compressor |

- **Knob presses:** press = flip page; shift+press = reset that page (code:
  MenuPage.h ~588-698). Transport press = tap tempo; shift+press = tempo 320,
  default clock div.
- **Shift:** switch down + hold ✱. Switch up: ✱ = rest while recording, mute
  otherwise.
- **Keys under shift:**
  - white keys 1-14 = sound slots, 15 = default (can't save over it);
  - black keys = « » octave, gate 10/50/100, LFO pitch/filter on/off
    (yellow LED = on), erase/copy/save (red/green/blue).
- **Preset flow:** press erase/copy/save → pick a white key → press ✱ to
  confirm (copy: pick source, then destination). The shift menu stays open
  until done.
- **Table names:** 1 Classic Console, 2 Harmonic Bloom, 3 FM Bells & Metal,
  4 Wavefolder, 5 Vowels, 6 Degradation, 7 Sample Platter.
- **MIDI in:** CC 20/21/22/23/25 move the knobs on their *current* page; CC
  14/15 = ✱/loop. (generic.js currently maps 20-25 to page 1 and 26-30 to
  page 2; make it page-relative.)
- **MIDI out (not built yet):** notes from keys and sequencer, start/stop,
  clock, CC 20-25 (page 1) / 26-30 (page 2).

## Knob LED colours (port from NormalPage.h Draw, temp_led_stuff.h)
- `xfade(a,b,t)`
- `triple(a,b,c,t)`: split at .5
- `quad(a,b,c,d,t)`: split at .33/.66
- **Per knob/page:**
  - pitch: quad(med_blue, green, yellow, red); frame: triple(blue, pink, red)
  - attack: xfade(yellow, orange); pitch LFO depth: xfade(purple*.2, purple)
  - decay: xfade(orange, red); filter LFO depth: same purple
  - fx: triple(green, (green+blue)/2, blue); filter: triple(purple, pink, white)
  - transport: quad(med_blue, green, yellow, red), alternating on beats
  - volume: VU-tinted; pan: xfade(blue, red)
- **Colours:** white 1,1,1; red 1,0,0; orange 1,.6,.24; yellow 1,.95,.05;
  green 0,1,0; teal .14,1,.92; med_blue 0,.84,1; blue 0,0,1; purple .58,.05,1;
  pink 1,.36,.62.

## Build steps
1. `web/js/panel/firmware-ui.js`: a JS port of the NormalPage/MenuPage logic
   (pages, shift, presses, preset modes, LED colours) driving the existing
   `api`.
2. `web/js/panel/panel.js` + CSS: panel markup, knobs (drag/wheel/keys = detents),
   mode switch, ✱ (tap = latch, hold = momentary; computer Shift = shift),
   25-key keybed with LED dots and shift labels.
3. `web/js/panel/ledmatrix.js`: dot-matrix canvas (~96x20) with a 5x7 font.
   Shows the param name/value/bar on change (from any source), the waveform
   when idle, loop steps, preset-mode prompts and a boot animation.
4. `index.html`: header, then panel, then hint line, then drawers. Move the
   existing sections into drawers.
5. Doodle frame SVG and our own mascot.
6. Tests: a firmware-ui unit test against `tools/fake-api.mjs`.
