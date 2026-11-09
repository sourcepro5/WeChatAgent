// image_quality.cpp : per-message image quality control for CdnCore::_startDownloadMedia
#define WIN32_LEAN_AND_MEAN
#include <Windows.h>
#include <winternl.h>
#include <atomic>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include "MinHook.h"
#include "image_quality.h"

namespace {
using Fn = int64_t(__fastcall*)(void*, void*);
std::atomic<int> g_default{2};
Fn g_orig = nullptr;
void* g_target = nullptr;
std::atomic<long> g_hits{0};
std::atomic<long> g_mods{0};
std::atomic<bool> g_ready{false};

struct Entry { long localId; int mode; DWORD tick; };
Entry g_entries[64] = {};
SRWLOCK g_lock = SRWLOCK_INIT;

PIMAGE_NT_HEADERS Nt(HMODULE m) { return (PIMAGE_NT_HEADERS)((BYTE*)m + ((PIMAGE_DOS_HEADER)m)->e_lfanew); }
BYTE* FindInSection(HMODULE m, const char* sect, const BYTE* needle, size_t n) {
    PIMAGE_NT_HEADERS nt = Nt(m); PIMAGE_SECTION_HEADER s = IMAGE_FIRST_SECTION(nt);
    for (int i = 0; i < nt->FileHeader.NumberOfSections; ++i, ++s) {
        char name[9] = {0}; memcpy(name, s->Name, 8);
        if (_stricmp(name, sect) != 0) continue;
        BYTE* p = (BYTE*)m + s->VirtualAddress; DWORD sz = s->Misc.VirtualSize;
        for (DWORD o = 0; o + n <= sz; ++o) if (!memcmp(p + o, needle, n)) return p + o;
    }
    return nullptr;
}
BYTE* FindLeaRef(HMODULE m, BYTE* anchor) {
    PIMAGE_NT_HEADERS nt = Nt(m); PIMAGE_SECTION_HEADER s = IMAGE_FIRST_SECTION(nt);
    for (int i = 0; i < nt->FileHeader.NumberOfSections; ++i, ++s) {
        char name[9] = {0}; memcpy(name, s->Name, 8);
        if (_stricmp(name, ".text") != 0) continue;
        BYTE* p = (BYTE*)m + s->VirtualAddress; DWORD sz = s->Misc.VirtualSize;
        for (DWORD o = 0; o + 7 <= sz; ++o) {
            if ((p[o] == 0x48 || p[o] == 0x4c) && p[o + 1] == 0x8d && (p[o + 2] & 0xc7) == 0x05) {
                int32_t d; memcpy(&d, p + o + 3, 4);
                if (p + o + 7 + d == anchor) return p + o;
            }
        }
    }
    return nullptr;
}
BYTE* FuncStart(BYTE* addr) {
    DWORD64 base = 0; PRUNTIME_FUNCTION rf = RtlLookupFunctionEntry((DWORD64)addr, &base, nullptr);
    return rf ? (BYTE*)(base + rf->BeginAddress) : nullptr;
}

// clientid looks like: wxid_xxxx_<timestamp>_<localId>_<seq>
long ParseLocalId(const char* s) {
    if (!s || !*s) return -1;
    const char* end = s + strlen(s);
    const char* p = end;
    int seg = 0;
    while (p > s) {
        --p;
        if (*p == '_') {
            ++seg;
            if (seg == 2) { // start of localId segment
                const char* q = p + 1;
                char buf[32] = {0};
                size_t n = 0;
                while (q < end && *q != '_' && n < sizeof(buf) - 1) buf[n++] = *q++;
                if (*q == '_' || q == end) return atol(buf);
                return -1;
            }
        }
    }
    return -1;
}

void SetMode(long localId, int mode) {
    AcquireSRWLockExclusive(&g_lock);
    DWORD now = GetTickCount();
    int slot = -1;
    for (int i = 0; i < 64; ++i) {
        if (g_entries[i].localId == localId) { slot = i; break; }
        if (slot < 0 && (now - g_entries[i].tick) > 60000) slot = i;
    }
    if (slot < 0) slot = 0;
    g_entries[slot].localId = localId;
    g_entries[slot].mode = mode;
    g_entries[slot].tick = now;
    ReleaseSRWLockExclusive(&g_lock);
}

bool GetMode(long localId, int& mode) {
    AcquireSRWLockShared(&g_lock);
    DWORD now = GetTickCount();
    bool found = false;
    for (int i = 0; i < 64; ++i) {
        if (g_entries[i].localId == localId && (now - g_entries[i].tick) < 30000) {
            mode = g_entries[i].mode; found = true; break;
        }
    }
    ReleaseSRWLockShared(&g_lock);
    return found;
}

void Apply(BYTE* ti) {
    if (!ti) return;
    uint64_t ptr = *(uint64_t*)(ti + 0xB0);
    uint64_t size = *(uint64_t*)(ti + 0xC0);
    uint64_t cap = *(uint64_t*)(ti + 0xC8);
    if (!ptr || size == 0 || size > 500 || cap < 0x10) return;
    char path[512] = {0};
    __try { memcpy(path, (void*)ptr, (size_t)(size < 511 ? size : 511)); }
    __except (EXCEPTION_EXECUTE_HANDLER) { return; }
    char* hit = strstr(path, "_thumb_temp");
    if (hit) {
        // decide quality from clientid (+0x50)
        long localId = -1;
        uint64_t cp = *(uint64_t*)(ti + 0x50), cl = *(uint64_t*)(ti + 0x60), cc = *(uint64_t*)(ti + 0x68);
        if (cp && cl > 0 && cl < 200 && cc >= 0x10) {
            char cid[200] = {0};
            __try { memcpy(cid, (void*)cp, (size_t)cl); } __except (EXCEPTION_EXECUTE_HANDLER) {}
            localId = ParseLocalId(cid);
        }
        int mode = g_default.load();
        if (localId >= 0) {
            int m = 0;
            if (!GetMode(localId, m)) {
                for (int i = 0; i < 60; ++i) { Sleep(50); if (GetMode(localId, m)) break; }
            }
            if (m >= 1 && m <= 3) mode = m;
        }
        if (mode == 3) return;
        size_t base = (size_t)(hit - path);
        char newPath[512] = {0};
        memcpy(newPath, path, base);
        strcpy_s(newPath + base, sizeof(newPath) - base, "_mid_temp");
        size_t newLen = strlen(newPath);
        if (newLen > cap) return;
        __try { memcpy((void*)ptr, newPath, newLen + 1); } __except (EXCEPTION_EXECUTE_HANDLER) { return; }
        *(uint64_t*)(ti + 0xC0) = newLen;
        *(DWORD*)(ti + 0xD0) = (DWORD)mode;
        g_mods.fetch_add(1);
    }
}

int64_t __fastcall Detour(void* self, void* task) {
    g_hits.fetch_add(1);
    __try { Apply((BYTE*)task); } __except (EXCEPTION_EXECUTE_HANDLER) {}
    return g_orig ? g_orig(self, task) : 0;
}
} // namespace

bool ImageQualityStart() {
    if (g_ready.load()) return true;
    HMODULE wx = GetModuleHandleW(L"Weixin.dll");
    if (!wx) return false;
    const char* sym = "mars::cdn::CdnCore::_startDownloadMedia";
    BYTE* anchor = FindInSection(wx, ".rdata", (const BYTE*)sym, strlen(sym));
    if (!anchor) return false;
    BYTE* ref = FindLeaRef(wx, anchor);
    if (!ref) return false;
    BYTE* fn = FuncStart(ref);
    if (!fn) return false;
    g_target = fn;
    if (MH_Initialize() != MH_OK) return false;
    if (MH_CreateHook((LPVOID)fn, (LPVOID)&Detour, (LPVOID*)&g_orig) != MH_OK) return false;
    if (MH_EnableHook((LPVOID)fn) != MH_OK) return false;
    g_ready.store(true);
    return true;
}

void ImageQualitySetMode(int mode) { if (mode < 1) mode = 1; if (mode > 3) mode = 3; g_default.store(mode); }
void ImageQualitySetLocal(long localId, int mode) { if (mode < 1) mode = 1; if (mode > 3) mode = 3; SetMode(localId, mode); }
int ImageQualityMode() { return g_default.load(); }
long ImageQualityHits() { return g_hits.load(); }
long ImageQualityMods() { return g_mods.load(); }
