#define WIN32_LEAN_AND_MEAN
#include <Windows.h>
#include <array>
#include <chrono>
#include <mutex>
#include <vector>
#include <string>
#include "MinHook.h"
#include "json.hpp"
#include "sticker_sender.h"
namespace WeChatAgentSticker {
namespace {
using DispatchCall=uintptr_t(*)(uintptr_t,uintptr_t,uintptr_t,bool);
DispatchCall original=nullptr;
std::mutex traceMutex;
std::string target;
ULONGLONG expires=0;
std::vector<nlohmann::json> rows;
struct Snapshot {
    uintptr_t vtable=0; unsigned type=0,subtype=0,infoType=0;
    bool emoji=false,hasInfo=false,hasSecondary=false; char md5[33]{};
    std::array<size_t,11> lengths{};
    std::array<unsigned,11> categories{};
    std::array<uint64_t,8> baseFields{};
};
// This bounded, target-specific diagnostic records layout metadata only. It
// never copies text, URLs, AES keys, usernames or resource contents to output.
bool Inspect(uintptr_t body,const char* receiver,size_t receiverSize,uintptr_t base,Snapshot* out) {
    __try {
        auto length=*reinterpret_cast<size_t*>(body+0xC0);
        auto cap=*reinterpret_cast<size_t*>(body+0xC8);
        auto value=cap<16?reinterpret_cast<const char*>(body+0xB0):*reinterpret_cast<const char**>(body+0xB0);
        if(length!=receiverSize || memcmp(value,receiver,length))return false;
        out->vtable=*reinterpret_cast<uintptr_t*>(body)-base;
        out->type=*reinterpret_cast<unsigned*>(body+0xD8);
        out->subtype=*reinterpret_cast<unsigned*>(body+0xDC);
        const uintptr_t offsets[]={0x98,0xA0,0xF0,0x118,0x178,0x188,0x6B8,0x728};
        for(size_t i=0;i<8;i++)out->baseFields[i]=i==7?(*reinterpret_cast<uint64_t*>(body+offsets[i])!=0):*reinterpret_cast<uint64_t*>(body+offsets[i]);
        out->emoji=out->vtable==EmojiVtable;
        if(!out->emoji)return true;
        auto info=*reinterpret_cast<uintptr_t*>(body+0x708);
        out->hasInfo=info!=0;
        out->hasSecondary=*reinterpret_cast<uintptr_t*>(body+0x718)!=0;
        if(!info)return true;
        out->infoType=*reinterpret_cast<unsigned*>(info+8);
        for(size_t i=0;i<11;i++) {
            auto offset=i<10?0x10+i*0x20:0x160;
            auto size=*reinterpret_cast<size_t*>(info+offset+0x10);
            auto capacity=*reinterpret_cast<size_t*>(info+offset+0x18);
            auto bytes=capacity<16?reinterpret_cast<const char*>(info+offset):*reinterpret_cast<const char**>(info+offset);
            out->lengths[i]=size;
            if(!size)continue;
            if(size>32768){out->categories[i]=9;continue;}
            bool hex=true;
            for(size_t j=0;j<size;j++)if(!((bytes[j]>='0'&&bytes[j]<='9')||(bytes[j]>='a'&&bytes[j]<='f'))) {hex=false;break;}
            out->categories[i]=hex?1:(size>=4&&memcmp(bytes,"http",4)==0)?2:(size>2&&bytes[1]==':')?3:4;
            if(i==0&&size==32&&hex)memcpy(out->md5,bytes,32);
        }
        return true;
    } __except(EXCEPTION_EXECUTE_HANDLER) {return false;}
}
uintptr_t SingleBody(uintptr_t vector) {
    __try {auto begin=*reinterpret_cast<uintptr_t*>(vector);auto end=*reinterpret_cast<uintptr_t*>(vector+8);return end-begin==16?*reinterpret_cast<uintptr_t*>(begin):0;}
    __except(EXCEPTION_EXECUTE_HANDLER) {return 0;}
}
void Observe(uintptr_t vector) {
    std::string selected;
    {std::lock_guard<std::mutex> lock(traceMutex);if(GetTickCount64()>expires||target.empty())return;selected=target;}
    auto base=reinterpret_cast<uintptr_t>(GetModuleHandleW(L"Weixin.dll"));
    Snapshot snapshot;
    auto body=SingleBody(vector);if(!body)return;
    if(!Inspect(body,selected.data(),selected.size(),base,&snapshot))return;
    nlohmann::json row={{"tick",GetTickCount64()},{"vtableRva",snapshot.vtable},{"type",snapshot.type},{"subtype",snapshot.subtype},{"emojiClass",snapshot.emoji},{"hasInfo",snapshot.hasInfo},{"hasSecondary",snapshot.hasSecondary}};
    row["baseFields"]=snapshot.baseFields;
    if(snapshot.hasInfo){row["infoType"]=snapshot.infoType;row["md5"]=snapshot.md5;row["fieldLengths"]=snapshot.lengths;row["fieldCategories"]=snapshot.categories;}
    std::lock_guard<std::mutex> lock(traceMutex);
    if(target!=selected||GetTickCount64()>expires)return;
    if(rows.size()>=20)rows.erase(rows.begin());rows.push_back(std::move(row));
}
uintptr_t TracedDispatch(uintptr_t context,uintptr_t out,uintptr_t vector,bool flag) {
    try {Observe(vector);}catch(...){}
    return original(context,out,vector,flag);
}
}
bool StartTrace(const std::string& selected) {
    std::lock_guard<std::mutex> lock(traceMutex);
    if(selected.empty()){target.clear();expires=0;return true;}
    if(!original){
        auto base=reinterpret_cast<uintptr_t>(GetModuleHandleW(L"Weixin.dll"));
        if(!base)return false;
        auto status=MH_Initialize();if(status!=MH_OK&&status!=MH_ERROR_ALREADY_INITIALIZED)return false;
        auto address=reinterpret_cast<void*>(base+Dispatch);
        if(MH_CreateHook(address,reinterpret_cast<void*>(TracedDispatch),reinterpret_cast<void**>(&original))!=MH_OK)return false;
        if(MH_EnableHook(address)!=MH_OK){MH_RemoveHook(address);original=nullptr;return false;}
    }
    target=selected;expires=GetTickCount64()+5*60*1000;rows.clear();return true;
}
std::string TraceJson() {std::lock_guard<std::mutex> lock(traceMutex);return nlohmann::json({{"active",!target.empty()&&GetTickCount64()<=expires},{"rows",rows}}).dump();}
}
