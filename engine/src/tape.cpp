// Chompfe: thin C API around the vendored TAPE engine (sampler + tape looper
// + multi-FX), for WebAssembly. Replaces chompi_main.cpp: same buffers, same
// init order, the same audio callback (Prepare, Process) and the same
// low-priority SD tick (file copier, else one file request). The SD card is
// the in-memory FatFs in shim-tape/memfs.cpp.
//
// Knob/page logic (NormalPage.h / MenuPage.h) lives in JS, like WAVE's; this
// file only exposes the Engine's own methods.

#include "daisy.h"
#include "daisysp.h"
#include "DSPEngine.h"
#include "FileCopier.h"
#include "RamBuffer.h"
#include "InterpolatedDelayLine.h"
#include <cstring>

#define TP_EXPORT extern "C" __attribute__((used, visibility("default")))

uint64_t daisy::System::sample_count = 0;
float daisy::System::sample_rate = 48000.f;

using namespace daisy;

namespace
{
constexpr int kMaxBlock = 128;
constexpr int kSubBlock = 32; // ~the hardware's block; ProcessKeyReqs pops one note per block

Engine engine;
FileCopier copier;
daisysp::Reverb reverb;
chompi::InterpolatedDelayLine::AudioSample del_mem[kMaxDelayTime];
RamBufferMemory loop_buff;
int16_t loop_mem[kMaxRamBuffSize];
RamBufferMemory chompi_buff;
int16_t chompi_mem[kMaxRamBuffSize];

// inputs as on the hardware: 0 mic, 1 unused, 2/3 aux (line) L/R
float in_buf[4][kMaxBlock];
float out_buf[4][kMaxBlock];
char name_buf[64];

// boot scan (chompi_main.cpp MainLoop while booting): give every sample a
// clean header and a *_double file
bool booting = false;
int boot_preset = 0, boot_bank = 0, boot_mode = 0;
} // namespace

// ---- lifecycle -----------------------------------------------------------

TP_EXPORT void tp_init(float sample_rate, int record_latch, int tape_slew, int monitor_mode)
{
    System::sample_rate = sample_rate;
    System::sample_count = 0;
    loop_buff.Init(&loop_mem[0]);
    chompi_buff.Init(&chompi_mem[0]);
    engine.Init(sample_rate, &reverb, &del_mem[0], &loop_buff, &chompi_buff, record_latch != 0, tape_slew != 0,
                MonitorMode(monitor_mode));
    copier.Init(sample_rate, &engine, &chompi_buff, &loop_buff);
    engine.FillDefaultSample(sample_rate);
    // NormalPage::Init
    engine.SetGlobalPitch(1.f);
    engine.SetReverse(false);
    engine.SetInputGain(.75f);
}

TP_EXPORT float *tp_in_ptr(int ch) { return in_buf[ch & 3]; }
TP_EXPORT float *tp_out_ptr(int ch) { return out_buf[ch & 3]; }

TP_EXPORT void tp_process(int frames)
{
    if (frames > kMaxBlock)
        frames = kMaxBlock;
    for (int off = 0; off < frames; off += kSubBlock)
    {
        const int n = frames - off < kSubBlock ? frames - off : kSubBlock;
        const float *in[4] = {in_buf[0] + off, in_buf[1] + off, in_buf[2] + off, in_buf[3] + off};
        float *o[4] = {out_buf[0] + off, out_buf[1] + off, out_buf[2] + off, out_buf[3] + off};

        // SDCallback, ~1 kHz on the hardware: a copy step, else one file request
        if (!copier.CopyProcess())
            engine.ProcessFileRequests();

        // AudioCallback
        engine.Prepare();
        engine.Process(in, o, n);
        System::sample_count += n;
    }
}

// ---- the "SD card" ---------------------------------------------------------

/** Scratch space for passing a file name from JS (NUL-terminated). */
TP_EXPORT char *tp_name_buf() { return name_buf; }

/** Create/replace the file named in tp_name_buf with `size` bytes; returns
 *  where JS should write them. */
TP_EXPORT uint8_t *tp_fs_put(int size) { return memfs::put(name_buf, (size_t)size); }

/** Pointer to the file named in tp_name_buf (size via tp_fs_size), or 0. */
TP_EXPORT const uint8_t *tp_fs_get() { return memfs::get(name_buf, nullptr); }
TP_EXPORT int tp_fs_size()
{
    size_t n = 0;
    return memfs::get(name_buf, &n) ? (int)n : -1;
}
TP_EXPORT int tp_fs_remove() { return memfs::remove(name_buf) ? 1 : 0; }
TP_EXPORT int tp_fs_bytes() { return (int)memfs::bytes_used(); }

namespace
{
char changes_buf[8192];
}
/** Files the firmware wrote ("+name") or deleted ("-name") since the last
 *  call, newline-separated, NUL-terminated. The app keeps the card in
 *  browser storage with these. */
TP_EXPORT const char *tp_fs_changes()
{
    memfs::take_changes(changes_buf, sizeof(changes_buf));
    return changes_buf;
}

/** Start the boot scan over all modes/banks/slots (call after adding files). */
TP_EXPORT void tp_boot_begin()
{
    booting = true;
    boot_preset = boot_bank = boot_mode = 0;
}

/** Run up to `budget` steps of the boot scan + copier; returns 1 while busy. */
TP_EXPORT int tp_boot_pump(int budget)
{
    while (budget-- > 0)
    {
        if (copier.CopyProcess())
            continue;
        if (!booting)
            return copier.IsCopying() ? 1 : 0;
        if (!copier.IsCopying())
        {
            if (copier.NeedsOverwrite(boot_preset, VoiceMode(boot_mode), boot_bank))
            {
                FileCopier::CopyRequest req(boot_preset + 1, boot_bank, VoiceMode(boot_mode), boot_preset + 1, boot_bank,
                                            VoiceMode(boot_mode), false, FileCopier::CopyRequest::RamDir::NONE,
                                            FileCopier::CopyRequest::RamDir::NONE);
                copier.req_fifo.PushBack(req);
            }
            if (++boot_preset >= 14)
            {
                boot_preset = 0;
                if (++boot_bank >= 5)
                {
                    boot_bank = 0;
                    if (++boot_mode >= 2)
                    {
                        engine.UpdateFileExists();
                        booting = false;
                    }
                }
            }
        }
    }
    return 1;
}

// ---- keys --------------------------------------------------------------------
// `button` is the hardware button id (Hardware::SwId, 7..31 for the keybed),
// `note` its MIDI note (key_map[button]) - exactly what NormalPage pushes.

TP_EXPORT void tp_key(int button, int note, int down, float velocity)
{
    if (down)
    {
        engine.request_fifo.PushBack(KeyRequest(KeyRequest::Type::START, (float)(note - 60), button, velocity));
        // NormalPage / ProcessMidi: a key press starts an armed looper recording
        if (engine.GetLooperRecordArm())
            engine.ToggleLooperRecord();
    }
    else
        engine.request_fifo.PushBack(KeyRequest(KeyRequest::Type::STOP, 0.f, button, 127.f));
}

TP_EXPORT int tp_key_playing(int button) { return engine.IsKeyPlaying(button) ? 1 : 0; }

TP_EXPORT void tp_open_cubbi_slot(float pitch, float start, float end, float attack, float decay, int autoloop,
                                  int sustain, float gain, float pan)
{
    engine.OpenCubbiSlot(pitch, start, end, attack, decay, autoloop != 0, sustain != 0, gain, pan);
}

// ---- engine setters ------------------------------------------------------
// One entry point keeps the export list short; ids mirror Engine's methods.

enum Cmd
{
    C_VOICE_MODE = 0, // a: 0 jammi, 1 cubbi
    C_BANK,           // a: 0..4
    C_VOICE_SLOT,     // a: 1..15, b: click
    C_PITCH_FREE,     // a: knob 0..1
    C_START,          // a: 0..1 -> returns ok
    C_END,
    C_START_FORCE,
    C_END_FORCE,
    C_ATTACK,
    C_DECAY,
    C_GAIN,
    C_PAN,
    C_AUTOLOOP,
    C_SUSTAIN,
    C_REVERB,
    C_DELAY_FEEDBACK,
    C_DELAY_TIME,
    C_SATURATE,
    C_WARBLE,
    C_FILTER,
    C_RESONANCE,
    C_MAIN_GAIN,
    C_INPUT_GAIN,
    C_FINAL_COMP,
    C_LOOPER_PITCH_FREE,
    C_LOOPER_PITCH,
    C_LOOPER_SCRUB,     // a: turns
    C_LOOPER_PLAY_BTN,  // a: rising
    C_LOOPER_REC_BTN,   // a: rising (ignored while sampling, as NormalPage does)
    C_LOOPER_TOGGLE_REC,
    C_LOOPER_DUB_GAIN,  // a: increment
    C_FX_PRE_LOOPER,    // a: 0/1
    C_INPUT_SOURCE,     // a: 0 mic, 1 line, 2 resample
    C_INPUT_MONITOR,    // a: 0/1
    C_MONITOR_NEXT,
    C_RECORD_START,
    C_RECORD_STOP,
    C_PITCH_QUANT,      // a: turns, b: knob value -> returns new knob value
    C_LOOPER_PITCH_QUANT,
    C_RESET_PITCH_QUANT,
    C_RESET_LOOPER_PITCH_QUANT,
    C_STOP_ALL,
    C_GLOBAL_PITCH,     // a: ratio
    C_REVERSE,          // a: 0/1
    C_INCREMENT_BANK,
    C_ERASE,            // a: slot 1..14, b: bank (mode = current)
    C_COPY,             // a: src slot, b: dest slot; uses tp_copy_* for banks/modes
    C_LOOPER_OPEN_FILE, // reload the looper from looper.wav (after a copy/save into it)
    C_TOGGLE_AUTOLOOP,
    C_TOGGLE_SUSTAIN,
    C_COUNT
};

namespace
{
int copy_src_bank = 0, copy_src_mode = 0, copy_dest_bank = 0, copy_dest_mode = 0, copy_set = 0;
int copy_chompi = 0, copy_looper = 0;
} // namespace

/** Banks/modes/RAM directions for the next C_COPY (FileCopier::CopyRequest). */
TP_EXPORT void tp_copy_setup(int src_bank, int src_mode, int dest_bank, int dest_mode, int set, int chompi_dir,
                             int looper_dir)
{
    copy_src_bank = src_bank;
    copy_src_mode = src_mode;
    copy_dest_bank = dest_bank;
    copy_dest_mode = dest_mode;
    copy_set = set;
    copy_chompi = chompi_dir;
    copy_looper = looper_dir;
}

TP_EXPORT float tp_cmd(int op, float a, float b)
{
    switch (op)
    {
    case C_VOICE_MODE: engine.SetVoiceMode(a > 0.5f ? VoiceMode::CUBBI : VoiceMode::JAMMI); break;
    case C_BANK: engine.SetBank((size_t)a); break;
    case C_VOICE_SLOT: engine.SetVoiceSlot((size_t)a, b > 0.5f); break;
    case C_PITCH_FREE: engine.SetGlobalPitchFree(a); break;
    case C_START: return engine.SetStartPoint(a) ? 1.f : 0.f;
    case C_END: return engine.SetEndPoint(a) ? 1.f : 0.f;
    case C_START_FORCE: engine.SetStartPointForce(a); break;
    case C_END_FORCE: engine.SetEndPointForce(a); break;
    case C_ATTACK: engine.SetAttack(a); break;
    case C_DECAY: engine.SetDecay(a); break;
    case C_GAIN: engine.SetGain(a); break;
    case C_PAN: engine.SetPan(a); break;
    case C_AUTOLOOP: engine.SetAutoLoop(a > 0.5f); break;
    case C_SUSTAIN: engine.SetSustainActive(a > 0.5f); break;
    case C_REVERB: engine.SetReverb(a); break;
    case C_DELAY_FEEDBACK: engine.SetDelayFeedback(a); break;
    case C_DELAY_TIME: engine.SetDelayTime(a); break;
    case C_SATURATE: engine.SetSaturate(a); break;
    case C_WARBLE: engine.SetWarble(a); break;
    case C_FILTER: engine.SetFilter(a); break;
    case C_RESONANCE: engine.SetFilterResonance(a); break;
    case C_MAIN_GAIN: engine.SetMainGain(a); break;
    case C_INPUT_GAIN: engine.SetInputGain(a); break;
    case C_FINAL_COMP: engine.SetFinalComp(a); break;
    case C_LOOPER_PITCH_FREE: engine.SetLooperPitchFree(a); break;
    case C_LOOPER_PITCH: engine.SetLooperPitch(a); break;
    case C_LOOPER_SCRUB: engine.SetLooperScrub(a); break;
    case C_LOOPER_PLAY_BTN: engine.LooperPlayButton(a > 0.5f); break;
    case C_LOOPER_REC_BTN:
        if (!engine.Recording())
            engine.LooperRecordButton(a > 0.5f);
        break;
    case C_LOOPER_TOGGLE_REC: engine.ToggleLooperRecord(); break;
    case C_LOOPER_DUB_GAIN: engine.IncrementLooperDubGain(a); break;
    case C_FX_PRE_LOOPER: engine.SetFxPreLooper(a > 0.5f); break;
    case C_INPUT_SOURCE: engine.SetInputSource(InputSource((int)a)); break;
    case C_INPUT_MONITOR: engine.SetInputMonitor(a > 0.5f); break;
    case C_MONITOR_NEXT: engine.IncrementMonitorMode(); break;
    case C_RECORD_START: engine.StartNewRecording(0); break;
    case C_RECORD_STOP: engine.StopRecording(); break;
    case C_PITCH_QUANT: return engine.SetGlobalPitchQuantized((int16_t)a, b);
    case C_LOOPER_PITCH_QUANT: return engine.SetLooperPitchQuantized((int16_t)a, b);
    case C_RESET_PITCH_QUANT: engine.ResetGlobalPitchQuant(); break;
    case C_RESET_LOOPER_PITCH_QUANT: engine.ResetLooperPitchQuant(); break;
    case C_STOP_ALL: engine.StopAllVoices(); break;
    case C_GLOBAL_PITCH: engine.SetGlobalPitch(a); break;
    case C_REVERSE: engine.SetReverse(a > 0.5f); break;
    case C_INCREMENT_BANK: engine.IncrementBank(); break;
    case C_ERASE: engine.EraseStart((uint8_t)a, (int)b, engine.GetVoiceMode()); break;
    case C_COPY:
    {
        FileCopier::CopyRequest req((size_t)a, copy_src_bank, VoiceMode(copy_src_mode), (size_t)b, copy_dest_bank,
                                    VoiceMode(copy_dest_mode), copy_set != 0,
                                    FileCopier::CopyRequest::RamDir(copy_chompi),
                                    FileCopier::CopyRequest::RamDir(copy_looper));
        copier.req_fifo.PushBack(req);
        break;
    }
    case C_LOOPER_OPEN_FILE: engine.LooperOpenFile(); break;
    case C_TOGGLE_AUTOLOOP: engine.ToggleAutoLoop(); break;
    case C_TOGGLE_SUSTAIN: engine.ToggleSustainActive(); break;
    default: break;
    }
    return 0.f;
}

// ---- state for the UI ---------------------------------------------------

enum Get
{
    G_VOICE_MODE = 0,
    G_BANK,
    G_VOICE_SLOT,
    G_VOICE_BANK,
    G_FILE_EXISTS, // arg: slot index 0..14 (current mode/bank)
    G_LOOPER_EMPTY,
    G_LOOPER_ARMED,
    G_LOOPER_FIRST_REC,
    G_LOOPER_RECORDING,
    G_LOOPER_PLAYING,
    G_LOOPER_POSITION,
    G_LOOPER_PITCH,
    G_LOOPER_DUB_GAIN,
    G_LOOPER_REVERSE,
    G_RECORDING,
    G_VU_IN,
    G_VU_OUT,
    G_FX_PRE,
    G_INPUT_SOURCE,
    G_MONITOR_MODE,
    G_ANY_VOICES,
    G_AUTOLOOP,
    G_SUSTAIN,
    G_GLOBAL_PITCH,
    G_REVERSE,
    G_PAN,
    G_LOOPER_RESET, // read-and-clear
    G_COPYING,
    G_ERASING,
    G_BOOTING,
    G_LOOPER_SCRUB,
    G_COUNT
};

TP_EXPORT float tp_get(int what, int arg)
{
    switch (what)
    {
    case G_VOICE_MODE: return (float)int(engine.GetVoiceMode());
    case G_BANK: return (float)engine.GetBank();
    case G_VOICE_SLOT: return (float)engine.GetVoiceSlot();
    case G_VOICE_BANK: return (float)engine.GetVoiceBank();
    case G_FILE_EXISTS: return engine.GetFileExists((size_t)arg) ? 1.f : 0.f;
    case G_LOOPER_EMPTY: return engine.GetLooperIsEmpty() ? 1.f : 0.f;
    case G_LOOPER_ARMED: return engine.IsLooperRecordArmed() ? 1.f : 0.f;
    case G_LOOPER_FIRST_REC: return engine.IsLooperFirstRecording() ? 1.f : 0.f;
    case G_LOOPER_RECORDING: return engine.IsLooperRecording() ? 1.f : 0.f;
    case G_LOOPER_PLAYING: return engine.IsLooperPlaying() ? 1.f : 0.f;
    case G_LOOPER_POSITION: return engine.GetLooperPosition();
    case G_LOOPER_PITCH: return engine.GetLooperPitch();
    case G_LOOPER_DUB_GAIN: return engine.GetLooperDubGain();
    case G_LOOPER_REVERSE: return engine.GetLooperReverse() ? 1.f : 0.f;
    case G_RECORDING: return engine.Recording() ? 1.f : 0.f;
    case G_VU_IN: return engine.GetVUSample(VUTarget::VU_INPUT);
    case G_VU_OUT: return engine.GetVUSample(VUTarget::VU_OUTPUT);
    case G_FX_PRE: return engine.GetFxPreLooper() ? 1.f : 0.f;
    case G_INPUT_SOURCE: return (float)int(engine.GetInputSource());
    case G_MONITOR_MODE: return (float)int(engine.GetMonitorMode());
    case G_ANY_VOICES: return engine.AnyVoicesPlaying() ? 1.f : 0.f;
    case G_AUTOLOOP: return engine.GetAutoLoop() ? 1.f : 0.f;
    case G_SUSTAIN: return engine.GetSustainActive() ? 1.f : 0.f;
    case G_GLOBAL_PITCH: return engine.GetGlobalPitch();
    case G_REVERSE: return engine.GetReverse() ? 1.f : 0.f;
    case G_PAN: return engine.GetPan();
    case G_LOOPER_RESET: return engine.CheckReset() ? 1.f : 0.f;
    case G_COPYING: return copier.IsCopying() ? 1.f : 0.f;
    case G_ERASING: return engine.IsErasing() ? 1.f : 0.f;
    case G_BOOTING: return booting ? 1.f : 0.f;
    case G_LOOPER_SCRUB: return engine.GetLooperScrub();
    default: return 0.f;
    }
}
