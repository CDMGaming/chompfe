// Offline checks for the MiniLab mkII profile, the generic fallback and MIDI
// learn.   node tools/controllers-test.mjs
import * as minilab from '../web/js/midi/minilab2.js';
import * as generic from '../web/js/midi/generic.js';
import { MidiLearn } from '../web/js/midi/learn.js';
import { fakeApi, checker, wait } from './fake-api.mjs';

const { check, done } = checker();
const close = (a, b) => Math.abs(a - b) < 1e-6;

// ---------------------------------------------------------------- MiniLab
{
  const { api, values, log } = fakeApi();
  const { P, BY_ID } = api;
  const sent = [];
  const dev = minilab.create({ input: { id: 'm' }, output: { send: (b) => sent.push(Array.from(b)) }, api, sysex: true });
  const cc = (n, v, ch = 0) => dev.onMessage([0xb0 | ch, n, v]);

  check(minilab.match('Arturia MiniLab mkII') && minilab.match('Arturia MiniLab mkII MIDI 1'), 'matches MiniLab mkII port names');
  check(!minilab.match('Minilab3 MIDI') && !minilab.match('Arturia MINILAB'), 'does not claim MiniLab 3 or the original MiniLab');

  cc(77, 127); check(close(values[P.CUTOFF], 1), 'knob 5 (CC 77) = filter, absolute');
  cc(74, 0); check(close(values[P.PITCH], 0), 'knob 2 (CC 74) = pitch');
  cc(72, 127); check(values[P.TEMPO] === BY_ID[P.TEMPO].max, 'knob 16 (CC 72) = tempo, full range');

  values[P.FRAME] = 10;
  cc(112, 67); check(values[P.FRAME] === 13, 'knob 1 (CC 112, relative 64+3) scans frames +3');
  cc(112, 62); check(values[P.FRAME] === 11, 'knob 1 relative 64-2 -> -2');
  cc(113, 127); check(values[P.FRAME] === 0, 'knob 1 click (CC 113) -> first frame');

  values[P.TABLE] = 2;
  cc(114, 66); check(values[P.TABLE] === 3, 'knob 9 (CC 114) two detents -> next wavetable');

  dev.onMessage([0x99, 36 + 4, 100]); dev.onMessage([0x89, 36 + 4, 0]);
  check(values[P.TABLE] === 4, 'pad 5 (ch10 note 40) -> wavetable 5');
  check(!log.notes.some((n) => n[0] === 'on' && n[2] === 40), 'pads 1-8 do not play notes');
  dev.onMessage([0x99, 43, 100]);
  check(log.transport.map((t) => t.join(':')).join() === 'play:true,play:false', 'pad 8 -> play/stop');

  cc(24, 127); cc(24, 0); // momentary pad 11 -> slot 3
  check(log.presetLoads.join() === '2', 'pad 11 (CC 24) loads sound slot 3, release ignored');

  dev.onMessage([0x90, 60, 90]); dev.onMessage([0x80, 60, 0]);
  check(log.notes.some((n) => n[0] === 'on' && n[2] === 60 && n[3] === 90), 'keys play notes with velocity');
  dev.onMessage([0xe0, 0x7f, 0x7f]);
  check(log.bends.at(-1) > 1.99, 'pitch strip -> bend +2 st');
  cc(64, 127); check(log.sustain.at(-1) === true, 'sustain pedal');

  await wait(60);
  const colours = sent.filter((m) => m[0] === 0xf0);
  check(colours.length >= 16 && colours.every((m) => m.length === 12 && m.slice(1, 9).join() === '0,32,107,127,66,2,0,16'),
    'pad colours: F0 00 20 6B 7F 42 02 00 10 <70+pad> <colour> F7');
  const padC = (i) => colours.filter((m) => m[9] === 0x70 + i).at(-1)[10];
  check(padC(4) === 127 && padC(0) === 16, 'current wavetable pad white, others blue');
  check(padC(8 + 2) === 127 && padC(8 + 0) === 17 && padC(8 + 7) === 0, 'sound pads: current white, filled magenta, empty off');
  dev.destroy(true);
}

// ---------------------------------------------------------------- generic
{
  const { api, values, log } = fakeApi();
  const { P } = api;
  const dev = generic.create({ input: { id: 'g' }, api });
  dev.onMessage([0x93, 64, 80]);
  check(log.notes.at(-1)[2] === 64, 'generic: note on any channel');
  dev.onMessage([0xb0, 29, 0]); check(close(values[P.CUTOFF], 0), "generic: firmware CC 29 = filter (hardware's CC map)");
  dev.onMessage([0xb0, 15, 127]); dev.onMessage([0xb0, 15, 60]); dev.onMessage([0xb0, 15, 10]);
  check(log.transport.map((t) => t.join(':')).join() === 'loop:true,loop:false', 'generic: CC 15 is the loop key with the dead zone');
}

// ---------------------------------------------------------------- MIDI learn
{
  const { api, values, log } = fakeApi();
  const { P } = api;
  const learn = new MidiLearn(api);
  learn.clear();
  const port = 'Some Controller';

  // absolute knob: values move, so it is learned as absolute
  learn.arm({ kind: 'param', id: P.RESONANCE });
  learn.handle(port, [0xb0, 40, 10]); learn.handle(port, [0xb0, 40, 12]); learn.handle(port, [0xb0, 40, 15]);
  check(learn.maps.length === 1 && learn.maps[0].mode === 'abs', 'learn: moving values -> absolute knob');
  check(learn.handle(port, [0xb0, 40, 127]) && close(values[P.RESONANCE], 1), 'learned knob drives resonance');
  check(!learn.handle('Other Device', [0xb0, 40, 0]), 'mapping is per device');

  // relative encoder (1 = +1 repeated) on a stepped param
  learn.arm({ kind: 'param', id: P.FRAME });
  for (let i = 0; i < 3; i++) learn.handle(port, [0xb0, 41, 1]);
  check(learn.maps.at(-1).mode === 'rel2c', 'learn: repeated 1s -> two\'s-complement encoder');
  values[P.FRAME] = 5;
  for (let i = 0; i < 6; i++) learn.handle(port, [0xb0, 41, 127]);
  check(values[P.FRAME] === 3, 'relative encoder: 6 detents down = 2 frames (3 per step)');

  // a note (pad) on a transport action
  learn.arm({ kind: 'action', name: 'play' });
  learn.handle(port, [0x99, 36, 100]);
  check(learn.maps.at(-1).mode === 'button', 'learn: a note -> button');
  learn.handle(port, [0x99, 36, 100]); learn.handle(port, [0x89, 36, 0]);
  check(log.transport.map((t) => t.join(':')).join() === 'play:true,play:false', 'learned pad presses and releases play');

  // re-learning a control replaces the old mapping
  learn.arm({ kind: 'param', id: P.CUTOFF });
  learn.handle(port, [0xb0, 40, 20]); learn.handle(port, [0xb0, 40, 30]); learn.handle(port, [0xb0, 40, 40]);
  check(learn.maps.filter((m) => m.num === 40).length === 1 && learn.maps.find((m) => m.num === 40).target.id === P.CUTOFF,
    're-learning a control replaces its old mapping');

  // a toggle param on a CC button
  learn.arm({ kind: 'param', id: P.FILTER_LFO_ON });
  learn.handle(port, [0xb0, 50, 127]); await wait(400);
  const before = values[P.FILTER_LFO_ON];
  learn.handle(port, [0xb0, 50, 0]); learn.handle(port, [0xb0, 50, 127]);
  check(values[P.FILTER_LFO_ON] === (before ? 0 : 1), 'learned CC button toggles an on/off param');
}

done();
