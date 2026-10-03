// A dot-matrix LED display, drawn on a canvas. The hardware has no screen;
// this one shows what the knobs are doing, the wavetable, the loop, and
// step-by-step prompts.

export const COLS = 120;
export const ROWS = 24;

// 5x7 font: 7 rows per glyph, 5 bits per row (bit 4 = leftmost column).
const G = {
  A: [14, 17, 17, 31, 17, 17, 17], B: [30, 17, 17, 30, 17, 17, 30], C: [14, 17, 16, 16, 16, 17, 14],
  D: [30, 17, 17, 17, 17, 17, 30], E: [31, 16, 16, 30, 16, 16, 31], F: [31, 16, 16, 30, 16, 16, 16],
  G: [14, 17, 16, 23, 17, 17, 15], H: [17, 17, 17, 31, 17, 17, 17], I: [14, 4, 4, 4, 4, 4, 14],
  J: [7, 2, 2, 2, 2, 18, 12], K: [17, 18, 20, 24, 20, 18, 17], L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17], N: [17, 17, 25, 21, 19, 17, 17], O: [14, 17, 17, 17, 17, 17, 14],
  P: [30, 17, 17, 30, 16, 16, 16], Q: [14, 17, 17, 17, 21, 18, 13], R: [30, 17, 17, 30, 20, 18, 17],
  S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4], U: [17, 17, 17, 17, 17, 17, 14],
  V: [17, 17, 17, 17, 17, 10, 4], W: [17, 17, 17, 21, 21, 21, 10], X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 10, 4, 4, 4, 4], Z: [31, 1, 2, 4, 8, 16, 31],
  0: [14, 17, 19, 21, 25, 17, 14], 1: [4, 12, 4, 4, 4, 4, 14], 2: [14, 17, 1, 2, 4, 8, 31],
  3: [31, 2, 4, 2, 1, 17, 14], 4: [2, 6, 10, 18, 31, 2, 2], 5: [31, 16, 30, 1, 1, 17, 14],
  6: [6, 8, 16, 30, 17, 17, 14], 7: [31, 1, 2, 4, 8, 8, 8], 8: [14, 17, 17, 14, 17, 17, 14],
  9: [14, 17, 17, 15, 1, 2, 12],
  ' ': [0, 0, 0, 0, 0, 0, 0], '.': [0, 0, 0, 0, 0, 12, 12], ',': [0, 0, 0, 0, 12, 4, 8],
  ':': [0, 12, 12, 0, 12, 12, 0], '-': [0, 0, 0, 31, 0, 0, 0], '+': [0, 4, 4, 31, 4, 4, 0],
  '%': [24, 25, 2, 4, 8, 19, 3], '/': [0, 1, 2, 4, 8, 16, 0], '|': [4, 4, 4, 4, 4, 4, 4],
  '*': [0, 4, 21, 14, 21, 4, 0], '<': [2, 4, 8, 16, 8, 4, 2], '>': [8, 4, 2, 1, 2, 4, 8],
  '!': [4, 4, 4, 4, 4, 0, 4], '?': [14, 17, 1, 2, 4, 0, 4], "'": [4, 4, 8, 0, 0, 0, 0],
  '#': [10, 10, 31, 10, 31, 10, 10], '(': [2, 4, 8, 8, 8, 4, 2], ')': [8, 4, 2, 2, 2, 4, 8],
  '=': [0, 0, 31, 0, 31, 0, 0], '_': [0, 0, 0, 0, 0, 0, 31], '~': [0, 0, 8, 21, 2, 0, 0],
  '&': [12, 18, 20, 8, 21, 18, 13], '"': [10, 10, 0, 0, 0, 0, 0],
};

/** Display text in the LED font: upper case, unknown characters dropped. */
export function ledText(s) {
  return String(s).toUpperCase().replace(/±/g, '+-').replace(/[−–—]/g, '-').replace(/µ/g, 'U')
    .split('').filter((c) => G[c]).join('');
}

export const textWidth = (s) => ledText(s).length * 6 - 1;

// colour slots
export const C = { off: 0, main: 1, accent: 2, dim: 3, warn: 4 };

export class LedMatrix {
  constructor(canvas) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    this.b = new Float32Array(COLS * ROWS); // brightness 0..1
    this.c = new Uint8Array(COLS * ROWS); // colour slot
    this.palette = { 1: [125, 240, 195], 2: [255, 143, 171], 3: [125, 240, 195], 4: [255, 205, 112] };
    this.offColor = 'rgba(125, 240, 195, 0.07)';
  }

  clear() { this.b.fill(0); this.c.fill(0); }

  dot(x, y, bright = 1, color = C.main) {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= COLS || y >= ROWS) return;
    const i = y * COLS + x;
    if (bright >= this.b[i]) { this.b[i] = bright; this.c[i] = color; }
  }

  text(s, x, y, bright = 1, color = C.main) {
    let cx = x;
    for (const ch of ledText(s)) {
      const rows = G[ch];
      for (let r = 0; r < 7; r++) for (let k = 0; k < 5; k++) if (rows[r] & (16 >> k)) this.dot(cx + k, y + r, bright, color);
      cx += 6;
    }
    return cx;
  }

  /** Horizontal bar, t in 0..1 (bipolar draws from the middle). */
  bar(x, y, w, t, { h = 2, bipolar = false, color = C.accent } = {}) {
    t = Math.max(0, Math.min(1, t));
    for (let i = 0; i < w; i++) {
      const p = (i + 0.5) / w;
      const on = bipolar ? (t >= 0.5 ? p >= 0.5 && p <= t : p <= 0.5 && p >= t) : p <= t;
      for (let r = 0; r < h; r++) this.dot(x + i, y + r, on ? 1 : 0.12, on ? color : C.dim);
    }
  }

  /** A single-cycle frame (Float32 view) drawn as a lit line with a faint fill. */
  wave(frame, x0, y0, w, h, bright = 1) {
    if (!frame) return;
    const mid = y0 + h / 2;
    let prev = null;
    for (let x = 0; x < w; x++) {
      const s = frame[Math.floor((x / w) * frame.length)];
      const y = Math.round(mid - s * (h / 2 - 0.5));
      const lo = Math.min(y, Math.round(mid));
      const hi = Math.max(y, Math.round(mid));
      for (let yy = lo; yy <= hi; yy++) this.dot(x0 + x, yy, 0.18 * bright, C.dim);
      // join steep segments so the line stays continuous
      if (prev !== null) for (let yy = Math.min(prev, y); yy <= Math.max(prev, y); yy++) this.dot(x0 + x, yy, bright);
      this.dot(x0 + x, y, bright);
      prev = y;
    }
  }

  draw() {
    const { canvas, g } = this;
    const W = canvas.width;
    const H = canvas.height;
    const px = W / COLS;
    const py = H / ROWS;
    const r = Math.min(px, py) * 0.36;
    g.clearRect(0, 0, W, H);
    g.fillStyle = this.offColor;
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
      if (this.b[y * COLS + x] > 0.02) continue;
      g.beginPath(); g.arc((x + 0.5) * px, (y + 0.5) * py, r, 0, Math.PI * 2); g.fill();
    }
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
      const i = y * COLS + x;
      const v = this.b[i];
      if (v <= 0.02) continue;
      const [cr, cg, cb] = this.palette[this.c[i]] || this.palette[1];
      g.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${0.18 + 0.82 * v})`;
      g.beginPath(); g.arc((x + 0.5) * px, (y + 0.5) * py, r * (v > 0.5 ? 1.12 : 1), 0, Math.PI * 2); g.fill();
    }
  }
}
