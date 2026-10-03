// Chompfe shim: the slice of libDaisy the vendored DSP headers use, minus the
// hardware. Everything here replaces something that lived on the Daisy Seed.
#pragma once
#include <cstdint>
#include <cstddef>
#include <cmath>
#include <algorithm>
#include "util/FIFO.h" // vendored unmodified from libDaisy

// Same constants and bodies as libDaisy's daisy_core.h
#define FBIPMAX 0.999985f
#define FBIPMIN (-FBIPMAX)
#define S162F_SCALE 3.05185094759971922971282082583086642048402356028931546983245338297677541e-05f
#define F2S16_SCALE 32767.0f

namespace daisy
{
inline float s162f(int32_t x) { return (float)x * S162F_SCALE; }
inline int32_t f2s16(float x)
{
    x = x <= FBIPMIN ? FBIPMIN : x;
    x = x >= FBIPMAX ? FBIPMAX : x;
    return (int32_t)(x * F2S16_SCALE);
}

enum MidiMessageType
{
    NoteOff,
    NoteOn,
    PolyphonicKeyPressure,
    ControlChange,
    ProgramChange,
    ChannelPressure,
    PitchBend,
    SystemCommon,
    SystemRealTime,
    ChannelMode,
    MessageLast,
};

/** System::GetNow() was the SysTick millisecond counter. Here it is derived
 *  from the number of samples rendered, so sequencer timing is sample-locked
 *  to the audio stream instead of a wall clock. */
struct System
{
    static uint64_t sample_count;
    static float sample_rate;
    static uint32_t GetNow()
    {
        return static_cast<uint32_t>((sample_count * 1000ull) / static_cast<uint64_t>(sample_rate));
    }
};

/** Only SetPeriod is used (by clockManager, for MIDI clock out). */
struct TimerHandle
{
    void SetPeriod(uint32_t) {}
};
} // namespace daisy

using namespace daisy;
