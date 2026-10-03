// Chompfe shim: the CHOMPI hardware class, reduced to the MIDI-out queue the
// Sequencer calls into. Queued events are drained by the web layer, which
// can forward them to a Web MIDI output.
#pragma once
#include "daisy.h"

struct ChompfeMidiOut
{
    uint8_t status; // full MIDI status byte (type | channel)
    uint8_t d1, d2;
};

class Hardware
{
  public:
    FIFO<ChompfeMidiOut, 128> midi_out;

    void queueMidiNote(uint8_t channel, uint8_t note, uint8_t velocity, MidiMessageType type)
    {
        uint8_t st = (type == NoteOn ? 0x90 : 0x80) | (channel & 0x0f);
        ChompfeMidiOut ev{st, note, velocity};
        midi_out.PushBack(ev);
    }

    void queueMidiTransport(bool start)
    {
        ChompfeMidiOut ev{uint8_t(start ? 0xFA : 0xFC), 0, 0};
        midi_out.PushBack(ev);
    }
};
