// Chompfe shim: FatFs on an in-memory "SD card" (memfs.cpp), so TAPE's sample
// streaming, file copier and recorder run unmodified. Same names, flags,
// struct fields and result codes the firmware uses; semantics follow FatFs
// R0.14 where the firmware depends on them (FA_OPEN_ALWAYS creates the file,
// f_close leaves obj.objsize alone, f_lseek past the end extends a writable
// file, f_size/f_tell/f_eof are field reads).
#pragma once
#include <cstdint>
#include <cstddef>

typedef unsigned int UINT;
typedef uint8_t BYTE;
typedef uint32_t DWORD;
typedef uint32_t FSIZE_t;

typedef enum
{
    FR_OK = 0,
    FR_DISK_ERR,
    FR_INT_ERR,
    FR_NOT_READY,
    FR_NO_FILE,
    FR_NO_PATH,
    FR_INVALID_NAME,
    FR_DENIED,
    FR_EXIST,
    FR_INVALID_OBJECT,
    FR_WRITE_PROTECTED,
    FR_INVALID_DRIVE,
    FR_NOT_ENABLED,
    FR_NO_FILESYSTEM,
    FR_MKFS_ABORTED,
    FR_TIMEOUT,
    FR_LOCKED,
    FR_NOT_ENOUGH_CORE,
    FR_TOO_MANY_OPEN_FILES,
    FR_INVALID_PARAMETER
} FRESULT;

#define FA_READ 0x01
#define FA_WRITE 0x02
#define FA_OPEN_EXISTING 0x00
#define FA_CREATE_NEW 0x04
#define FA_CREATE_ALWAYS 0x08
#define FA_OPEN_ALWAYS 0x10
#define FA_OPEN_APPEND 0x30

struct FATFS {};

struct FFOBJID
{
    void *fs;        // non-null while open
    FSIZE_t objsize; // file size
};

struct FIL
{
    FFOBJID obj;
    BYTE flag;
    FSIZE_t fptr;
    int file; // memfs index, -1 = none
};

struct FILINFO
{
    FSIZE_t fsize;
    char fname[256];
};

struct DIR {};

#define f_size(fp) ((fp)->obj.objsize)
#define f_tell(fp) ((fp)->fptr)
#define f_eof(fp) ((int)((fp)->fptr == (fp)->obj.objsize))

FRESULT f_open(FIL *fp, const char *path, BYTE mode);
FRESULT f_close(FIL *fp);
FRESULT f_read(FIL *fp, void *buff, UINT btr, UINT *br);
FRESULT f_write(FIL *fp, const void *buff, UINT btw, UINT *bw);
FRESULT f_lseek(FIL *fp, FSIZE_t ofs);
FRESULT f_truncate(FIL *fp);
FRESULT f_sync(FIL *fp);
FRESULT f_unlink(const char *path);
FRESULT f_stat(const char *path, FILINFO *fno);
inline FRESULT f_opendir(DIR *, const char *) { return FR_NO_PATH; }
inline FRESULT f_readdir(DIR *, FILINFO *) { return FR_NO_PATH; }
inline FRESULT f_closedir(DIR *) { return FR_OK; }

// ---- Chompfe additions: the JS side puts files on / takes files off the card
namespace memfs
{
/** Create (or replace) a file of `size` bytes; returns where to write them. */
uint8_t *put(const char *name, size_t size);
/** File contents and size, or nullptr. */
const uint8_t *get(const char *name, size_t *size);
bool remove(const char *name);
size_t bytes_used();
} // namespace memfs
