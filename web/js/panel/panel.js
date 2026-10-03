// The instrument panel: six push-button encoders, the mode switch and
// shift/rest key, play and loop, a 25-key keybed with its shift functions,
// and an LED dot-matrix display. Logic lives in firmware-ui.js.
import { FirmwareUI, KEYS, BLACK_LABELS } from './firmware-ui.js';
import { LedMatrix, COLS, ROWS, C, textWidth } from './ledmatrix.js';
import { FRAME_SIZE } from '../wavetable.js';

const PX_PER_DETENT = 5;
const rgb = (c, k = 1) => `rgb(${Math.round(c[0] * 255 * k)}, ${Math.round(c[1] * 255 * k)}, ${Math.round(c[2] * 255 * k)})`;
const lum = (c) => Math.max(c[0], c[1], c[2]);

const KNOB_HINTS = [
  'PITCH. Turn: fine tune. Shift+turn: half-steps. Press for page 2: turn scans the wavetable, shift+turn changes table. Shift+press resets.',
  'ATTACK. Turn: envelope attack (shift: coarse). Press for page 2: vibrato depth (shift: vibrato rate). Shift+press resets.',
  'DECAY. Turn: release (shift: coarse). Press for page 2: filter LFO depth (shift: rate). Shift+press resets.',
  'EFFECTS. Turn: left = delay, right = reverb (shift: delay time / reverb size). Press for page 2: filter (shift: resonance).',
  'TEMPO. Turn: tempo. Shift+turn: clock divide. Press it in rhythm to tap a tempo. Shift+press resets.',
  'VOLUME. Turn: volume (shift: compressor). Press for page 2: pan (shift: compressor).',
];
const BLACK_HINTS = {
  'oct-': 'Shift + this key: keyboard one octave down.', 'oct+': 'Shift + this key: keyboard one octave up.',
  gate10: 'Shift + this key: loop notes are short plucks (10% of a step).', gate50: 'Shift + this key: loop notes last half a step.',
  gate100: 'Shift + this key: legato, each loop note runs into the next.',
  'lfo-pitch': 'Shift + this key: vibrato (pitch LFO) on/off. Depth and rate: Attack knob, page 2.',
  'lfo-filter': 'Shift + this key: filter LFO on/off. Depth and rate: Decay knob, page 2.',
  erase: 'Shift + ERASE, pick a slot, then press the star key to erase it.',
  copy: 'Shift + COPY, pick the slot to copy, pick where it goes, then press the star key.',
  save: 'Shift + SAVE, pick a slot 1-14, then press the star key to save the sound there.',
};

export class Panel {
  /**
   * @param {HTMLElement} root
   * @param {object} api   the app's controller API
   * @param {object} o
   * @param {(slot:number) => Float32Array} o.table
   * @param {(slot:number) => string} o.tableName
   * @param {(text:string) => void} o.hint
   */
  constructor(root, api, o) {
    this.root = root;
    this.api = api;
    this.o = o;
    this.fw = new FirmwareUI(api);
    this.readout = null; // { title, value, norm, bipolar, until }
    this.bootUntil = 0;
    this.build();
    this.fw.addEventListener('touched', (e) => this.showKnob(e.detail));
    api.on('param', (id) => this.onParam(id));
    api.on('presets', () => this.onPresets());
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  // ------------------------------------------------------------ DOM
  build() {
    const r = this.root;
    r.innerHTML = `
      <div class="inst-face">
        <div class="inst-head">
          <div class="inst-brand">chompfe<span>wavetable</span></div>
          <div class="screen"><canvas class="led" width="${COLS * 6}" height="${ROWS * 6}" aria-label="LED display"></canvas></div>
          <div class="inst-badge" aria-hidden="true">8 voices</div>
        </div>
        <div class="inst-controls">
          <div class="mode-area">
            <span class="tag">mode</span>
            <button class="mode-switch" type="button" role="switch" aria-checked="true" aria-label="Mode switch: down = star key is shift, up = star key is rest"><i></i></button>
            <span class="mode-caption"></span>
            <button class="star-key" type="button" aria-label="Star key"><span class="key-led"></span>${MASCOT}</button>
            <span class="star-caption"></span>
          </div>
          <div class="knob-row"></div>
          <div class="transport-area">
            <button class="tkey play" type="button" aria-label="Play"><span class="key-led"></span><b>▶︎❙❙</b></button>
            <button class="tkey loop" type="button" aria-label="Loop: record"><span class="key-led"></span><b>⟲</b></button>
            <span class="tag tag-play">play</span><span class="tag tag-loop">loop · rec</span>
          </div>
        </div>
        <div class="keybed">
          <div class="black-row"></div>
          <div class="white-row"></div>
        </div>
      </div>`;
    this.canvas = r.querySelector('canvas.led');
    this.led = new LedMatrix(this.canvas);

    // knobs: Pitch Attack Decay | Effects | Tempo (big) | Volume
    const row = r.querySelector('.knob-row');
    this.knobEls = this.fw.KNOBS.map((kn, k) => {
      const el = document.createElement('div');
      el.className = `enc enc-${k}${k === 4 ? ' big' : ''}`;
      el.tabIndex = 0;
      el.setAttribute('role', 'slider');
      el.setAttribute('aria-label', kn.name);
      el.dataset.hint = KNOB_HINTS[k];
      el.innerHTML = `
        <span class="tag">${kn.name}</span>
        <span class="enc-led"></span>
        <div class="enc-body">
          <svg viewBox="0 0 100 100" aria-hidden="true"><circle class="enc-track" cx="50" cy="50" r="44"/><path class="enc-arc"/></svg>
          <div class="enc-cap"><i></i></div>
        </div>
        <span class="enc-func"></span>
        <span class="enc-pages">${kn.pages.map(() => '<i></i>').join('')}</span>`;
      this.bindKnob(el, k);
      row.append(el);
      return el;
    });
    // play / loop sit between the tempo knob and volume, as on the hardware
    row.insertBefore(r.querySelector('.transport-area'), this.knobEls[5]);

    // keybed: 10 black keys in a row above 15 white keys, at piano positions
    const blackRow = r.querySelector('.black-row');
    const whiteRow = r.querySelector('.white-row');
    const groups = [['octave', 0, 2], ['gate length', 2, 5], ['lfo', 5, 7], ['sounds', 7, 10]];
    let whiteIdx = 0;
    let blackIdx = 0;
    this.keyEls = KEYS.map((key, i) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `kkey ${key.black ? 'black' : 'white'}`;
      el.innerHTML = '<span class="key-led"></span>';
      if (key.black) {
        el.style.left = `${(whiteIdx / 15) * 100}%`;
        el.innerHTML += `<span class="klabel">${BLACK_LABELS[blackIdx]}</span>`;
        el.dataset.hint = BLACK_HINTS[key.func] + ' Without shift it plays a note.';
        el.setAttribute('aria-label', `Key ${key.note}, shift: ${BLACK_LABELS[blackIdx]}`);
        blackIdx++;
        blackRow.append(el);
      } else {
        el.innerHTML += `<span class="klabel">${key.slot === 15 ? 'def' : key.slot}</span>`;
        el.dataset.hint = key.slot === 15
          ? 'Plays a note. Shift + this key: the default sound (slot 15).'
          : `Plays a note. Shift + this key: sound slot ${key.slot}.`;
        el.setAttribute('aria-label', `Key ${key.note}, shift: sound slot ${key.slot}`);
        whiteIdx++;
        whiteRow.append(el);
      }
      this.bindKey(el, i);
      return el;
    });
    for (const [label, a, bEnd] of groups) {
      const left = parseFloat(this.keyEls.filter((_, i) => KEYS[i].black)[a].style.left);
      const right = parseFloat(this.keyEls.filter((_, i) => KEYS[i].black)[bEnd - 1].style.left);
      const cap = document.createElement('span');
      cap.className = 'group-cap';
      cap.textContent = `shift · ${label}`;
      cap.style.left = `calc(${left}% - 2.6%)`;
      cap.style.width = `calc(${right - left}% + 5.2%)`;
      blackRow.append(cap);
    }

    // mode switch, star key, play, loop
    const sw = r.querySelector('.mode-switch');
    sw.dataset.hint = 'MODE switch. Down: the star key is SHIFT (hold it, or tap to latch). Up: the star key adds a rest while recording, or mutes the loop while held.';
    sw.addEventListener('click', () => this.fw.setSwitch(!this.fw.switchDown));
    const star = r.querySelector('.star-key');
    star.dataset.hint = 'STAR key. Mode down: hold for SHIFT (or tap to latch it); also confirms erase/copy/save. Mode up: REST while recording, MUTE while held.';
    this.hold(star, (d) => this.fw.star(d));
    const play = r.querySelector('.tkey.play');
    play.dataset.hint = 'PLAY: start / stop the loop. Hold PLAY + LOOP to clear the loop. (Space)';
    this.hold(play, (d) => this.api.play(d));
    const loop = r.querySelector('.tkey.loop');
    loop.dataset.hint = 'LOOP: tap to arm recording, tap again to stop. Hold to delete the last step. Stopped: each key you release is added as a step. Playing: notes replace the step under the playhead. (Enter)';
    this.hold(loop, (d) => this.api.loop(d));
    this.els = { sw, star, play, loop, modeCap: r.querySelector('.mode-caption'), starCap: r.querySelector('.star-caption') };

    // hint line
    r.addEventListener('pointerover', (e) => {
      const h = e.target.closest('[data-hint]');
      if (h) this.o.hint(h.dataset.hint);
    });
    r.addEventListener('focusin', (e) => {
      const h = e.target.closest('[data-hint]');
      if (h) this.o.hint(h.dataset.hint);
    });
  }

  hold(el, fn) {
    let down = false;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      down = true;
      try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      fn(true);
    });
    const up = () => { if (down) { down = false; fn(false); } };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('keydown', (e) => { if ((e.key === 'Enter') && !e.repeat) { e.preventDefault(); e.stopPropagation(); fn(true); } });
    el.addEventListener('keyup', (e) => { if (e.key === 'Enter') { e.stopPropagation(); fn(false); } });
  }

  bindKnob(el, k) {
    let drag = null;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      drag = { y: e.clientY, acc: 0, moved: false };
      try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      el.classList.add('active');
      el.focus({ preventScroll: true });
      e.preventDefault();
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      this.fw.setKbdShift(e.shiftKey);
      drag.acc += drag.y - e.clientY;
      drag.y = e.clientY;
      const d = Math.trunc(drag.acc / PX_PER_DETENT);
      if (d) {
        drag.moved = true;
        drag.acc -= d * PX_PER_DETENT;
        this.fw.turn(k, d);
      }
    });
    const end = () => {
      if (!drag) return;
      if (!drag.moved) this.fw.press(k);
      drag = null;
      el.classList.remove('active');
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', () => { drag = null; el.classList.remove('active'); });
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.fw.setKbdShift(e.shiftKey);
      this.fw.turn(k, e.deltaY < 0 ? 1 : -1);
    }, { passive: false });
    el.addEventListener('keydown', (e) => {
      const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 10, PageDown: -10 }[e.key];
      if (d) { this.fw.turn(k, d); e.preventDefault(); e.stopPropagation(); }
      else if (e.key === 'Enter') { this.fw.press(k); e.preventDefault(); e.stopPropagation(); }
    });
  }

  bindKey(el, i) {
    let down = false;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      down = true;
      try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      const r = el.getBoundingClientRect();
      const vel = Math.round(50 + 77 * Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)));
      el.classList.add('pressed');
      this.fw.keyDown(i, vel);
    });
    const up = () => { if (down) { down = false; el.classList.remove('pressed'); this.fw.keyUp(i); } };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  // ------------------------------------------------------------ display content
  showKnob({ k, id, label }) {
    const p = this.api.BY_ID[id];
    this.readout = {
      title: `${this.fw.KNOBS[k].name} ${this.fw.KNOBS[k].pages.length > 1 ? `p${this.fw.pages[k] + 1}` : ''}`,
      sub: label,
      value: p.fmt(this.api.get(id)),
      norm: (this.api.get(id) - p.min) / (p.max - p.min),
      bipolar: [this.api.P.PITCH, this.api.P.FX, this.api.P.CUTOFF, this.api.P.PAN].includes(id),
      until: performance.now() + 1800,
      knob: true,
    };
  }

  onParam(id) {
    if (typeof id !== 'number') return;
    // changes from MIDI / other views also show up, unless a knob just did it
    if (this.readout && this.readout.knob && performance.now() < this.readout.until) {
      const k = this.fw.KNOBS.findIndex((_, i) => this.fw.fn(i).id === id);
      if (k >= 0) { this.showKnob({ k, id, label: this.fw.fn(k).label }); return; }
    }
    const p = this.api.BY_ID[id];
    this.readout = {
      title: p.short, sub: '', value: p.fmt(this.api.get(id)),
      norm: (this.api.get(id) - p.min) / (p.max - p.min),
      bipolar: [this.api.P.PITCH, this.api.P.FX, this.api.P.CUTOFF, this.api.P.PAN].includes(id),
      until: performance.now() + 1500,
    };
  }

  onPresets() {
    const name = this.api.presets.currentName();
    if (name) this.readout = { title: 'sound', sub: '', value: name, norm: -1, until: performance.now() + 1600 };
  }

  boot() { this.bootUntil = performance.now() + 1600; }

  renderDisplay(now) {
    const L = this.led;
    const { api, fw } = this;
    const st = api.state();
    L.clear();

    if (now < this.bootUntil) {
      // boot: waves roll in, then the name
      const t = 1 - (this.bootUntil - now) / 1600;
      for (let x = 0; x < COLS; x++) {
        for (let k = 0; k < 3; k++) {
          const y = 11 + Math.sin(x * 0.09 + t * 9 + k * 1.9) * (3 + k * 2) * Math.min(1, t * 2);
          L.dot(x, y + k * 2 - 2, 1 - k * 0.3, k === 1 ? C.accent : C.main);
        }
      }
      if (t > 0.45) {
        const s = 'chompfe';
        const x = Math.round((COLS - textWidth(s)) / 2);
        for (let y = 7; y < 18; y++) for (let xx = x - 3; xx < x + textWidth(s) + 3; xx++) L.b[y * COLS + xx] = 0;
        L.text(s, x, 9, Math.min(1, (t - 0.45) * 4));
      }
      L.draw();
      return;
    }

    const prompt = fw.prompt();
    const flash = fw.flashMsg && now < fw.flashMsg.until ? fw.flashMsg.text : null;
    if (prompt) {
      L.text(prompt[0], 1, 1, 1, C.warn);
      L.text(prompt[1], 1, 11, (now % 1000) < 650 ? 1 : 0.35);
    } else if (flash) {
      L.text(flash, Math.max(1, Math.round((COLS - textWidth(flash)) / 2)), 8, 1, C.warn);
    } else if (this.readout && now < this.readout.until) {
      const r = this.readout;
      L.text(r.title, 1, 1, 1);
      if (r.sub) L.text(r.sub, Math.max(1, COLS - textWidth(r.sub) - 1), 1, 0.45, C.dim);
      L.text(r.value, 1, 11, 1, C.accent);
      if (r.norm >= 0) L.bar(1, 20, COLS - 2, r.norm, { h: 2, bipolar: r.bipolar });
    } else if (fw.shift && fw.mode === 'none') {
      const tips = ['white keys: sounds', '« »: octave', 'gate 10 50 100%', 'pitch / filter lfo', 'erase copy save', 'knobs: 2nd function'];
      L.text('shift', 1, 1, 1, C.warn);
      L.text(tips[Math.floor(now / 1400) % tips.length], 1, 11, 1);
      L.text(fw.latched ? 'latched' : 'held', COLS - textWidth(fw.latched ? 'latched' : 'held') - 1, 1, 0.45, C.dim);
    } else {
      // idle: the current frame, glowing with the output level
      const t = Math.round(api.get(api.P.TABLE));
      const f = Math.round(api.get(api.P.FRAME));
      const table = this.o.table(t);
      const frame = table ? table.subarray(f * FRAME_SIZE, (f + 1) * FRAME_SIZE) : null;
      L.wave(frame, 0, 0, COLS, 19, 0.55 + 0.45 * Math.min(1, st.vu * 1.5));
      const name = `${t + 1} ${this.o.tableName(t)}`;
      L.text(name, 1, 1, 0.28, C.dim);
    }

    // bottom row: the loop's steps, or where you are in the wavetable
    if (!prompt && !(this.readout && now < this.readout.until && this.readout.norm >= 0)) {
      const len = api.seq.length;
      if (len) {
        const x0 = Math.round((COLS - len * 3) / 2);
        for (let i = 0; i < len; i++) {
          const head = st.seqPlaying && i === st.seqIndex;
          const on = api.seq.steps[i] >= 0;
          const bright = head ? 1 : on ? 0.6 : 0.15;
          L.dot(x0 + i * 3, 22, bright, head ? C.accent : C.main);
          L.dot(x0 + i * 3 + 1, 22, bright, head ? C.accent : C.main);
          if (head && st.seqGateOpen) { L.dot(x0 + i * 3, 21, 1, C.accent); L.dot(x0 + i * 3 + 1, 21, 1, C.accent); }
        }
        if (st.seqRecording) for (let x = 0; x < 3; x++) L.dot(COLS - 4 + x, 22, (now % 600) < 350 ? 1 : 0.2, C.accent);
      } else {
        const f = api.get(api.P.FRAME);
        for (let i = 0; i < 33; i++) L.dot(Math.round(4 + i * ((COLS - 8) / 32)), 22, i === Math.round(f) ? 1 : 0.12, i === Math.round(f) ? C.accent : C.main);
      }
    }
    L.draw();
  }

  // ------------------------------------------------------------ LEDs, labels
  renderPanel(now) {
    const { api, fw } = this;
    const st = api.state();
    const blink = (now % 500) < 280;
    const shift = fw.shift;
    this.root.classList.toggle('shifted', shift);
    this.root.classList.toggle('mode-up', !fw.switchDown);

    this.knobEls.forEach((el, k) => {
      const c = fw.ledColor(k, st.vu);
      const led = el.querySelector('.enc-led');
      led.style.background = lum(c) > 0.04 ? rgb(c) : '';
      led.style.boxShadow = lum(c) > 0.04 ? `0 0 ${4 + 10 * lum(c)}px ${rgb(c)}` : '';
      const t = Math.max(0, Math.min(1, fw.norm(k)));
      const a = -135 + t * 270;
      el.querySelector('.enc-cap').style.transform = `rotate(${a}deg)`;
      el.querySelector('.enc-arc').setAttribute('d', arc(50, 50, 44, -135, a));
      const fn = fw.fn(k);
      const cap = el.querySelector('.enc-func');
      if (cap.textContent !== fn.label) cap.textContent = fn.label;
      el.setAttribute('aria-valuetext', `${fn.label}: ${fw.valueText(k)}`);
      [...el.querySelectorAll('.enc-pages i')].forEach((p, i) => p.classList.toggle('on', i === fw.pages[k]));
    });

    const playing = new Set(st.voices);
    this.keyEls.forEach((el, i) => {
      const c = fw.keyLed(i, { playing, blink });
      const led = el.firstChild;
      led.style.background = c ? rgb(c) : '';
      led.style.boxShadow = c && lum(c) > 0.3 ? `0 0 8px ${rgb(c)}` : '';
    });

    const { sw, star, play, loop, modeCap, starCap } = this.els;
    sw.setAttribute('aria-checked', String(fw.switchDown));
    modeCap.textContent = fw.switchDown ? '▼ star = shift' : '▲ star = rest';
    starCap.textContent = fw.switchDown ? (fw.latched ? 'shift (latched)' : 'shift') : (st.seqRecording ? 'rest' : 'mute');
    const starLed = star.firstChild;
    starLed.style.background = shift ? '#b98bff' : fw.starHeld ? '#fff' : '';
    star.classList.toggle('on', shift);
    play.firstChild.style.background = st.seqPlaying ? '#7df0c3' : api.seq.length ? 'rgba(125, 240, 195, 0.25)' : '';
    loop.firstChild.style.background = st.seqRecording ? (blink || !st.seqPlaying ? '#ff6b6b' : '#7a2d2d') : '';
  }

  loop(now) {
    this.renderPanel(now);
    this.renderDisplay(now);
    requestAnimationFrame(this.loop);
  }
}

function arc(cx, cy, r, a0, a1) {
  if (a1 - a0 < 0.5) return '';
  const p = (a) => [cx + r * Math.sin((a * Math.PI) / 180), cy - r * Math.cos((a * Math.PI) / 180)];
  const [x0, y0] = p(a0);
  const [x1, y1] = p(a1);
  return `M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
}

// Our mascot for the star key: a little wave blob (original artwork).
const MASCOT = `<svg class="mascot" viewBox="0 0 64 64" aria-hidden="true">
  <path d="M10 38c0-15 9-27 22-27s22 12 22 27c0 9-6 15-22 15S10 47 10 38z" fill="#c9b6ff" stroke="#2f2440" stroke-width="3"/>
  <circle cx="24" cy="33" r="3.6" fill="#2f2440"/><circle cx="40" cy="33" r="3.6" fill="#2f2440"/>
  <circle cx="25.2" cy="31.8" r="1.1" fill="#fff"/><circle cx="41.2" cy="31.8" r="1.1" fill="#fff"/>
  <path d="M24 42c2.5-3 5.5 3 8 0s5.5 3 8 0" fill="none" stroke="#2f2440" stroke-width="2.6" stroke-linecap="round"/>
  <path d="M32 11c0-4 3-7 7-6" fill="none" stroke="#2f2440" stroke-width="3" stroke-linecap="round"/>
  <circle cx="17" cy="40" r="3" fill="#ff9fb5" opacity=".7"/><circle cx="47" cy="40" r="3" fill="#ff9fb5" opacity=".7"/>
</svg>`;
