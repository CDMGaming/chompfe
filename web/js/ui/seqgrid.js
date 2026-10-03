// 32-step grid over the firmware sequencer's data: step i is mySequence[i],
// a rest is an empty step, and the loop length is sequenceLength. Recording
// with LOOP fills the same steps, so both ways of working stay in sync.
//
// The "selected note" is the last note you played (keys, mouse, MIDI, pads).
//   click an empty step / a step with another note -> put the selected note there
//   click a step that already has the selected note -> make it a rest
//   click a step past the end     -> extend the loop to it, with the selected note
//   right-click, or Delete on a focused step -> rest
//   drag up/down or scroll        -> change that step's note
//   arrow keys on a focused step  -> up/down note, left/right move focus

import { SEQ_STEPS } from '../patch.js';

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const noteName = (n) => `${NAMES[n % 12]}${Math.floor(n / 12) - 1}`;

export class SeqGrid {
  /**
   * @param {HTMLElement} root
   * @param {object} o
   * @param {(i:number, note:number)=>void} o.setStep  note -1 = rest
   * @param {(n:number)=>void} o.setLength
   * @param {()=>number} o.lastNote  note to place when a step is switched on
   * @param {(note:number)=>void} [o.preview]  audition a note while editing
   */
  constructor(root, o) {
    this.root = root;
    this.o = o;
    this.steps = new Array(SEQ_STEPS).fill(-1);
    this.length = 0;
    this.index = 0;
    this.playing = false;
    this.gate = 0.5;
    this.holdUntil = 0; // ignore engine snapshots briefly after a local edit
    this.cells = [];
    for (let i = 0; i < SEQ_STEPS; i++) {
      const c = document.createElement('button');
      c.type = 'button';
      c.className = 'step';
      c.dataset.i = i;
      c.innerHTML = '<span class="step-note"></span><span class="step-gate"></span>';
      root.append(c);
      this.cells.push(c);
    }
    this.bind();
    this.render();
  }

  /** Engine snapshot from the worklet. */
  update(s, gate) {
    this.gate = gate;
    this.index = s.seqIndex;
    this.playing = s.seqPlaying;
    if (performance.now() >= this.holdUntil) {
      this.steps = s.steps.slice();
      this.length = s.seqLength;
    }
    this.render();
  }

  edit(i, note) {
    this.steps[i] = note;
    this.holdUntil = performance.now() + 150;
    this.o.setStep(i, note);
    this.render();
  }

  setLength(n) {
    n = Math.max(0, Math.min(SEQ_STEPS, n));
    this.length = n;
    this.holdUntil = performance.now() + 150;
    this.o.setLength(n);
    this.render();
  }

  click(i) {
    const sel = this.o.lastNote();
    if (i >= this.length) this.setLength(i + 1);
    if (this.steps[i] === sel) {
      this.edit(i, -1);
    } else {
      this.edit(i, sel);
      if (this.o.preview) this.o.preview(sel);
    }
  }

  transpose(i, d) {
    if (this.steps[i] < 0) return;
    const n = Math.max(0, Math.min(127, this.steps[i] + d));
    if (n === this.steps[i]) return;
    this.edit(i, n);
    if (this.o.preview) this.o.preview(n);
  }

  bind() {
    let drag = null;
    this.root.addEventListener('pointerdown', (e) => {
      const c = e.target.closest('.step');
      if (!c || e.button !== 0) return;
      const i = +c.dataset.i;
      drag = { i, y: e.clientY, base: this.steps[i], moved: false, id: e.pointerId };
      try { c.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    });
    this.root.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id || drag.base < 0) return;
      const dy = drag.y - e.clientY;
      if (!drag.moved && Math.abs(dy) < 6) return;
      drag.moved = true;
      const n = Math.max(0, Math.min(127, drag.base + Math.round(dy / 10)));
      if (n !== this.steps[drag.i]) {
        this.edit(drag.i, n);
        if (this.o.preview) this.o.preview(n);
      }
    });
    const up = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      if (!drag.moved) this.click(drag.i);
      drag = null;
    };
    this.root.addEventListener('pointerup', up);
    this.root.addEventListener('pointercancel', () => { drag = null; });
    // pointer handles mouse/touch; keyboard activation comes as a click with detail 0
    this.root.addEventListener('click', (e) => {
      const c = e.target.closest('.step');
      if (c && e.detail === 0) this.click(+c.dataset.i);
    });
    this.root.addEventListener('contextmenu', (e) => {
      const c = e.target.closest('.step');
      if (!c) return;
      e.preventDefault();
      if (+c.dataset.i < this.length) this.edit(+c.dataset.i, -1);
    });
    this.root.addEventListener('wheel', (e) => {
      const c = e.target.closest('.step');
      if (!c || this.steps[+c.dataset.i] < 0) return;
      e.preventDefault();
      this.transpose(+c.dataset.i, e.deltaY < 0 ? 1 : -1);
    }, { passive: false });
    this.root.addEventListener('keydown', (e) => {
      const c = e.target.closest('.step');
      if (!c) return;
      const i = +c.dataset.i;
      const go = (j) => this.cells[(j + SEQ_STEPS) % SEQ_STEPS].focus();
      if (e.key === 'ArrowUp') this.transpose(i, e.shiftKey ? 12 : 1);
      else if (e.key === 'ArrowDown') this.transpose(i, e.shiftKey ? -12 : -1);
      else if (e.key === 'ArrowLeft') go(i - 1);
      else if (e.key === 'ArrowRight') go(i + 1);
      else if (e.key === 'Delete' || e.key === 'Backspace') { if (i < this.length) this.edit(i, -1); }
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
  }

  render() {
    for (let i = 0; i < SEQ_STEPS; i++) {
      const c = this.cells[i];
      const n = this.steps[i];
      const inLoop = i < this.length;
      c.classList.toggle('on', inLoop && n >= 0);
      c.classList.toggle('rest', inLoop && n < 0);
      c.classList.toggle('out', !inLoop);
      c.classList.toggle('head', this.playing && inLoop && i === this.index);
      c.firstChild.textContent = n >= 0 ? noteName(n) : inLoop ? '·' : '';
      c.lastChild.style.width = `${Math.round(this.gate * 100)}%`;
      c.setAttribute('aria-label', `step ${i + 1}: ${!inLoop ? 'outside loop' : n >= 0 ? noteName(n) : 'rest'}`);
    }
  }
}
