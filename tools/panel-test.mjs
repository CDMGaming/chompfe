// Offline checks for the panel's firmware logic (web/js/panel/firmware-ui.js)
// against the WAVE quick start guide.   node tools/panel-test.mjs
import { FirmwareUI, KEYS } from '../web/js/panel/firmware-ui.js';
import { fakeApi, checker } from './fake-api.mjs';

globalThis.performance ??= { now: () => Date.now() };
const { check, done } = checker();
const { api, values, log } = fakeApi();
const { P } = api;

// preset storage for the fake
const slots = new Array(14).fill(null);
slots[1] = { name: 'two' };
let current = -1;
Object.assign(api.presets, {
  filled: (i) => !!slots[i],
  currentIndex: () => current,
  load: (i) => { current = i; log.presetLoads.push(i); },
  loadDefault: () => { current = -1; log.presetLoads.push('default'); },
  saveTo: (i) => { slots[i] = { name: 'saved' }; current = i; },
  erase: (i) => { slots[i] = null; },
  copy: (a, b) => { slots[b] = { ...slots[a] }; },
});

const fw = new FirmwareUI(api);
const white = (s) => KEYS.findIndex((k) => k.slot === s);
const black = (f) => KEYS.findIndex((k) => k.func === f);
const near = (a, b) => Math.abs(a - b) < 1e-9;

check(KEYS.length === 25 && KEYS[0].note === 48 && KEYS[24].note === 72, 'keybed is MIDI 48-72 (25 keys)');
check(KEYS.filter((k) => k.black).map((k) => k.func).join() === 'oct-,oct+,gate10,gate50,gate100,lfo-pitch,lfo-filter,erase,copy,save',
  'black keys carry octave / gate / LFO / erase-copy-save, left to right');
check(KEYS.filter((k) => !k.black).map((k) => k.slot).join() === '1,2,3,4,5,6,7,8,9,10,11,12,13,14,15', 'white keys are slots 1-15');

// knobs: page 1 / shift / page 2 / shift, per the manual's table
values[P.PITCH] = 0.5; fw.turn(0, 10);
check(near(values[P.PITCH], 0.53), 'pitch p1 turn: fine tune, 0.003 per detent');
fw.setKbdShift(true); fw.turn(0, 4); fw.setKbdShift(false);
check(near(((values[P.PITCH] - 0.5) * 24) % 1, 0), `pitch shift+turn: half-steps (${((values[P.PITCH] - 0.5) * 24).toFixed(2)} st)`);
fw.press(0); values[P.FRAME] = 5; fw.turn(0, 2);
check(fw.pages[0] === 1 && values[P.FRAME] === 7, 'press -> page 2: scan the wavetable');
values[P.TABLE] = 0; fw.setKbdShift(true); fw.turn(0, 3); fw.setKbdShift(false);
check(values[P.TABLE] === 1, 'page 2 shift+turn: change table, two detents per table');
fw.setKbdShift(true); fw.press(0); fw.setKbdShift(false);
check(values[P.FRAME] === 0 && fw.pages[0] === 1, 'shift+press resets that page (frame back to 1)');
fw.press(1); values[P.PITCH_LFO_RATE] = 0.2; fw.setKbdShift(true); fw.turn(1, 5); fw.setKbdShift(false);
check(near(values[P.PITCH_LFO_RATE], 0.25), 'attack page 2 shift+turn: vibrato rate');
values[P.FX_TIME] = 0.4; fw.setKbdShift(true); fw.turn(3, -10); fw.setKbdShift(false);
check(near(values[P.FX_TIME], 0.3), 'effects shift+turn: delay time / reverb size');
fw.press(4);
check(log.transport.some((t) => t[0] === 'tap'), 'tempo press = tap tempo');
values[P.CLOCK_DIV] = 2; fw.setKbdShift(true); fw.turn(4, 11); fw.turn(4, 1); fw.setKbdShift(false);
check(values[P.CLOCK_DIV] === 3, 'tempo shift+turn: clock divide, 12 detents per step');
fw.press(5); fw.setKbdShift(true); fw.turn(5, 7); fw.setKbdShift(false);
check(near(values[P.DRIVE], 0.07), 'volume page 2 shift+turn: compressor');

// LED colours: attack yellow -> orange
values[P.ATTACK] = 0; const c0 = fw.ledColor(1); values[P.ATTACK] = 1; const c1 = fw.ledColor(1);
fw.pages[1] = 0; values[P.ATTACK] = 0;
check(fw.ledColor(1).join() === '1,0.95,0.05' && c1 !== c0, 'attack LED: yellow at 0 (NormalPage colours)');

// star key: hold = shift, tap = latch; switch up = rest
check(!fw.shift, 'no shift by default');
fw.star(true); check(fw.shift, 'holding the star key = shift'); fw.turn(2, 1); fw.star(false);
check(!fw.shift && !fw.latched, 'releasing after using it does not latch');
fw.star(true); fw.star(false);
check(fw.latched && fw.shift, 'a quick tap latches shift');
fw.star(true); fw.star(false);
check(!fw.latched, 'tap again unlatches');
fw.setSwitch(false); fw.star(true); fw.star(false);
check(log.transport.slice(-2).map((t) => t.join(':')).join() === 'rest:true,rest:false', 'mode switch up: star key is the rest key');
fw.setSwitch(true);

// keys: notes without shift, functions with it
fw.keyDown(white(3), 90); fw.keyUp(white(3));
check(log.notes.some((n) => n[0] === 'on' && n[2] === 52 && n[3] === 90), 'without shift a key plays its note (E3)');
fw.setKbdShift(true);
const before = log.notes.length;
fw.keyDown(white(2));
check(log.notes.length === before && current === 1, 'shift + white key 2 loads sound 2, no note');
fw.keyDown(white(5));
check(current === 1, 'shift + an empty slot does nothing');
fw.keyDown(white(15));
check(log.presetLoads.at(-1) === 'default', 'shift + key 15 = default sound');
values[P.OCTAVE] = 0; fw.keyDown(black('oct+')); fw.keyDown(black('oct+'));
check(values[P.OCTAVE] === 1, 'shift + » : octave up (clamped at +1)');
fw.keyDown(black('gate10'));
check(near(values[P.GATE], 0.1), 'shift + 10% key: gate 10%');
const lfo = values[P.PITCH_LFO_ON]; fw.keyDown(black('lfo-pitch'));
check(values[P.PITCH_LFO_ON] === (lfo ? 0 : 1), 'shift + PITCH: vibrato on/off');

// erase / copy / save flows (pick, then the star key confirms)
fw.keyDown(black('save')); fw.keyDown(white(15));
check(fw.selected === 0, "save: slot 15 can't be picked");
fw.keyDown(white(6)); fw.setKbdShift(false);
check(fw.shift && fw.prompt()[0] === 'save to 6?', 'save: the shift menu stays open while picking');
fw.star(true); fw.star(false);
check(slots[5] && current === 5 && fw.mode === 'none' && !fw.shift, 'save: star key saves into 6 and closes shift');
fw.setKbdShift(true);
fw.keyDown(black('copy')); fw.keyDown(white(6)); fw.keyDown(white(7)); fw.star(true); fw.star(false);
check(slots[6] && current === 6, 'copy 6 -> 7 then load 7');
fw.setKbdShift(true);
fw.keyDown(black('erase')); fw.keyDown(white(7)); fw.star(true); fw.star(false);
check(!slots[6] && log.presetLoads.at(-1) === 'default', 'erase 7, then the default sound');
fw.setKbdShift(true);
fw.keyDown(black('save')); fw.keyDown(black('save'));
check(fw.mode === 'none', 'pressing SAVE again leaves save mode');
fw.setKbdShift(false);

done();
