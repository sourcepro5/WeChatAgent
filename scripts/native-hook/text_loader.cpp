// Explicit local backend loader. Does not start/stop WeChat or interact with its windows.
#define WIN32_LEAN_AND_MEAN
#include <Windows.h>
#include <TlHelp32.h>
#include <cstdint>
#include <filesystem>
#include <iostream>
#include <set>
#include <string>
#include <vector>

static constexpr auto LibraryName=L"wechatagent-text-4.1.15.13.dll";
struct Module{uintptr_t base;std::wstring name,path;};
static std::vector<Module> Modules(DWORD pid){
    std::vector<Module> rows;HANDLE snapshot=CreateToolhelp32Snapshot(TH32CS_SNAPMODULE|TH32CS_SNAPMODULE32,pid);
    if(snapshot==INVALID_HANDLE_VALUE)return rows;
    MODULEENTRY32W item{};item.dwSize=sizeof(item);
    if(Module32FirstW(snapshot,&item))do{rows.push_back({reinterpret_cast<uintptr_t>(item.modBaseAddr),item.szModule,item.szExePath});}while(Module32NextW(snapshot,&item));
    CloseHandle(snapshot);return rows;
}
static DWORD FindProcess(){
    struct Row{DWORD id,parent;};std::vector<Row> rows;std::set<DWORD> ids;
    HANDLE snapshot=CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS,0);PROCESSENTRY32W row{};row.dwSize=sizeof(row);
    if(Process32FirstW(snapshot,&row))do{if(!_wcsicmp(row.szExeFile,L"Weixin.exe")){rows.push_back({row.th32ProcessID,row.th32ParentProcessID});ids.insert(row.th32ProcessID);}}while(Process32NextW(snapshot,&row));
    CloseHandle(snapshot);std::vector<DWORD> candidates;
    for(const auto& item:rows)if(!ids.count(item.parent)){
        for(const auto& module:Modules(item.id))if(!_wcsicmp(module.name.c_str(),L"Weixin.dll"))candidates.push_back(item.id);
    }
    return candidates.size()==1?candidates.front():0;
}
int wmain(int argc,wchar_t** argv){
    DWORD pid=argc==2?wcstoul(argv[1],nullptr,10):FindProcess();
    if(!pid){std::cout<<"{\"loaded\":false,\"error\":\"No unique running WeChat main process\"}";return 2;}
    wchar_t ownPath[32768]{};GetModuleFileNameW(nullptr,ownPath,32768);
    const auto dll=std::filesystem::path(ownPath).parent_path()/LibraryName;
    if(!std::filesystem::is_regular_file(dll)){std::cout<<"{\"loaded\":false,\"error\":\"Backend DLL missing\"}";return 3;}
    auto modules=Modules(pid);bool hasCore=false;
    for(const auto& module:modules){
        if(!_wcsicmp(module.name.c_str(),LibraryName)){std::cout<<"{\"loaded\":true,\"alreadyLoaded\":true,\"pid\":"<<pid<<"}";return 0;}
        if(!_wcsicmp(module.name.c_str(),L"Weixin.dll"))hasCore=true;
    }
    if(!hasCore)return 4;
    HANDLE process=OpenProcess(PROCESS_QUERY_INFORMATION|PROCESS_CREATE_THREAD|PROCESS_VM_OPERATION|PROCESS_VM_WRITE|PROCESS_VM_READ|SYNCHRONIZE,FALSE,pid);
    if(!process){std::cout<<"{\"loaded\":false,\"error\":\"Cannot open current WeChat process\"}";return 5;}
    wchar_t processPath[32768]{};DWORD n=32768;
    if(!QueryFullProcessImageNameW(process,0,processPath,&n)||_wcsicmp(std::filesystem::path(processPath).filename().c_str(),L"Weixin.exe")){CloseHandle(process);return 6;}
    auto load=GetProcAddress(GetModuleHandleW(L"kernel32.dll"),"LoadLibraryW");HMODULE owner=nullptr;
    GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS|GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,reinterpret_cast<LPCWSTR>(load),&owner);
    wchar_t ownerPath[32768]{};GetModuleFileNameW(owner,ownerPath,32768);
    auto ownerName=std::filesystem::path(ownerPath).filename().wstring();uintptr_t remoteBase=0;
    for(const auto& module:modules)if(!_wcsicmp(module.name.c_str(),ownerName.c_str()))remoteBase=module.base;
    if(!remoteBase){CloseHandle(process);return 7;}
    const auto remoteLoad=remoteBase+(reinterpret_cast<uintptr_t>(load)-reinterpret_cast<uintptr_t>(owner));
    const auto text=dll.wstring();size_t bytes=(text.size()+1)*sizeof(wchar_t);
    void* argument=VirtualAllocEx(process,nullptr,bytes,MEM_COMMIT|MEM_RESERVE,PAGE_READWRITE);
    if(!argument||!WriteProcessMemory(process,argument,text.c_str(),bytes,nullptr)){CloseHandle(process);return 8;}
    HANDLE thread=CreateRemoteThread(process,nullptr,0,reinterpret_cast<LPTHREAD_START_ROUTINE>(remoteLoad),argument,0,nullptr);
    if(!thread){VirtualFreeEx(process,argument,0,MEM_RELEASE);CloseHandle(process);return 9;}
    DWORD waited=WaitForSingleObject(thread,10000),result=0;
    if(waited==WAIT_OBJECT_0){GetExitCodeThread(thread,&result);VirtualFreeEx(process,argument,0,MEM_RELEASE);}
    CloseHandle(thread);CloseHandle(process);
    std::cout<<"{\"pid\":"<<pid<<",\"loaded\":"<<(waited==WAIT_OBJECT_0&&result?"true":"false")<<",\"sendCalls\":0}";
    return waited==WAIT_OBJECT_0&&result?0:10;
}

