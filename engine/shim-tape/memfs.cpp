// In-memory FatFs for the TAPE engine (see fatfs.h). Names are matched
// case-insensitively, like FAT.
#include "fatfs.h"
#include <cstdlib>
#include <cstring>
#include <cctype>

namespace
{
struct File
{
    char name[64];
    uint8_t *data;
    size_t size;
    size_t cap;
    bool used;
    bool dirty; // written by the firmware since the JS side last asked
};

constexpr int kMaxFiles = 256;
File files[kMaxFiles];
int dummy_fs = 1; // anything non-null marks an open FIL

// names the firmware deleted since the JS side last asked
constexpr int kMaxRemoved = 64;
char removed[kMaxRemoved][64];
int num_removed = 0;

void note_removed(const char *name)
{
    for (int i = 0; i < num_removed; ++i)
        if (std::strcmp(removed[i], name) == 0)
            return;
    if (num_removed < kMaxRemoved)
    {
        std::strncpy(removed[num_removed], name, 63);
        removed[num_removed++][63] = 0;
    }
}

bool same(const char *a, const char *b)
{
    for (; *a && *b; ++a, ++b)
        if (std::tolower((unsigned char)*a) != std::tolower((unsigned char)*b))
            return false;
    return *a == *b;
}

int find(const char *name)
{
    if (!name)
        return -1;
    while (*name == '/')
        ++name;
    for (int i = 0; i < kMaxFiles; ++i)
        if (files[i].used && same(files[i].name, name))
            return i;
    return -1;
}

int create(const char *name)
{
    while (*name == '/')
        ++name;
    for (int i = 0; i < kMaxFiles; ++i)
    {
        if (!files[i].used)
        {
            File &f = files[i];
            std::strncpy(f.name, name, sizeof(f.name) - 1);
            f.name[sizeof(f.name) - 1] = 0;
            f.data = nullptr;
            f.size = f.cap = 0;
            f.used = true;
            return i;
        }
    }
    return -1;
}

bool reserve(File &f, size_t n)
{
    if (n <= f.cap)
        return true;
    size_t cap = f.cap ? f.cap : 4096;
    while (cap < n)
        cap = cap < (1u << 24) ? cap * 2 : cap + (1u << 24);
    uint8_t *p = (uint8_t *)std::realloc(f.data, cap);
    if (!p)
        return false;
    f.data = p;
    f.cap = cap;
    return true;
}

File *of(FIL *fp)
{
    if (!fp || !fp->obj.fs || fp->file < 0 || fp->file >= kMaxFiles || !files[fp->file].used)
        return nullptr;
    return &files[fp->file];
}
} // namespace

FRESULT f_open(FIL *fp, const char *path, BYTE mode)
{
    if (!fp || !path)
        return FR_INVALID_PARAMETER;
    int i = find(path);
    if (i < 0)
    {
        if (!(mode & (FA_CREATE_NEW | FA_CREATE_ALWAYS | FA_OPEN_ALWAYS)))
            return FR_NO_FILE;
        i = create(path);
        if (i < 0)
            return FR_TOO_MANY_OPEN_FILES;
    }
    else if (mode & FA_CREATE_NEW && !(mode & FA_OPEN_ALWAYS) && !(mode & FA_CREATE_ALWAYS))
    {
        return FR_EXIST;
    }
    if (mode & FA_CREATE_ALWAYS)
    {
        files[i].size = 0;
        files[i].dirty = true;
    }
    fp->obj.fs = &dummy_fs;
    fp->obj.objsize = (FSIZE_t)files[i].size;
    fp->flag = mode;
    fp->fptr = (mode & FA_OPEN_APPEND) == FA_OPEN_APPEND ? fp->obj.objsize : 0;
    fp->file = i;
    return FR_OK;
}

FRESULT f_close(FIL *fp)
{
    if (!of(fp))
        return FR_INVALID_OBJECT;
    fp->obj.fs = nullptr; // FatFs leaves objsize alone; the firmware clears it itself
    return FR_OK;
}

FRESULT f_read(FIL *fp, void *buff, UINT btr, UINT *br)
{
    if (br)
        *br = 0;
    File *f = of(fp);
    if (!f)
        return FR_INVALID_OBJECT;
    size_t avail = fp->fptr < f->size ? f->size - fp->fptr : 0;
    size_t n = btr < avail ? btr : avail;
    if (n)
        std::memcpy(buff, f->data + fp->fptr, n);
    fp->fptr += (FSIZE_t)n;
    if (br)
        *br = (UINT)n;
    return FR_OK;
}

FRESULT f_write(FIL *fp, const void *buff, UINT btw, UINT *bw)
{
    if (bw)
        *bw = 0;
    File *f = of(fp);
    if (!f)
        return FR_INVALID_OBJECT;
    if (!(fp->flag & FA_WRITE))
        return FR_DENIED;
    size_t end = (size_t)fp->fptr + btw;
    if (!reserve(*f, end))
        return FR_DISK_ERR;
    if (fp->fptr > f->size)
        std::memset(f->data + f->size, 0, fp->fptr - f->size);
    std::memcpy(f->data + fp->fptr, buff, btw);
    if (end > f->size)
        f->size = end;
    f->dirty = true;
    fp->fptr = (FSIZE_t)end;
    fp->obj.objsize = (FSIZE_t)f->size;
    if (bw)
        *bw = btw;
    return FR_OK;
}

FRESULT f_lseek(FIL *fp, FSIZE_t ofs)
{
    File *f = of(fp);
    if (!f)
        return FR_INVALID_OBJECT;
    if (ofs > f->size)
    {
        if (fp->flag & FA_WRITE)
        {
            // FatFs stretches a writable file to the new position
            if (!reserve(*f, ofs))
                return FR_DISK_ERR;
            std::memset(f->data + f->size, 0, ofs - f->size);
            f->size = ofs;
            fp->obj.objsize = ofs;
        }
        else
        {
            ofs = (FSIZE_t)f->size;
        }
    }
    fp->fptr = ofs;
    return FR_OK;
}

FRESULT f_truncate(FIL *fp)
{
    File *f = of(fp);
    if (!f)
        return FR_INVALID_OBJECT;
    if (fp->fptr < f->size)
    {
        f->size = fp->fptr;
        f->dirty = true;
    }
    fp->obj.objsize = (FSIZE_t)f->size;
    return FR_OK;
}

FRESULT f_sync(FIL *fp) { return of(fp) ? FR_OK : FR_INVALID_OBJECT; }

FRESULT f_unlink(const char *path)
{
    int i = find(path);
    if (i < 0)
        return FR_NO_FILE;
    note_removed(files[i].name);
    std::free(files[i].data);
    files[i] = File{};
    return FR_OK;
}

FRESULT f_stat(const char *path, FILINFO *fno)
{
    int i = find(path);
    if (i < 0)
        return FR_NO_FILE;
    if (fno)
    {
        fno->fsize = (FSIZE_t)files[i].size;
        std::strncpy(fno->fname, files[i].name, sizeof(fno->fname) - 1);
        fno->fname[sizeof(fno->fname) - 1] = 0;
    }
    return FR_OK;
}

namespace memfs
{
uint8_t *put(const char *name, size_t size)
{
    int i = find(name);
    if (i < 0)
        i = create(name);
    if (i < 0 || !reserve(files[i], size))
        return nullptr;
    files[i].size = size;
    files[i].dirty = false;
    for (int k = 0; k < num_removed; ++k)
    {
        if (same(removed[k], name))
        {
            removed[k][0] = 0;
        }
    }
    return files[i].data;
}

const uint8_t *get(const char *name, size_t *size)
{
    int i = find(name);
    if (i < 0)
        return nullptr;
    if (size)
        *size = files[i].size;
    return files[i].data;
}

bool remove(const char *name)
{
    int i = find(name);
    if (i < 0)
        return false;
    std::free(files[i].data);
    files[i] = File{};
    return true;
}

size_t take_changes(char *out, size_t cap)
{
    size_t n = 0;
    auto append = [&](char prefix, const char *name) {
        size_t len = std::strlen(name);
        if (n + len + 2 >= cap)
            return false;
        out[n++] = prefix;
        std::memcpy(out + n, name, len);
        n += len;
        out[n++] = '\n';
        return true;
    };
    for (auto &f : files)
        if (f.used && f.dirty && append('+', f.name))
            f.dirty = false;
    int kept = 0;
    for (int k = 0; k < num_removed; ++k)
    {
        if (!removed[k][0])
            continue;
        if (!append('-', removed[k]))
            std::memmove(removed[kept++], removed[k], 64);
    }
    num_removed = kept;
    out[n] = 0;
    return n;
}

size_t bytes_used()
{
    size_t n = 0;
    for (auto &f : files)
        if (f.used)
            n += f.cap;
    return n;
}
} // namespace memfs
