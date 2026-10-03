// Chompfe shim: FatFs types so the unmodified WavetableManager.h compiles.
// There is no SD card; tables are copied into memory from JS (see chompfe.cpp).
#pragma once
#include <cstdint>

typedef unsigned int UINT;
typedef int FRESULT;
static const FRESULT FR_OK = 0;
static const FRESULT FR_NO_FILESYSTEM = 13;

struct FATFS {};
struct FIL {};
struct DIR {};
struct FILINFO
{
    char fname[256];
};

inline FRESULT f_opendir(DIR *, const char *) { return FR_NO_FILESYSTEM; }
inline FRESULT f_readdir(DIR *, FILINFO *) { return FR_NO_FILESYSTEM; }
inline FRESULT f_closedir(DIR *) { return FR_OK; }
