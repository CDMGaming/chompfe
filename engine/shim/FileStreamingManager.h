// Chompfe shim: the SD request queue is gone. The request types and queue
// keep the same shape so WavetableManager.h / subtractiveEngine.h compile
// unmodified; nothing is ever queued because wavetableLoader::loadAllToMemory()
// is never called.
#pragma once
#include "daisy.h"
#include "fatfs.h"

namespace daisy
{
static constexpr size_t kMaxFileStreamingSamps = 8192;
using SampleFifo = FIFO<int16_t, kMaxFileStreamingSamps>;

struct FileRequest
{
    enum class Type
    {
        OPEN,
        OPEN_NEW,
        OPEN_NEW_TWO,
        SEEK,
        READ,
        REV_READ,
        MASS_READ,
        WRITE,
        CLOSE,
        HEADER,
        UNLINK,
        TRUNCATE,
        DUMMY,
    };

    Type type_;
    FIL *fil_;
    const char *fname_;
    size_t size_in_bytes_;
    SampleFifo *fifo_;
    void *id_;
    float *wavetableMemory;

    FileRequest(Type type, FIL *fileptr, const char *filename, size_t bytes,
                SampleFifo *fifo, void *id, float *memory)
        : type_(type), fil_(fileptr), fname_(filename), size_in_bytes_(bytes),
          fifo_(fifo), id_(id), wavetableMemory(memory)
    {
    }

    FileRequest()
        : type_(Type::DUMMY), fil_(nullptr), fname_(nullptr), size_in_bytes_(0),
          fifo_(nullptr), id_(nullptr), wavetableMemory(nullptr)
    {
    }
};

class FileStreamingManager
{
  public:
    FIFO<FileRequest, 64> request_fifo;
    void Init(float) {}
    void ProcessRequests() { request_fifo.Clear(); }
};
} // namespace daisy

using namespace daisy;
