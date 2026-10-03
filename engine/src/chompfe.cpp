// Chompfe: thin C API around the vendored wavetable engine, for WebAssembly.
//
// This file replaces chompi_main.cpp (audio callback / boot) and the parts of
// NormalPage.h / MenuPage.h that turned knob values into engine calls. The DSP
// in vendor/firmware is compiled unmodified.
//
// Threading model: everything runs on the AudioWorklet thread. JS calls the
// setters between cf_process() calls, which is the same position the firmware's
// UI code had relative to its audio callback.

#include "hardware.h"
#include "daisysp.h"
#include "subtractiveEngine.h"
#include "Sequencer.h"
#include "clockManager.h"
#include "WavetableManager.h"
#include <cstring>

#define CF_EXPORT extern "C" __attribute__((used, visibility("default")))

uint64_t daisy::System::sample_count = 0;
float daisy::System::sample_rate = 48000.f;

namespace
{
constexpr int kNumSlots = wavetableLoader::kMaxPreload; // 7, as on the card
constexpr int kRowsPerTable = CYCLES;                   // 33
constexpr int kMaxBlock = 128;                          // AudioWorklet render quantum
// The firmware ran ~24-sample blocks; ProcessKeyReqs() pops ONE note request per
// block, so a big render quantum would smear chords. Sub-blocking keeps the
// note/sequencer timing close to the hardware.
constexpr int kSubBlock = 32;

Hardware hw;
myEngine engine;
wavetableLoader wtLoader;
Sequencer seq;
clockManager cManager;
daisysp::Reverb reverb;
chompi::InterpolatedDelayLine::AudioSample del_mem[kMaxDelayTime];
float wavetableMemory[kNumSlots * kRowsPerTable][MAX_SAMPLES_PER_CYCLE];

float out_buf[4][kMaxBlock];
float in_buf[2][kMaxBlock];
float *out_ptrs[4] = {out_buf[0], out_buf[1], out_buf[2], out_buf[3]};
const float *in_ptrs[2] = {in_buf[0], in_buf[1]};

// Parameter IDs. Continuous ones are the firmware's 0..1 knob values and go
// through the same engine setters the knob pages used.
enum Param
{
    P_PITCH = 0,        // knob 1 / page 1       (.5 = no shift, 0/1 = -/+1 oct)
    P_FRAME,            // knob 1 / page 2       frame 0..32 (integer)
    P_TABLE,            // shift + knob 1 / p2   slot 0..6 (integer)
    P_ATTACK,           // knob 2 / page 1
    P_RELEASE,          // knob 3 / page 1
    P_PITCH_LFO_DEPTH,  // knob 2 / page 2
    P_FILTER_LFO_DEPTH, // knob 3 / page 2
    P_PITCH_LFO_RATE,   // shift + knob 2 / page 2
    P_FILTER_LFO_RATE,  // shift + knob 3 / page 2
    P_FX,               // knob 4 / page 1       delay <- .5 dry -> reverb
    P_FX_TIME,          // shift + knob 4 / p1   delay time / reverb size
    P_CUTOFF,           // knob 4 / page 2       LP <- .5 open -> HP
    P_RESONANCE,        // shift + knob 4 / p2
    P_GAIN,             // knob 6 / page 1
    P_PAN,              // knob 6 / page 2
    P_DRIVE,            // shift + knob 6        compressor -> saturation
    P_PITCH_LFO_ON,     // 0/1
    P_FILTER_LFO_ON,    // 0/1
    P_OCTAVE,           // -1..1 (integer)
    P_TEMPO,            // firmware tempo units 160..480 (= 2x BPM)
    P_CLOCK_DIV,        // 0..4 (1/4, dotted 1/8, 1/8, 1/8T, 1/16 at 2x tempo)
    P_GATE,             // sequencer gate 0..1 of the step
    P_COUNT
};

float params[P_COUNT];
bool flash_cleared_step = false; // a hold gesture just deleted/cleared (UI blink)
int clock_div_pos = 2; // mirrors clockManager::newDivPos (private there)

// When the current sequencer step started (ms, System::GetNow()), tracked
// here because clockManager keeps it private. Used to round live-recorded
// notes to the nearest step.
uint32_t step_start_ms = 0;
int last_step_idx = -1;
bool last_first_run = true;
uint32_t live_recorded_hi[4] = {0, 0, 0, 0}; // notes placed live, so their release doesn't append them too

void applyParam(int id, float v)
{
    switch (id)
    {
    case P_PITCH: engine.setGlobalPitch(v); break;
    case P_FRAME: engine.setCycle(static_cast<int8_t>(v), true); break;
    case P_TABLE: engine.nextTable(static_cast<int8_t>(v), true); break;
    case P_ATTACK: engine.setAttack(v); break;
    case P_RELEASE: engine.setRelease(v); break;
    case P_PITCH_LFO_DEPTH: engine.setPitchLfoDepth(v); break;
    case P_FILTER_LFO_DEPTH: engine.setLfoDepth(v); break;
    case P_PITCH_LFO_RATE: engine.setPitchLfoRate(v); break;
    case P_FILTER_LFO_RATE: engine.setLfoRate(v); break;
    case P_FX: engine.setDelayFeedback(v); break;
    case P_FX_TIME: engine.setDelayTime(v); break;
    case P_CUTOFF: engine.setMasterCutoff(v); break;
    case P_RESONANCE: engine.setMasterResonance(v); break;
    case P_GAIN: engine.setGain(v); break;
    case P_PAN: engine.setPan(v); break;
    case P_DRIVE: engine.setFinalComp(v); break;
    case P_PITCH_LFO_ON: engine.setPitchLfoOn(v > .5f); break;
    case P_FILTER_LFO_ON: engine.setFilterLfoOn(v > .5f); break;
    case P_OCTAVE: engine.setOctave(static_cast<int>(v) - engine.getOctave()); break;
    case P_TEMPO: cManager.changeTempo(static_cast<int>(v)); break;
    case P_CLOCK_DIV:
    {
        // clockManager only moves one division per boundary crossing, and
        // defers the change to the next step boundary - keep that behaviour.
        int target = static_cast<int>(v);
        while (clock_div_pos < target) { cManager.changeDiv(12); clock_div_pos++; }
        while (clock_div_pos > target) { cManager.changeDiv(-12); clock_div_pos--; }
        break;
    }
    case P_GATE: seq.setGate(v); break;
    default: break;
    }
}

float clampParam(int id, float v)
{
    switch (id)
    {
    case P_FRAME: return fclamp(roundf(v), 0.f, CYCLES - 1);
    case P_TABLE: return fclamp(roundf(v), 0.f, kNumSlots - 1);
    case P_PITCH_LFO_ON:
    case P_FILTER_LFO_ON: return v > .5f ? 1.f : 0.f;
    case P_OCTAVE: return fclamp(roundf(v), -1.f, 1.f);
    case P_TEMPO: return fclamp(roundf(v), 160.f, 480.f);
    case P_CLOCK_DIV: return fclamp(roundf(v), 0.f, 4.f);
    default: return fclamp(v, 0.f, 1.f);
    }
}

// The firmware's "defaults slot" (MenuPage::SetVoiceSlot slot 15) plus the
// normal-page knobs that slot doesn't touch (enc_defaults in ui.h).
const float kDefaults[P_COUNT] = {
    .5f,  // pitch
    0.f,  // frame
    0.f,  // table
    0.f,  // attack
    0.f,  // release
    0.f,  // pitch lfo depth
    0.f,  // filter lfo depth
    .58f, // pitch lfo rate
    .58f, // filter lfo rate
    .5f,  // fx (dry)
    .4f,  // fx time
    .5f,  // cutoff (open)
    .63f, // resonance
    .84f, // gain
    .5f,  // pan
    0.f,  // drive
    1.f,  // pitch lfo on
    1.f,  // filter lfo on
    0.f,  // octave
    320.f, // tempo
    2.f,  // clock div
    .5f,  // gate
};

void setParamInternal(int id, float v)
{
    v = clampParam(id, v);
    params[id] = v;
    applyParam(id, v);
}
} // namespace

CF_EXPORT void cf_init(float sample_rate)
{
    daisy::System::sample_rate = sample_rate;
    daisy::System::sample_count = 0;

    std::memset(wavetableMemory, 0, sizeof(wavetableMemory));

    // wavetableLoader::Init() scanned the SD card; here the memory is wired up
    // directly and all 7 slots exist (an empty slot plays silence, like a
    // failed load on the hardware).
    wtLoader.wavetableMemory_ = wavetableMemory;
    wtLoader.numWavetables = kNumSlots;
    wtLoader.index = 0;

    engine.Init(sample_rate, &del_mem[0], &reverb, &wtLoader);
    cManager.Init(nullptr, 0);
    seq.Init(&engine, &cManager, &hw);
    seq.setMidiChannel(0);
    clock_div_pos = 2;

    for (int i = 0; i < P_COUNT; ++i)
        setParamInternal(i, kDefaults[i]);
}

/** Address JS writes 33 x 2048 float32 frames into for a slot. */
CF_EXPORT float *cf_table_ptr(int slot)
{
    if (slot < 0 || slot >= kNumSlots)
        return nullptr;
    return &wavetableMemory[slot * kRowsPerTable][0];
}

CF_EXPORT float *cf_out_ptr(int ch) { return out_ptrs[ch & 3]; }

CF_EXPORT void cf_process(int frames)
{
    if (frames > kMaxBlock)
        frames = kMaxBlock;
    for (int off = 0; off < frames; off += kSubBlock)
    {
        int n = frames - off < kSubBlock ? frames - off : kSubBlock;
        float *o[4] = {out_buf[0] + off, out_buf[1] + off, out_buf[2] + off, out_buf[3] + off};
        const float *in[2] = {in_buf[0] + off, in_buf[1] + off};

        // NormalPage::Draw() polled this from the UI loop: it turns held
        // PLAY+LOOP / held LOOP into clear-all / delete-last-step.
        if (seq.checkReset())
            flash_cleared_step = true;

        // same order as AudioCallback() in chompi_main.cpp
        if (seq.getPlaying())
        {
            seq.checkAndPop();
            if (seq.currentIdx != last_step_idx || (last_first_run && !seq.isFirstRun))
                step_start_ms = daisy::System::GetNow();
            last_step_idx = seq.currentIdx;
            last_first_run = seq.isFirstRun;
        }
        else
        {
            last_step_idx = -1;
            last_first_run = true;
        }
        engine.Prepare();
        engine.Process(in, o, n);

        daisy::System::sample_count += n;
    }
}

// ---- notes -------------------------------------------------------------
// key = MIDI note number, which identifies the voice (so the sequencer and a
// held key on the same note share a voice, as on the hardware). Pitch follows
// the firmware's MIDI-in path: nn = note - 60.

CF_EXPORT void cf_seq_set_step(int i, int note);

namespace
{
bool liveRecording() { return seq.getPlaying() && seq.getRecording() && seq.sequenceLength > 0; }

/** Step a live note belongs to: the current one, or the next if we're past
 *  half of the current step (nearest-step rounding). */
int liveTargetStep()
{
    const float interval = (60000.f / static_cast<float>(cManager.getTempo()))
                           * (static_cast<float>(freeDivs[clock_div_pos].clock_division) / 12.f);
    const uint32_t elapsed = daisy::System::GetNow() - step_start_ms;
    int idx = seq.currentIdx;
    if (!seq.isFirstRun && elapsed > interval * 0.5f)
        idx = (idx + 1) % seq.sequenceLength;
    return idx;
}

bool liveBit(int note) { return live_recorded_hi[note >> 5] & (1u << (note & 31)); }
void setLiveBit(int note, bool on)
{
    if (on) live_recorded_hi[note >> 5] |= 1u << (note & 31);
    else live_recorded_hi[note >> 5] &= ~(1u << (note & 31));
}
} // namespace

CF_EXPORT void cf_note_on(int note, int velocity)
{
    if (note < 0 || note > 127)
        return;
    // MidiManager passes data[1] + 1
    engine.request_fifo.PushBack(KeyRequest(KeyRequest::Type::START, static_cast<float>(note - 60), note,
                                            static_cast<float>(velocity + 1)));
    // Chompfe addition: recording while the loop PLAYS overdubs - the note
    // replaces the step under the playhead (rounded to the nearest step).
    // The firmware only appended; that still happens when the loop is stopped.
    if (liveRecording())
    {
        cf_seq_set_step(liveTargetStep(), note);
        setLiveBit(note, true);
    }
}

CF_EXPORT void cf_note_off(int note)
{
    if (note < 0 || note > 127)
        return;
    engine.request_fifo.PushBack(KeyRequest(KeyRequest::Type::STOP, static_cast<float>(note - 60), note, 127.f));
    // NormalPage records a step when a key is RELEASED while LOOP is armed.
    // (On the hardware only the front-panel keys record; here every user note
    // source does, so a MIDI keyboard can record too.) A note already placed
    // live by cf_note_on isn't appended again.
    if (liveBit(note))
        setLiveBit(note, false);
    else if (seq.getRecording())
        seq.insertNextKey(KeyRequest(KeyRequest::Type::STOP, static_cast<float>(note - 60), note, 127.f));
}

CF_EXPORT void cf_all_notes_off()
{
    engine.request_fifo.Clear();
    engine.stopAllVoices();
    for (int i = 0; i < NUM_VOICES; ++i)
    {
        engine.myVoices[i].activeFromUser = false;
        engine.myVoices[i].activeFromSequencer = false;
    }
}

// ---- parameters ----------------------------------------------------------

CF_EXPORT void cf_set_param(int id, float v)
{
    if (id >= 0 && id < P_COUNT)
        setParamInternal(id, v);
}

CF_EXPORT float cf_get_param(int id) { return (id >= 0 && id < P_COUNT) ? params[id] : 0.f; }
CF_EXPORT int cf_param_count() { return P_COUNT; }
CF_EXPORT float cf_param_default(int id) { return (id >= 0 && id < P_COUNT) ? kDefaults[id] : 0.f; }

/** Relative frame step, exactly like turning the knob on the hardware. */
CF_EXPORT void cf_frame_step(int turns)
{
    engine.setCycle(static_cast<int8_t>(turns), false);
    params[P_FRAME] = static_cast<float>(engine.getCycle());
}

// ---- meters / state for the UI ----------------------------------------------

CF_EXPORT float cf_vu() { return engine.getVUSample(); }
CF_EXPORT int cf_voice_mask()
{
    int m = 0;
    for (int i = 0; i < NUM_VOICES; ++i)
        if (engine.myVoices[i].amp_env.IsRunning())
            m |= 1 << i;
    return m;
}
CF_EXPORT int cf_voice_key(int i) { return (i >= 0 && i < NUM_VOICES) ? engine.myVoices[i].key : -1; }

// ---- sequencer -------------------------------------------------------------
// The firmware records up to 32 steps in order (note or rest) and loops them.
// A step grid maps straight onto that: step i = mySequence[i], a rest is the
// DUMMY request, and the loop length is sequenceLength.

CF_EXPORT void cf_seq_set_step(int i, int note)
{
    if (i < 0 || i >= Sequencer::kMaxSeqLen)
        return;
    KeyRequest &cur = seq.mySequence[i];
    // Changing the step that is sounding right now: release its note first,
    // otherwise the sequencer would later stop the NEW note and hang the old one.
    if (seq.getPlaying() && i == seq.currentIdx && !seq.isFirstRun && cur.type_ != KeyRequest::Type::DUMMY
        && !seq.last_step_muted && !seq.gate_stopped)
    {
        KeyRequest stop = cur;
        stop.type_ = KeyRequest::Type::STOP;
        stop.src_ = KeyRequest::Source::SEQUENCER;
        engine.request_fifo.PushBack(stop);
        seq.gate_stopped = true;
    }
    if (note < 0 || note > 127)
        cur = KeyRequest();
    else
        cur = KeyRequest(KeyRequest::Type::STOP, static_cast<float>(note - 60), note, 127.f,
                         KeyRequest::Source::SEQUENCER);
}

CF_EXPORT int cf_seq_get_step(int i)
{
    if (i < 0 || i >= Sequencer::kMaxSeqLen)
        return -1;
    const KeyRequest &r = seq.mySequence[i];
    return r.type_ == KeyRequest::Type::DUMMY ? -1 : r.key_;
}

CF_EXPORT void cf_seq_set_length(int n)
{
    if (n < 0) n = 0;
    if (n > Sequencer::kMaxSeqLen) n = Sequencer::kMaxSeqLen;
    seq.sequenceLength = static_cast<uint8_t>(n);
    if (n == 0 && seq.getPlaying())
        seq.togglePlaying(true);
}

CF_EXPORT int cf_seq_get_length() { return seq.sequenceLength; }

CF_EXPORT void cf_seq_play(int on)
{
    if ((on != 0) != seq.getPlaying())
        seq.togglePlaying(true);
}

CF_EXPORT int cf_seq_playing() { return seq.getPlaying() ? 1 : 0; }
CF_EXPORT int cf_seq_index() { return seq.currentIdx; }
CF_EXPORT void cf_seq_mute(int m) { seq.setMuted(m != 0); }

CF_EXPORT void cf_seq_clear()
{
    seq.clearSequence();
}

// ---- the three transport keys, exactly as NormalPage::OnButton handles them ----

/** PLAY key. Press toggles playback; holding it with LOOP clears (see checkReset). */
CF_EXPORT void cf_play_button(int down) { seq.playButton(down != 0); }

/** LOOP key. Release toggles recording; holding it deletes the last step. */
CF_EXPORT void cf_loop_button(int down) { seq.loopButton(down != 0); }

/** The rest key (the CHOMPI key on the hardware): while recording, press adds
 *  a rest; otherwise holding it mutes the sequencer. */
CF_EXPORT void cf_rest_button(int down)
{
    if (down)
    {
        if (liveRecording())
            cf_seq_set_step(liveTargetStep(), -1); // overdub a rest at the playhead
        else if (seq.getRecording())
            seq.insertRest();
        else
            seq.setMuted(true);
    }
    else
    {
        seq.setMuted(false);
    }
}

CF_EXPORT void cf_seq_record(int on)
{
    if ((on != 0) != seq.getRecording())
        seq.toggleRecording(true);
}

/** 1 while the current step's note is still held (between the step start and
 *  the gate cutting it), so a UI can show the gate length. */
CF_EXPORT int cf_seq_gate_open()
{
    if (!seq.getPlaying() || seq.sequenceLength == 0 || seq.isFirstRun)
        return 0;
    const KeyRequest &r = seq.mySequence[seq.currentIdx];
    return (r.type_ != KeyRequest::Type::DUMMY && !seq.gate_stopped && !seq.last_step_muted) ? 1 : 0;
}

CF_EXPORT int cf_seq_recording() { return seq.getRecording() ? 1 : 0; }
CF_EXPORT int cf_seq_muted() { return seq.muted ? 1 : 0; }

/** UI flags, each read-and-clear: 1 = sequence full, 2 = cleared all,
 *  4 = a hold gesture removed steps. */
CF_EXPORT int cf_seq_flags()
{
    int f = 0;
    if (seq.showSequenceFull()) f |= 1;
    if (seq.showClearedAll()) f |= 2;
    if (flash_cleared_step) f |= 4;
    flash_cleared_step = false;
    return f;
}

/** Tap tempo, clockManager::processTapClock (the transport-knob press). */
CF_EXPORT int cf_tap_tempo()
{
    cManager.processTapClock(0.f);
    params[P_TEMPO] = static_cast<float>(cManager.getTempo());
    return cManager.getTempo();
}

// ---- MIDI out (sequencer notes + transport), drained by JS -----------------

CF_EXPORT int cf_midi_out_pop()
{
    if (hw.midi_out.IsEmpty())
        return -1;
    ChompfeMidiOut ev = hw.midi_out.PopFront();
    return ev.status | (ev.d1 << 8) | (ev.d2 << 16);
}
