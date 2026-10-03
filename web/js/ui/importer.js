// Import dialog: turns a dropped/picked file into a 33-frame table, previews
// it live in the chosen slot (so you can play while adjusting), and keeps it
// or puts the old table back.
import { parseWav, classify, toTable, fromRecording, normalizeTable, FRAME_SIZE, FRAMES } from '../wavetable.js';

const $ = (id) => document.getElementById(id);

/** Decode any file into { samples, sampleRate, clmFrameSize }.
 *  WAV goes through our parser (it keeps Serum frame info); anything else
 *  (mp3, m4a, ogg, ...) through the browser's decoder. */
async function decodeFile(file, ctx) {
  const buf = await file.arrayBuffer();
  try {
    return parseWav(buf);
  } catch (wavErr) {
    if (!ctx) throw wavErr;
    try {
      const audio = await ctx.decodeAudioData(buf.slice(0));
      const ch = audio.numberOfChannels;
      const samples = new Float32Array(audio.length);
      for (let c = 0; c < ch; c++) {
        const d = audio.getChannelData(c);
        for (let i = 0; i < d.length; i++) samples[i] += d[i] / ch;
      }
      return { samples, sampleRate: audio.sampleRate, channels: ch, clmFrameSize: 0 };
    } catch {
      throw new Error(`Couldn't read "${file.name}". WAV works everywhere; MP3/M4A/OGG depend on the browser.`);
    }
  }
}

export class Importer {
  /**
   * @param {object} o
   * @param {() => AudioContext} o.ctx
   * @param {(slot:number) => Float32Array} o.getTable   current table in a slot
   * @param {(slot:number, table:Float32Array) => void} o.preview  load without saving
   * @param {(slot:number, name:string, table:Float32Array) => void} o.commit
   * @param {(slot:number) => void} o.selectSlot  make the slot the playing table
   * @param {() => number} o.currentSlot
   * @param {(msg:string) => void} o.toast
   */
  constructor(o) {
    this.o = o;
    this.dlg = $('import-dlg');
    this.wav = null;
    this.kind = null;
    this.table = null;
    this.slot = 0;
    this.backup = null; // the slot's table before previewing
    this.prevSlot = 0;
    this.mode = 'auto';
    this.timer = 0;

    const segRoot = $('imp-slot');
    for (let i = 0; i < 7; i++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = i + 1;
      b.setAttribute('role', 'radio');
      b.addEventListener('click', () => this.setSlot(i));
      segRoot.append(b);
    }
    $('imp-mode').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-mode]');
      if (b) { this.mode = b.dataset.mode; this.render(); this.schedule(); }
    });
    for (const id of ['imp-start', 'imp-end']) $(id).addEventListener('input', () => { this.drawOverview(); this.schedule(); });
    $('imp-keep').addEventListener('click', () => this.keep());
    $('imp-cancel').addEventListener('click', () => this.cancel());
    this.dlg.addEventListener('cancel', (e) => { e.preventDefault(); this.cancel(); });
  }

  async open(file, slot) {
    let wav;
    try {
      wav = await decodeFile(file, this.o.ctx());
    } catch (err) {
      this.o.toast(err.message);
      return;
    }
    this.name = file.name.replace(/\.[^.]+$/, '');
    this.wav = wav;
    const c = classify(wav);
    this.kind = c.kind;
    this.mode = 'auto';
    $('imp-title').textContent = file.name;
    $('imp-kind').textContent = c.kind === 'wavetable'
      ? `Wavetable: ${c.frames} frame${c.frames === 1 ? '' : 's'} of ${c.frameSize} samples${c.frames === FRAMES && c.frameSize === FRAME_SIZE ? ' (exact fit)' : ', spread across 33 frames'}.`
      : `Recording: ${c.seconds.toFixed(2)} s. Pick the stretch to turn into a table; frames 1→33 scan through it.`;
    $('imp-rec').hidden = c.kind !== 'recording';
    $('imp-start').value = 0;
    $('imp-end').value = 1;
    this.prevSlot = this.o.currentSlot();
    this.slot = -1;
    this.dlg.showModal();
    this.setSlot(slot);
    this.drawOverview();
    this.render();
  }

  setSlot(i) {
    if (i === this.slot) return;
    if (this.backup) this.o.preview(this.slot, this.backup); // undo preview in the old slot
    this.slot = i;
    this.backup = this.o.getTable(i).slice();
    [...$('imp-slot').children].forEach((b, k) => b.setAttribute('aria-checked', String(k === i)));
    this.o.selectSlot(i);
    this.convert();
  }

  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.convert(), 120);
  }

  convert() {
    const status = $('imp-status');
    try {
      if (this.kind === 'wavetable') {
        this.table = normalizeTable(toTable(this.wav.samples, this.wav.clmFrameSize || FRAME_SIZE).table);
        status.textContent = '';
      } else {
        const r = fromRecording(this.wav.samples, this.wav.sampleRate, {
          mode: this.mode,
          start: parseFloat($('imp-start').value),
          end: parseFloat($('imp-end').value),
        });
        this.table = r.table;
        status.textContent = r.mode === 'pitched'
          ? `One cycle per frame, pitch found at ${r.hz.toFixed(1)} Hz.`
          : `Spectral: frames rebuilt from the sound's spectrum${this.mode === 'auto' ? ' (no steady pitch found)' : ''}.`;
        this.used = r.mode;
      }
      status.classList.remove('err');
      $('imp-keep').disabled = false;
      this.o.preview(this.slot, this.table);
    } catch (err) {
      status.textContent = err.message;
      status.classList.add('err');
      $('imp-keep').disabled = true;
      this.table = null;
      if (this.backup) this.o.preview(this.slot, this.backup);
    }
    this.render();
    this.drawPreview();
  }

  render() {
    [...$('imp-mode').children].forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === this.mode)));
  }

  keep() {
    if (!this.table) return;
    this.o.commit(this.slot, this.name, this.table);
    this.backup = null;
    this.close();
  }

  cancel() {
    if (this.backup) this.o.preview(this.slot, this.backup);
    this.backup = null;
    this.o.selectSlot(this.prevSlot);
    this.close();
  }

  close() {
    clearTimeout(this.timer);
    this.wav = null;
    this.dlg.close();
  }

  // the whole recording with the chosen stretch highlighted
  drawOverview() {
    const cv = $('imp-overview');
    if (!this.wav || this.kind !== 'recording') return;
    const g = cv.getContext('2d');
    const { width: w, height: h } = cv;
    const x = this.wav.samples;
    g.clearRect(0, 0, w, h);
    const a = Math.min(+$('imp-start').value, +$('imp-end').value);
    const b = Math.max(+$('imp-start').value, +$('imp-end').value);
    g.fillStyle = '#c6f25e';
    const per = x.length / w;
    for (let px = 0; px < w; px++) {
      let mx = 0;
      const s = Math.floor(px * per);
      const e = Math.min(x.length, Math.floor((px + 1) * per));
      for (let i = s; i < e; i++) mx = Math.max(mx, Math.abs(x[i]));
      const bh = Math.max(1, mx * (h - 4));
      g.fillRect(px, (h - bh) / 2, 1, bh);
    }
    // dim what is outside the chosen stretch
    g.fillStyle = 'rgba(23, 18, 31, 0.72)';
    g.fillRect(0, 0, a * w, h);
    g.fillRect(b * w, 0, w - b * w, h);
  }

  // all 33 frames, stacked in a shallow perspective
  drawPreview() {
    const cv = $('imp-preview');
    const g = cv.getContext('2d');
    const { width: w, height: h } = cv;
    g.clearRect(0, 0, w, h);
    if (!this.table) return;
    const dx = w * 0.22 / FRAMES;
    const dy = h * 0.42 / FRAMES;
    const fw = w - dx * FRAMES;
    const amp = h * 0.26;
    for (let f = FRAMES - 1; f >= 0; f--) {
      const ox = f * dx;
      const oy = h - amp - 4 - f * dy;
      g.strokeStyle = f === 0 ? '#c6f25e' : `rgba(243, 234, 216, ${0.15 + 0.5 * (1 - f / FRAMES)})`;
      g.lineWidth = f === 0 ? 2 : 1;
      g.beginPath();
      for (let px = 0; px < fw; px += 2) {
        const s = this.table[f * FRAME_SIZE + Math.floor((px / fw) * FRAME_SIZE)];
        const y = oy - s * amp;
        if (px === 0) g.moveTo(ox + px, y); else g.lineTo(ox + px, y);
      }
      g.stroke();
    }
  }
}
