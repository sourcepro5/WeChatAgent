// Regression host only: never named Weixin.exe and never calls sender APIs.
#define WIN32_LEAN_AND_MEAN
#include <Windows.h>
#include <cstdio>

static DWORD WINAPI SmallThread(void*) { return 0; }

int wmain(int argc,wchar_t** argv) {
    SetErrorMode(SEM_FAILCRITICALERRORS|SEM_NOGPFAULTERRORBOX);
    if(argc!=2)return 2;
    if(!LoadLibraryW(argv[1]))return 3;
    for(unsigned i=0;i<32;++i){
        HANDLE thread=CreateThread(nullptr,65536,SmallThread,nullptr,STACK_SIZE_PARAM_IS_A_RESERVATION,nullptr);
        if(!thread)return 4;
        if(WaitForSingleObject(thread,5000)!=WAIT_OBJECT_0)return 5;
        DWORD code=1;if(!GetExitCodeThread(thread,&code)||code)return 6;
        CloseHandle(thread);
    }
    std::puts("{\"threads\":32,\"stackReserve\":65536,\"sendCalls\":0}");
    // Let the process tear the DLL down; do not unload a background worker.
    return 0;
}
