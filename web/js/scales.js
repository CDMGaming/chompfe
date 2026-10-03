// Scales for in-key pad layouts.
export const ROOTS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export const SCALES = [
  { name: 'Major', steps: [0, 2, 4, 5, 7, 9, 11] },
  { name: 'Minor', steps: [0, 2, 3, 5, 7, 8, 10] },
  { name: 'Dorian', steps: [0, 2, 3, 5, 7, 9, 10] },
  { name: 'Mixolydian', steps: [0, 2, 4, 5, 7, 9, 10] },
  { name: 'Lydian', steps: [0, 2, 4, 6, 7, 9, 11] },
  { name: 'Phrygian', steps: [0, 1, 3, 5, 7, 8, 10] },
  { name: 'Locrian', steps: [0, 1, 3, 5, 6, 8, 10] },
  { name: 'Harm minor', steps: [0, 2, 3, 5, 7, 8, 11] },
  { name: 'Mel minor', steps: [0, 2, 3, 5, 7, 9, 11] },
  { name: 'Maj penta', steps: [0, 2, 4, 7, 9] },
  { name: 'Min penta', steps: [0, 3, 5, 7, 10] },
  { name: 'Blues', steps: [0, 3, 5, 6, 7, 10] },
  { name: 'Whole tone', steps: [0, 2, 4, 6, 8, 10] },
  { name: 'Chromatic', steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
];

/** True if `note` belongs to the scale on `root`. */
export function inScale(note, root, scale) {
  return scale.steps.includes((((note - root) % 12) + 12) % 12);
}

/**
 * Note for a pad in an 8-wide grid, Push style.
 * In key: each column is the next scale degree, each row up is +3 degrees
 * (a fourth in 7-note scales). Chromatic: columns are semitones, rows +5.
 * @param {number} col 0..7
 * @param {number} rowFromBottom 0..7
 * @param {number} base lowest note (bottom-left pad, a root)
 */
export function padNote(col, rowFromBottom, base, scale, inKey) {
  if (!inKey) return base + col + rowFromBottom * 5;
  const n = scale.steps.length;
  const degree = col + rowFromBottom * 3;
  return base + Math.floor(degree / n) * 12 + scale.steps[degree % n];
}
