// Fallback for any MIDI device without a profile:
//   notes (any channel), pitch bend (±2 semitones), sustain (CC 64),
//   mod wheel (CC 1) -> vibrato depth,
//   and the hardware firmware's own CC map, so anything set up for it works:
//     CC 20/21/22/23/25 move the Pitch/Attack/Decay/Effects/Volume knobs on
//     whatever page each is on (as the manual says); CC 26-30 are the page-2
//     values the hardware sends out: frame, vibrato depth, filter LFO depth,
//     filter, pan
//     CC 14 rest/mute key, CC 15 loop key (top third = press, bottom third = release)
// Anything else can be mapped with MIDI learn, which takes precedence.
export const id = 'generic';
export const label = 'MIDI keys';

export function match() { return false; }

export function create({ input, api }) {
  const { P } = api;
  const src = (note) => `midi:${input.id}:${note}`;
  const FIRMWARE_CC = {
    20: P.PITCH, 21: P.ATTACK, 22: P.RELEASE, 23: P.FX, 25: P.GAIN,
    26: P.FRAME, 27: P.PITCH_LFO_DEPTH, 28: P.FILTER_LFO_DEPTH, 29: P.CUTOFF, 30: P.PAN,
  };
  const keyCC = { 14: false, 15: false };
  // WAVE manual: CC 20/21/22/23/25 move Pitch/Attack/Decay/Effects/Volume on their current page
  const KNOB_CC = { 20: 0, 21: 1, 22: 2, 23: 3, 25: 5 };

  return {
    onMessage(d) {
      const st = d[0] & 0xf0;
      if (st === 0x90 && d[2] > 0) api.noteOn(src(d[1]), d[1], d[2]);
      else if (st === 0x80 || (st === 0x90 && d[2] === 0)) api.noteOff(src(d[1]));
      else if (st === 0xe0) api.bend((((d[2] << 7) | d[1]) - 8192) / 8192 * 2);
      else if (st === 0xb0) {
        const cc = d[1];
        const v = d[2];
        if (cc === 64) api.sustain(v >= 64);
        else if (cc === 1) api.set(P.PITCH_LFO_DEPTH, v / 127);
        else if (cc === 123 || cc === 120) api.allNotesOff();
        else if (KNOB_CC[cc] !== undefined && api.knobAbs) {
          api.knobAbs(KNOB_CC[cc], v / 127); // the panel knob, on whatever page it's on
        } else if (cc in FIRMWARE_CC) {
          const p = api.BY_ID[FIRMWARE_CC[cc]];
          api.set(p.id, p.min + (v / 127) * (p.max - p.min)); // MidiManager: value / 127
        } else if (cc === 14 || cc === 15) {
          // MidiManager.h: >84 press, <42 release, dead zone between
          const was = keyCC[cc];
          if (v > 84) keyCC[cc] = true;
          else if (v < 42) keyCC[cc] = false;
          if (was !== keyCC[cc]) (cc === 14 ? api.rest : api.loop)(keyCC[cc]);
        }
      }
    },
    destroy() {
      api.releaseSources(`midi:${input.id}:`);
      api.bend(0);
    },
  };
}
