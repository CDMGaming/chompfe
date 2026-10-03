// Fallback for any MIDI device without a profile: notes in (all channels).
// MIDI learn for knobs arrives in phase 4.
export const id = 'generic';
export const label = 'MIDI keys';

export function match() { return false; }

export function create({ input, api }) {
  const src = (note) => `midi:${input.id}:${note}`;
  return {
    onMessage(d) {
      const st = d[0] & 0xf0;
      if (st === 0x90 && d[2] > 0) api.noteOn(src(d[1]), d[1], d[2]);
      else if (st === 0x80 || (st === 0x90 && d[2] === 0)) api.noteOff(src(d[1]));
      else if (st === 0xb0 && (d[1] === 123 || d[1] === 120)) api.allNotesOff(); // all notes / sound off
    },
    destroy() { api.releaseSources(`midi:${input.id}:`); },
  };
}
