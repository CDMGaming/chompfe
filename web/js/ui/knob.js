// Rotary knob: SVG arc, vertical drag (Shift = fine), wheel, arrow keys,
// double-click / Backspace to reset. Exposed to assistive tech as a slider.

const SWEEP = 270; // degrees
const START = -135;

function arcPath(cx, cy, r, a0, a1) {
  const rad = (a) => ((a - 90) * Math.PI) / 180;
  const x0 = cx + r * Math.cos(rad(a0));
  const y0 = cy + r * Math.sin(rad(a0));
  const x1 = cx + r * Math.cos(rad(a1));
  const y1 = cy + r * Math.sin(rad(a1));
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  const sweep = a1 > a0 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} ${sweep} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

export class Knob {
  /**
   * @param {object} o
   * @param {string} o.label
   * @param {number} o.min
   * @param {number} o.max
   * @param {number} o.step  0 = continuous
   * @param {number} o.value
   * @param {number} o.def    reset value
   * @param {boolean} o.bipolar  draw the arc from the centre
   * @param {(v:number)=>string} o.fmt
   * @param {(v:number)=>void} o.onChange
   * @param {string} [o.hue] CSS colour for the value arc
   */
  constructor(o) {
    Object.assign(this, { step: 0, bipolar: false, hue: 'var(--lime)' }, o);
    const el = document.createElement('div');
    el.className = 'knob';
    el.tabIndex = 0;
    el.setAttribute('role', 'slider');
    el.setAttribute('aria-label', this.label);
    el.setAttribute('aria-valuemin', this.min);
    el.setAttribute('aria-valuemax', this.max);
    el.innerHTML = `
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <path class="knob-track" d="${arcPath(32, 32, 26, START, START + SWEEP)}"/>
        <path class="knob-arc" stroke="${this.hue}"/>
        <circle class="knob-cap" cx="32" cy="32" r="18"/>
        <line class="knob-tick" x1="32" y1="32" x2="32" y2="17"/>
      </svg>
      <div class="knob-label">${this.label}</div>
      <div class="knob-val"></div>`;
    this.el = el;
    this.arc = el.querySelector('.knob-arc');
    this.tick = el.querySelector('.knob-tick');
    this.valEl = el.querySelector('.knob-val');
    this.bind();
    this.set(this.value, false);
  }

  norm(v) { return (v - this.min) / (this.max - this.min); }
  denorm(t) { return this.min + t * (this.max - this.min); }

  quantize(v) {
    v = Math.min(this.max, Math.max(this.min, v));
    if (this.step) v = Math.round((v - this.min) / this.step) * this.step + this.min;
    return v;
  }

  /** Set the value; notify = call onChange. */
  set(v, notify = true) {
    v = this.quantize(v);
    const changed = v !== this.value;
    this.value = v;
    const t = this.norm(v);
    const a = START + t * SWEEP;
    const from = this.bipolar ? 0 : START;
    this.arc.setAttribute('d', Math.abs(a - from) < 0.5 ? '' : arcPath(32, 32, 26, Math.min(from, a), Math.max(from, a)));
    this.tick.setAttribute('transform', `rotate(${a} 32 32)`);
    const txt = this.fmt(v);
    this.valEl.textContent = txt;
    this.el.setAttribute('aria-valuenow', String(v));
    this.el.setAttribute('aria-valuetext', txt);
    if (notify && changed) this.onChange(v);
  }

  bind() {
    const el = this.el;
    let startY = 0;
    let startT = 0;
    let dragging = false;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      dragging = true;
      startY = e.clientY;
      startT = this.norm(this.value);
      this.accum = 0;
      try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      el.classList.add('active');
      el.focus({ preventScroll: true });
      e.preventDefault();
    });
    el.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const range = e.shiftKey ? 800 : 180; // px for full travel
      const t = Math.min(1, Math.max(0, startT + (startY - e.clientY) / range));
      this.set(this.denorm(t));
    });
    const end = () => { dragging = false; el.classList.remove('active'); };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('dblclick', () => this.set(this.def));
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.nudge(e.deltaY < 0 ? 1 : -1, e.shiftKey);
    }, { passive: false });
    el.addEventListener('keydown', (e) => {
      const k = e.key;
      if (k === 'ArrowUp' || k === 'ArrowRight') this.nudge(1, e.shiftKey);
      else if (k === 'ArrowDown' || k === 'ArrowLeft') this.nudge(-1, e.shiftKey);
      else if (k === 'PageUp') this.nudge(10, false);
      else if (k === 'PageDown') this.nudge(-10, false);
      else if (k === 'Home') this.set(this.min);
      else if (k === 'End') this.set(this.max);
      else if (k === 'Backspace' || k === 'Delete') this.set(this.def);
      else return;
      e.preventDefault();
      e.stopPropagation(); // don't also play notes
    });
  }

  /** One detent: a whole step for stepped knobs, else 1% (0.2% fine). */
  nudge(n, fine) {
    const d = this.step ? this.step : (this.max - this.min) * (fine ? 0.002 : 0.01);
    this.set(this.value + n * d);
  }
}
