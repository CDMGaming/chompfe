// Chompfe shim: there are no interrupts in the browser; the audio thread is
// the only thread that touches the engine.
#pragma once
namespace daisy
{
struct ScopedIrqBlocker
{
};
} // namespace daisy
