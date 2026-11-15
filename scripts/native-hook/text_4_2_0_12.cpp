// Native message APIs for the exact 4.2.0.12 x64 profile.
// No UIA, input simulation, desktop hooks or window activation.
#define WIN32_LEAN_AND_MEAN
#include <Windows.h>
#include <winternl.h>
#include <bcrypt.h>
#include <wincrypt.h>
#include <array>
#include <atomic>
#include <cstring>
#include <cwctype>
#include <filesystem>
#include <fstream>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <vector>
#include <regex>
#include "text_profile_4_2_0_12.h"
#include "httplib.h"
#include "json.hpp"

using json=nlohmann::json;
namespace {
using namespace WeChatAgentText42012;
std::filesystem::path ConfigFile;
uintptr_t base=0;std::mutex sendMutex;std::atomic<bool> probeReady{false},faulted{false};
std::atomic<unsigned> phase{0};
std::atomic<uintptr_t> actualMessageTable{0},receiverLength{0},receiverCapacity{0},contentLength{0},contentCapacity{0};
std::string nativeCppError;
using Allocate=void*(__fastcall*)(size_t);
using Free=void(__fastcall*)(void*,size_t);
using Constructor=uintptr_t(__fastcall*)(void*);
using Factory=uintptr_t(__fastcall*)(void*,void*,void*,void*,void*,uintptr_t);
using Send=uintptr_t(__fastcall*)(void*,void*);

HANDLE StackLog=INVALID_HANDLE_VALUE;volatile LONG StackRecorded=0;uintptr_t OwnModule=0;
void Number(char*& out,unsigned long long value){char reverse[32];unsigned n=0;do{reverse[n++]=char('0'+value%10);value/=10;}while(value);while(n)*out++=reverse[--n];}
void Label(char*& out,const char* value){while(*value)*out++=*value++;}
LONG CALLBACK StackFailure(EXCEPTION_POINTERS* info){
    if(info->ExceptionRecord->ExceptionCode!=EXCEPTION_STACK_OVERFLOW||StackLog==INVALID_HANDLE_VALUE||InterlockedCompareExchange(&StackRecorded,1,0))return EXCEPTION_CONTINUE_SEARCH;
    char buffer[256];char* out=buffer;Label(out,"{\"requestedStackBytes\":");Number(out,info->ContextRecord->Rax);
    const auto caller=*reinterpret_cast<uintptr_t*>(info->ContextRecord->Rsp+16);
    Label(out,",\"callerRva\":");Number(out,caller>=OwnModule?caller-OwnModule:0);
    Label(out,",\"threadId\":");Number(out,GetCurrentThreadId());Label(out,"}\n");DWORD written=0;WriteFile(StackLog,buffer,DWORD(out-buffer),&written,nullptr);
    return EXCEPTION_CONTINUE_SEARCH;
}
void StackState(const char* stage){
    ULONG guarantee=65536;SetThreadStackGuarantee(&guarantee);char marker;MEMORY_BASIC_INFORMATION memory{};VirtualQuery(&marker,&memory,sizeof(memory));
    auto* tib=reinterpret_cast<NT_TIB*>(NtCurrentTeb());const auto reserve=reinterpret_cast<uintptr_t>(tib->StackBase)-reinterpret_cast<uintptr_t>(memory.AllocationBase);
    std::ofstream file(ConfigFile.parent_path()/L"thread-stack.jsonl",std::ios::app);if(file)file<<json({{"stage",stage},{"threadId",GetCurrentThreadId()},{"reserveBytes",reserve}}).dump()<<'\n';
}
class ObservedPool:public httplib::ThreadPool{
public:ObservedPool():ThreadPool(2){}
    void enqueue(std::function<void()> fn)override{ThreadPool::enqueue([work=std::move(fn)](){StackState("http-worker");work();});}
};
json Config(){std::ifstream file(ConfigFile);if(!file)throw std::runtime_error("native config missing");return json::parse(file);}
void Event(const char* name){
    std::ofstream f(ConfigFile.parent_path()/L"native-backend-events.jsonl",std::ios::app);
    if(f)f<<json({{"event",name},{"pid",GetCurrentProcessId()},{"phase",phase.load()},{"tick",GetTickCount64()}}).dump()<<'\n';
}
std::string Utf8(const std::wstring& text){
    int n=WideCharToMultiByte(CP_UTF8,0,text.data(),static_cast<int>(text.size()),nullptr,0,nullptr,nullptr);
    std::string out(n,'\0');if(n)WideCharToMultiByte(CP_UTF8,0,text.data(),static_cast<int>(text.size()),out.data(),n,nullptr,nullptr);return out;
}
std::string Version(){
    std::vector<wchar_t> path(32768);GetModuleFileNameW(reinterpret_cast<HMODULE>(base),path.data(),static_cast<DWORD>(path.size()));
    DWORD ignored=0,size=GetFileVersionInfoSizeW(path.data(),&ignored);if(!size)return "";
    std::vector<BYTE> data(size);if(!GetFileVersionInfoW(path.data(),0,size,data.data()))return "";
    VS_FIXEDFILEINFO* info=nullptr;UINT length=0;if(!VerQueryValueW(data.data(),L"\\",reinterpret_cast<void**>(&info),&length)||!info)return "";
    return std::to_string(HIWORD(info->dwFileVersionMS))+"."+std::to_string(LOWORD(info->dwFileVersionMS))+"."+
      std::to_string(HIWORD(info->dwFileVersionLS))+"."+std::to_string(LOWORD(info->dwFileVersionLS));
}
bool ProfileMatches(){
    if(!base||Version()!="4.2.0.12")return false;
    auto* dos=reinterpret_cast<IMAGE_DOS_HEADER*>(base);
    auto* pe=reinterpret_cast<IMAGE_NT_HEADERS64*>(base+dos->e_lfanew);
    if(pe->OptionalHeader.SizeOfImage!=ImageSize)return false;
    const BYTE entry[]={0x55,0x41,0x56,0x56,0x57,0x53,0x48,0x81,0xec,0xe0,1,0,0};
    if(memcmp(reinterpret_cast<void*>(base+SendRva),entry,sizeof(entry)))return false;
    if(*reinterpret_cast<uintptr_t*>(base+SenderTable+16)!=base+SendRva)return false;
    const uintptr_t code[]={SendRva,TextCtorRva,ImageCtorRva,StickerFactoryRva,FactoryRva,AllocateRva,FreeRva};
    for(auto rva:code){MEMORY_BASIC_INFORMATION m{};
        if(!VirtualQuery(reinterpret_cast<void*>(base+rva),&m,sizeof(m))||m.State!=MEM_COMMIT||
          !(m.Protect&(PAGE_EXECUTE|PAGE_EXECUTE_READ|PAGE_EXECUTE_READWRITE|PAGE_EXECUTE_WRITECOPY)))return false;
    }
    const BYTE stickerEntry[]={0x55,0x56,0x57,0x48,0x83,0xec,0x30};
    if(memcmp(reinterpret_cast<void*>(base+StickerFactoryRva),stickerEntry,sizeof(stickerEntry)))return false;
    if(*reinterpret_cast<uintptr_t*>(base+StickerMessageTable+8)!=base+0x78db40||
       *reinterpret_cast<uintptr_t*>(base+StickerMessageTable+16)!=base+0x78db50)return false;
    return true;
}
// Account metadata only, obtained from handles already open in this WeChat process.
struct HandleEntry{HANDLE value;ULONG_PTR handleCount,pointerCount;ULONG access,type,attributes,reserved;};
struct HandleSnapshot{ULONG_PTR count,reserved;HandleEntry entries[1];};
std::set<std::string> Accounts(){
    using Query=NTSTATUS(NTAPI*)(HANDLE,ULONG,PVOID,ULONG,PULONG);
    auto query=reinterpret_cast<Query>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"),"NtQueryInformationProcess"));
    if(!query)return {};
    std::vector<BYTE> buffer(65536);ULONG required=0;
    auto status=query(GetCurrentProcess(),51,buffer.data(),static_cast<ULONG>(buffer.size()),&required);
    if(status<0&&required>buffer.size()&&required<16*1024*1024){buffer.resize(required+4096);status=query(GetCurrentProcess(),51,buffer.data(),static_cast<ULONG>(buffer.size()),&required);}
    if(status<0)return {};
    auto* snapshot=reinterpret_cast<HandleSnapshot*>(buffer.data());
    if(snapshot->count>(buffer.size()-2*sizeof(ULONG_PTR))/sizeof(HandleEntry))return {};
    std::set<std::string> accounts;
    std::vector<wchar_t> name(32768);
    for(ULONG_PTR i=0;i<snapshot->count;++i){
        auto file=snapshot->entries[i].value;if(GetFileType(file)!=FILE_TYPE_DISK)continue;
        DWORD n=GetFinalPathNameByHandleW(file,name.data(),static_cast<DWORD>(name.size()),FILE_NAME_NORMALIZED);if(!n||n>=name.size())continue;
        std::wstring path(name.data(),n);for(auto& ch:path){if(ch==L'/')ch=L'\\';ch=towlower(ch);}
        auto at=path.find(L"\\db_storage\\");if(at==std::wstring::npos)continue;
        auto previous=path.rfind(L'\\',at-1);if(previous!=std::wstring::npos)accounts.insert(Utf8(path.substr(previous+1,at-previous-1)));
    }
    return accounts;
}
void* New(size_t size){auto* p=reinterpret_cast<Allocate>(base+AllocateRva)(size);if(!p)throw std::bad_alloc();memset(p,0,size);return p;}
void Delete(void* p,size_t size){if(p)reinterpret_cast<Free>(base+FreeRva)(p,size);}
uintptr_t& Word(void* p,size_t offset){return *reinterpret_cast<uintptr_t*>(static_cast<BYTE*>(p)+offset);}
void ReleaseShared(uintptr_t control){
    if(!control)return;
    auto* counts=reinterpret_cast<volatile LONG*>(control+8);
    if(InterlockedDecrement(counts)==0){
        auto* table=*reinterpret_cast<uintptr_t**>(control);reinterpret_cast<void(__fastcall*)(void*)>(table[0])(reinterpret_cast<void*>(control));
        if(InterlockedDecrement(counts+1)==0)reinterpret_cast<void(__fastcall*)(void*)>(table[1])(reinterpret_cast<void*>(control));
    }
}
void SetString(void* where,const std::string& value){
    if(Word(where,16)!=0||Word(where,24)!=15)throw std::runtime_error("native string was not empty");
    Word(where,16)=value.size();
    if(value.size()<16){memcpy(where,value.data(),value.size());static_cast<char*>(where)[value.size()]=0;return;}
    const size_t capacity=value.size()|15;void* buffer;
    if(capacity+1>=4096){
        void* original=New(capacity+40);buffer=reinterpret_cast<void*>((reinterpret_cast<uintptr_t>(original)+39)&~uintptr_t(31));
        reinterpret_cast<void**>(buffer)[-1]=original;
    }else buffer=New(capacity+1);
    memcpy(buffer,value.data(),value.size());static_cast<char*>(buffer)[value.size()]=0;
    Word(where,0)=reinterpret_cast<uintptr_t>(buffer);Word(where,24)=capacity;
}
void SetWideString(void* where,const std::wstring& value){
    if(Word(where,16)!=0||Word(where,24)!=7)throw std::runtime_error("native wide string was not empty");
    Word(where,16)=value.size();
    if(value.size()<8){memcpy(where,value.c_str(),(value.size()+1)*sizeof(wchar_t));return;}
    const size_t capacity=value.size()|7,bytes=(capacity+1)*sizeof(wchar_t);void* buffer;
    if(bytes>=4096){void* original=New(bytes+39);buffer=reinterpret_cast<void*>((reinterpret_cast<uintptr_t>(original)+39)&~uintptr_t(31));
        reinterpret_cast<void**>(buffer)[-1]=original;
    }else buffer=New(bytes);
    memcpy(buffer,value.c_str(),(value.size()+1)*sizeof(wchar_t));Word(where,0)=reinterpret_cast<uintptr_t>(buffer);Word(where,24)=capacity;
}
std::filesystem::path CheckedImage(const std::string& value,const std::filesystem::path& root){
    if(root.empty()||!root.is_absolute()||value.empty()||value.size()>32768||value.find('\0')!=std::string::npos)throw std::runtime_error("invalid image path/root");
    const auto candidate=std::filesystem::u8path(value);if(!candidate.is_absolute())throw std::runtime_error("absolute image path required");
    const auto file=std::filesystem::weakly_canonical(candidate);
    const auto relative=file.lexically_relative(std::filesystem::weakly_canonical(root));
    if(relative.empty()||relative.is_absolute()||*relative.begin()==L".."||!std::filesystem::is_regular_file(file))throw std::runtime_error("image outside configured outgoing directory");
    const auto size=std::filesystem::file_size(file);if(!size||size>32*1024*1024)throw std::runtime_error("invalid image size");
    std::ifstream input(file,std::ios::binary);unsigned char header[12]{};input.read(reinterpret_cast<char*>(header),12);
    const bool png=!memcmp(header,"\x89PNG\r\n\x1a\n",8),jpeg=header[0]==0xff&&header[1]==0xd8&&header[2]==0xff,
      webp=!memcmp(header,"RIFF",4)&&!memcmp(header+8,"WEBP",4);
    if(!png&&!jpeg&&!webp)throw std::runtime_error("only PNG, JPEG and WebP are supported");
    return file;
}
std::filesystem::path CheckedSticker(const std::string& value,const json& fields,const std::filesystem::path& root){
    if(root.empty()||!root.is_absolute()||value.empty()||value.size()>32768||value.find('\0')!=std::string::npos)throw std::runtime_error("invalid sticker path/root");
    const auto candidate=std::filesystem::u8path(value);if(!candidate.is_absolute())throw std::runtime_error("absolute sticker path required");
    const auto file=std::filesystem::weakly_canonical(candidate),relative=file.lexically_relative(std::filesystem::weakly_canonical(root));
    if(relative.empty()||relative.is_absolute()||*relative.begin()==L".."||!std::filesystem::is_regular_file(file)||file.extension()!=L".gif")throw std::runtime_error("sticker outside configured outgoing directory");
    const auto size=std::filesystem::file_size(file);const auto md5=fields.value("md5","");
    if(!size||size>8*1024*1024||!std::regex_match(md5,std::regex("^[a-f0-9]{32}$"))||!fields.contains("len")||!fields["len"].is_number_integer()||fields["len"].get<uint64_t>()!=size)throw std::runtime_error("invalid sticker size/digest");
    std::vector<unsigned char> bytes(static_cast<size_t>(size));std::ifstream input(file,std::ios::binary);
    if(!input.read(reinterpret_cast<char*>(bytes.data()),static_cast<std::streamsize>(bytes.size()))||bytes.size()<6||
       (memcmp(bytes.data(),"GIF87a",6)&&memcmp(bytes.data(),"GIF89a",6)))throw std::runtime_error("GIF bytes required");
    BCRYPT_ALG_HANDLE algorithm=nullptr;BCRYPT_HASH_HANDLE hash=nullptr;std::vector<unsigned char> object;unsigned char digest[16]{};DWORD objectSize=0,got=0;bool ok=false;
    if(BCryptOpenAlgorithmProvider(&algorithm,BCRYPT_MD5_ALGORITHM,nullptr,0)>=0&&
       BCryptGetProperty(algorithm,BCRYPT_OBJECT_LENGTH,reinterpret_cast<PUCHAR>(&objectSize),sizeof(objectSize),&got,0)>=0){
        object.resize(objectSize);
        if(BCryptCreateHash(algorithm,&hash,object.data(),objectSize,nullptr,0,0)>=0&&
           BCryptHashData(hash,bytes.data(),static_cast<ULONG>(bytes.size()),0)>=0&&BCryptFinishHash(hash,digest,sizeof(digest),0)>=0)ok=true;
    }
    if(hash)BCryptDestroyHash(hash);if(algorithm)BCryptCloseAlgorithmProvider(algorithm,0);
    std::string actual;const char* hex="0123456789abcdef";for(auto byte:digest){actual+=hex[byte>>4];actual+=hex[byte&15];}
    if(!ok||actual!=md5)throw std::runtime_error("sticker integrity mismatch");return file;
}
bool ValidTarget(const std::string& value){return !value.empty()&&value.size()<=256&&value.find('\0')==std::string::npos;}
std::string MentionList(const json& values){
    if(!values.is_array()||values.empty()||values.size()>8)throw std::runtime_error("expected 1-8 member IDs");
    std::string ids;std::set<std::string> seen;
    for(const auto& value:values){
        if(!value.is_string())throw std::runtime_error("invalid member ID");const auto id=value.get<std::string>();
        if(id.empty()||id.size()>128||id.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")!=std::string::npos)throw std::runtime_error("invalid member ID");
        if(seen.insert(id).second){if(!ids.empty())ids+=",";ids+=id;}
    }return ids;
}
struct Prepared{
    void* sender=nullptr;void* params=nullptr;void* owner=nullptr;bool senderOwnsMessage=false;
    ~Prepared(){
        if(sender&&senderOwnsMessage){auto* table=*reinterpret_cast<uintptr_t**>(sender);
            reinterpret_cast<void(__fastcall*)(void*,bool)>(table[4])(sender,true);
        }else if(owner)ReleaseShared(reinterpret_cast<uintptr_t>(owner));
        if(params){
            for(size_t offset:{size_t(0x10),size_t(0x50),size_t(0x90)}){
                auto object=Word(params,offset+0x38);if(!object)continue;
                auto* table=*reinterpret_cast<uintptr_t**>(object);
                reinterpret_cast<void(__fastcall*)(void*,bool)>(table[4])(reinterpret_cast<void*>(object),object!=reinterpret_cast<uintptr_t>(params)+offset);
            }
            ReleaseShared(Word(params,8));Delete(params,0xe8);
        }
    }
    void Build(const std::string& target,const std::string& text,bool image=false,uint64_t bytes=0,const std::string& atList=""){
        phase=1;owner=New(image?0x900:0x800);Word(owner,0)=base+(image?ImageOwnerTable:OwnerTable);Word(owner,8)=0x100000001;
        void* message=static_cast<BYTE*>(owner)+16;
        reinterpret_cast<Constructor>(base+(image?ImageCtorRva:TextCtorRva))(message);phase=2;
        actualMessageTable=Word(message,0)-base;receiverLength=Word(message,0xc0);receiverCapacity=Word(message,0xc8);
        contentLength=Word(message,0x768);contentCapacity=Word(message,0x770);
        if(Word(message,0)!=base+(image?ImageMessageTable:MessageTable))throw std::runtime_error("native message type mismatch");
        SetString(static_cast<BYTE*>(message)+0xb0,target);
        if(image){const auto file=std::filesystem::u8path(text);SetWideString(static_cast<BYTE*>(message)+0x120,file.wstring());
            SetString(static_cast<BYTE*>(message)+0x1a8,file.filename().u8string());Word(message,0x118)=3;Word(message,0x1c8)=bytes;
        }else{
            SetString(static_cast<BYTE*>(message)+0x758,text);Word(message,0x118)=1;Word(message,0x1c8)=text.size();
            // Reflection in this exact core: +0x758=text_content, +0x778=at_user_list.
            // Preserve the constructor's native string ownership, including long ID lists.
            if(!atList.empty())SetString(static_cast<BYTE*>(message)+0x778,atList);
        }
        BuildSender(message);
    }
    void BuildSticker(const std::string& target,const std::string& file,uint64_t bytes){
        struct SharedMessage{uintptr_t body=0,control=0;};SharedMessage shared;
        using Create=SharedMessage*(__fastcall*)(SharedMessage*);phase=1;
        reinterpret_cast<Create>(base+StickerFactoryRva)(&shared);owner=reinterpret_cast<void*>(shared.control);
        if(!owner||shared.body!=shared.control+16||Word(owner,0)!=base+StickerOwnerTable||
           *reinterpret_cast<uintptr_t*>(shared.body)!=base+StickerMessageTable)throw std::runtime_error("native sticker class mismatch");
        auto* message=reinterpret_cast<BYTE*>(shared.body);phase=2;
        SetString(message+0xb0,target);const auto path=std::filesystem::u8path(file);
        SetWideString(message+0x120,path.wstring());SetString(message+0x1a8,path.filename().u8string());
        Word(message,0x118)=(uint64_t(8)<<32)|49;Word(message,0x1c8)=bytes;
        BuildSender(message);
    }
    void BuildSender(void* message){
        void* vector=New(0x20);Word(vector,0)=reinterpret_cast<uintptr_t>(message);Word(vector,8)=reinterpret_cast<uintptr_t>(owner);
        sender=New(0x28);Word(sender,0)=base+SenderTable;Word(sender,8)=reinterpret_cast<uintptr_t>(vector);
        Word(sender,16)=reinterpret_cast<uintptr_t>(vector)+16;Word(sender,24)=reinterpret_cast<uintptr_t>(vector)+16;Word(sender,32)=1;
        senderOwnsMessage=true;phase=3;
        // Valid MSVC std::function objects, with no UI owners or captured QObject lifetimes.
        // Native callbacks return void; extra Win64 register arguments are not consumed.
        static_assert(sizeof(std::function<void()>)==64,"std::function ABI differs");
        std::function<void()> first=[](){},second=[](){},third=[](){};
        uintptr_t shared[2]{};params=New(0xe8);
        reinterpret_cast<Factory>(base+FactoryRva)(params,&first,&second,&third,shared,1);
        if(!Word(params,0x48)||!Word(params,0x88)||!Word(params,0xc8)||Word(params,0xd0)!=1)
            throw std::runtime_error("native callback layout mismatch");
        phase=4;
    }
};
void Probe(){
    {Prepared p;p.Build("filehelper","native construction probe");}
    {Prepared p;p.Build("filehelper","native image construction probe.png",true,1);}
    {Prepared p;p.BuildSticker("filehelper","native sticker construction probe.gif",1);}
    {Prepared p;p.Build("native_probe@chatroom","native mention construction",false,0,"wxid_native_probe");}
}
void Submit(const std::string& target,const std::string& text){Prepared p;p.Build(target,text);phase=5;
    reinterpret_cast<Send>(base+SendRva)(p.sender,p.params);phase=6;}
void ProbeCatching(){nativeCppError.clear();try{Probe();}catch(const std::exception& e){nativeCppError=e.what();}}
void SubmitCatching(const std::string& target,const std::string& text){nativeCppError.clear();try{Submit(target,text);}catch(const std::exception& e){nativeCppError=e.what();}}
// SEH only wraps a primitive call boundary. It is not used to continue a failed native operation.
DWORD GuardProbe(){__try{ProbeCatching();return 0;}__except(EXCEPTION_EXECUTE_HANDLER){return GetExceptionCode();}}
DWORD GuardSubmit(const std::string* target,const std::string* text){__try{SubmitCatching(*target,*text);return 0;}__except(EXCEPTION_EXECUTE_HANDLER){return GetExceptionCode();}}
void ImageCatching(const std::string& target,const std::string& file,uint64_t bytes){nativeCppError.clear();try{
    Prepared p;p.Build(target,file,true,bytes);phase=5;reinterpret_cast<Send>(base+SendRva)(p.sender,p.params);phase=6;
}catch(const std::exception& e){nativeCppError=e.what();}}
DWORD GuardImage(const std::string* target,const std::string* file,uint64_t bytes){__try{ImageCatching(*target,*file,bytes);return 0;}__except(EXCEPTION_EXECUTE_HANDLER){return GetExceptionCode();}}
void MentionCatching(const std::string& target,const std::string& text,const std::string& ids){nativeCppError.clear();try{
    Prepared p;p.Build(target,text,false,0,ids);phase=5;reinterpret_cast<Send>(base+SendRva)(p.sender,p.params);phase=6;
}catch(const std::exception& e){nativeCppError=e.what();}}
DWORD GuardMention(const std::string* target,const std::string* text,const std::string* ids){__try{MentionCatching(*target,*text,*ids);return 0;}__except(EXCEPTION_EXECUTE_HANDLER){return GetExceptionCode();}}

void StickerCatching(const std::string& target,const std::string& file,uint64_t bytes){nativeCppError.clear();try{
    Prepared p;p.BuildSticker(target,file,bytes);phase=5;reinterpret_cast<Send>(base+SendRva)(p.sender,p.params);phase=6;
}catch(const std::exception& e){nativeCppError=e.what();}}
DWORD GuardSticker(const std::string* target,const std::string* file,uint64_t bytes){__try{StickerCatching(*target,*file,bytes);return 0;}__except(EXCEPTION_EXECUTE_HANDLER){return GetExceptionCode();}}

constexpr size_t MaxVoiceBytes=2*1024*1024;
constexpr size_t MaxVoiceBody=4*((MaxVoiceBytes+2)/3)+1024;
constexpr char VoiceProtocol[]="silk-receipt-v1";
enum class VoiceState { Queued, Running, Accepted, Rejected, Uncertain };
using VoiceDigest=std::array<unsigned char,32>;

struct VoiceOperation {
    std::string id,accountDirectory,accountWxid,target;
    uint32_t duration=0;
    VoiceDigest digest{};
    ULONGLONG created=GetTickCount64();
    std::atomic<VoiceState> state{VoiceState::Queued};
};

std::atomic<bool> voiceFaulted{false};

bool VoiceProfileMatches() {
    auto* dos=reinterpret_cast<const IMAGE_DOS_HEADER*>(base);
    auto* pe=reinterpret_cast<const IMAGE_NT_HEADERS64*>(base+dos->e_lfanew);
    if(pe->FileHeader.TimeDateStamp!=VoiceCoreTimestamp)return false;
    for(auto rva:{VoiceAppRva,VoiceSchedulerRva,VoiceEnqueueRva,VoiceContextRva,VoiceProviderRva,VoiceManagerRva,VoiceFactoryRva,VoiceSendRva}){
        MEMORY_BASIC_INFORMATION page{};
        if(!VirtualQuery(reinterpret_cast<void*>(base+rva),&page,sizeof(page))||
           page.AllocationBase!=reinterpret_cast<void*>(base)||page.State!=MEM_COMMIT||
           !(page.Protect&(PAGE_EXECUTE|PAGE_EXECUTE_READ|PAGE_EXECUTE_READWRITE|PAGE_EXECUTE_WRITECOPY)))return false;
    }
    std::wstring modulePath(32768,L'\0');
    const auto length=GetModuleFileNameW(reinterpret_cast<HMODULE>(base),modulePath.data(),static_cast<DWORD>(modulePath.size()));
    if(!length||length>=modulePath.size())return false;
    modulePath.resize(length);
    std::ifstream input(modulePath.c_str(),std::ios::binary|std::ios::ate);
    if(!input||input.tellg()!=static_cast<std::streamoff>(VoiceCoreFileSize))return false;
    input.seekg(0);
    std::vector<unsigned char> block(1024*1024);
    BCRYPT_ALG_HANDLE algorithm=nullptr;
    BCRYPT_HASH_HANDLE hash=nullptr;
    if(BCryptOpenAlgorithmProvider(&algorithm,BCRYPT_SHA256_ALGORITHM,nullptr,0)<0)return false;
    bool valid=BCryptCreateHash(algorithm,&hash,nullptr,0,nullptr,0,0)>=0;
    uint64_t total=0;
    while(valid&&input.read(reinterpret_cast<char*>(block.data()),block.size()).gcount()>0){
        const auto count=static_cast<ULONG>(input.gcount());
        total+=count;
        valid=total<=VoiceCoreFileSize&&BCryptHashData(hash,block.data(),count,0)>=0;
    }
    VoiceDigest digest{};
    valid=valid&&input.eof()&&!input.bad()&&total==VoiceCoreFileSize&&
          BCryptFinishHash(hash,digest.data(),static_cast<ULONG>(digest.size()),0)>=0&&
          !memcmp(digest.data(),VoiceCoreSha256,digest.size());
    if(hash)BCryptDestroyHash(hash);
    BCryptCloseAlgorithmProvider(algorithm,0);
    return valid;
}

bool VoiceOperationId(const std::string& id) {
    static const std::regex pattern("^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$");
    return id.size()==36&&std::regex_match(id,pattern);
}

bool VoiceUsername(const std::string& value) {
    return !value.empty()&&value.size()<128&&
           value.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_@-")==std::string::npos;
}

std::string VoiceSilk(const json& body,VoiceOperation& operation) {
    operation.id=body.at("operationId").get<std::string>();
    operation.target=body.at("wxidorgid").get<std::string>();
    operation.accountWxid=body.at("accountWxid").get<std::string>();
    const auto& duration=body.at("durationMs");
    if(!VoiceOperationId(operation.id)||!VoiceUsername(operation.target)||!VoiceUsername(operation.accountWxid)||
       operation.accountWxid.find('@')!=std::string::npos||!duration.is_number_integer()||duration<=0||duration>60000)
        throw std::invalid_argument("invalid voice operation");
    operation.duration=duration.get<uint32_t>();
    const auto& encoded=body.at("silkBase64").get_ref<const std::string&>();
    if(encoded.empty()||encoded.size()>MaxVoiceBody-1024||encoded.size()%4||
       encoded.find_first_not_of("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=")!=std::string::npos)
        throw std::invalid_argument("invalid voice encoding");
    DWORD bytes=static_cast<DWORD>(encoded.size()/4*3);
    std::string silk(bytes,'\0');
    if(!CryptStringToBinaryA(encoded.data(),static_cast<DWORD>(encoded.size()),CRYPT_STRING_BASE64|CRYPT_STRING_STRICT,
                            reinterpret_cast<BYTE*>(silk.data()),&bytes,nullptr,nullptr)||bytes<=12||bytes>MaxVoiceBytes)
        throw std::invalid_argument("invalid voice encoding");
    silk.resize(bytes);
    if(silk.compare(0,10,"\x02#!SILK_V3"))throw std::invalid_argument("Tencent SILK required");
    size_t offset=10;
    uint32_t packets=0;
    while(offset<silk.size()){
        if(silk.size()-offset<2)throw std::invalid_argument("invalid SILK frame");
        const auto* frame=reinterpret_cast<const unsigned char*>(silk.data()+offset);
        const size_t count=frame[0]|(frame[1]<<8);
        offset+=2;
        if(!count||count>32767||count>silk.size()-offset)throw std::invalid_argument("invalid SILK frame");
        offset+=count;
        ++packets;
    }
    if(packets*20!=operation.duration)throw std::invalid_argument("SILK duration mismatch");
    if(BCryptHash(BCRYPT_SHA256_ALG_HANDLE,nullptr,0,reinterpret_cast<PUCHAR>(silk.data()),bytes,
                  operation.digest.data(),static_cast<ULONG>(operation.digest.size()))<0)
        throw std::runtime_error("voice digest failed");
    return silk;
}

// The task and message factory use the core's MSVC x64 ABI.
struct VoiceShared { void* object=nullptr; uintptr_t control=0; };
struct VoiceString { union { char small[16]; const char* large; }; size_t size,capacity; };
struct VoiceOptions { uint32_t mode=4,codec=3; uint64_t timeout=30000,reserved[4]{},capacity=15; };
struct VoiceResult { uint64_t status; VoiceString error; VoiceShared detail; unsigned char padding[72]; };
static_assert(sizeof(VoiceString)==32&&sizeof(VoiceOptions)==56&&sizeof(VoiceResult)==128);
static_assert(offsetof(VoiceResult,detail)==40&&sizeof(std::function<void()>)==64);

VoiceString BorrowVoiceString(const std::string& value) {
    VoiceString view{};
    view.size=value.size();
    view.capacity=value.size();
    if(value.size()<sizeof(view.small)){
        view.capacity=sizeof(view.small)-1;
        memcpy(view.small,value.c_str(),value.size()+1);
    }else view.large=value.data();
    return view;
}

bool VoiceAccountMatches(const VoiceShared& context,const std::string& account) {
    const auto root=Word(reinterpret_cast<void*>(base+VoiceAccountRoot),0);
    if(!root||!context.object||!context.control)return false;
    auto* app=reinterpret_cast<void*>(root);
    if(Word(app,0)!=base+VoiceAccountRootTable||Word(context.object,0)!=base+VoiceContextTable||
       Word(app,0x68)!=reinterpret_cast<uintptr_t>(context.object))return false;
    const auto* name=reinterpret_cast<const VoiceString*>(static_cast<const BYTE*>(context.object)+0x48);
    if(name->size!=account.size()||name->capacity<name->size||name->capacity>1024*1024)return false;
    const auto* data=name->capacity<16?name->small:name->large;
    return data&&!memcmp(data,account.data(),account.size())&&
           Word(reinterpret_cast<void*>(base+VoiceAccountRoot),0)==root&&
           Word(app,0x68)==reinterpret_cast<uintptr_t>(context.object);
}

bool ReleaseVoiceShared(const VoiceShared& value) {
    __try{ReleaseShared(value.control);return true;}
    __except(EXCEPTION_EXECUTE_HANDLER){return false;}
}

bool ReleaseVoiceError(const VoiceString& error) {
    __try{
        if(error.capacity<16)return true;
        if(error.capacity>=1024*1024||!error.large)return false;
        auto* allocation=const_cast<char*>(error.large);
        auto size=error.capacity+1;
        if(size>=4096){allocation=reinterpret_cast<char**>(allocation)[-1];size+=39;}
        Delete(allocation,size);
        return true;
    }__except(EXCEPTION_EXECUTE_HANDLER){return false;}
}

VoiceState SendVoiceOnCore(const VoiceOperation& operation,const std::string& silk) {
    using Context=VoiceShared*(__fastcall*)(VoiceShared*);
    using Service=VoiceShared*(__fastcall*)(void*,VoiceShared*);
    using Create=VoiceShared*(__fastcall*)(VoiceShared*,const VoiceString*,const VoiceString*,const uint32_t*,const VoiceOptions*);
    using SubmitVoice=void*(__fastcall*)(void*,VoiceResult*,VoiceShared*,uint8_t);
    VoiceShared context{},provider{},manager{},message{};
    alignas(16) VoiceResult result{};
    const auto target=BorrowVoiceString(operation.target),audio=BorrowVoiceString(silk);
    const VoiceOptions options{};
    auto state=VoiceState::Rejected;
    __try{
        reinterpret_cast<Context>(base+VoiceContextRva)(&context);
        if(!VoiceAccountMatches(context,operation.accountWxid))__leave;
        reinterpret_cast<Create>(base+VoiceFactoryRva)(&message,&target,&audio,&operation.duration,&options);
        if(!message.object||!message.control||Word(message.object,0)!=base+VoiceMessageTable){
            voiceFaulted=true;
            __leave;
        }
        auto* object=static_cast<BYTE*>(message.object);
        *reinterpret_cast<uint32_t*>(object+0x118)=34;
        const auto* copy=reinterpret_cast<const VoiceString*>(object+0x758);
        if(copy->size!=silk.size()||*reinterpret_cast<const uint32_t*>(object+0x778)!=operation.duration){
            voiceFaulted=true;
            __leave;
        }
        reinterpret_cast<Service>(base+VoiceProviderRva)(context.object,&provider);
        if(!provider.object||!provider.control)__leave;
        reinterpret_cast<Service>(base+VoiceManagerRva)(provider.object,&manager);
        if(!manager.object||!manager.control||!VoiceAccountMatches(context,operation.accountWxid))__leave;
        // Transfer a retained reference to the send manager. Keep the original for cleanup.
        VoiceShared submitted=message;
        InterlockedIncrement(reinterpret_cast<volatile LONG*>(submitted.control+8));
        state=VoiceState::Uncertain;
        reinterpret_cast<SubmitVoice>(base+VoiceSendRva)(manager.object,&result,&submitted,1);
        if(result.status==0)state=VoiceState::Accepted;
    }__except(EXCEPTION_EXECUTE_HANDLER){voiceFaulted=true;}
    bool cleaned=ReleaseVoiceShared(result.detail);
    cleaned=ReleaseVoiceError(result.error)&&cleaned;
    for(const auto* value:{&message,&manager,&provider,&context})cleaned=ReleaseVoiceShared(*value)&&cleaned;
    if(!cleaned)voiceFaulted=true;
    return state;
}

VoiceState QueueVoice(std::function<void()>* work) {
    struct Location { const char* function; const char* file; uint32_t line; uint32_t padding; void* caller; };
    static_assert(sizeof(Location)==32);
    Location location{"WeChatAgent.SendVoiceMsg","text_4_2_0_12.cpp",1,0,nullptr};
    using App=void*(__fastcall*)();
    using GetScheduler=VoiceShared*(__fastcall*)(void*,VoiceShared*);
    using Enqueue=VoiceShared*(__fastcall*)(void*,VoiceShared*,Location*,std::function<void()>*,uint32_t);
    VoiceShared scheduler{},future{};
    auto state=VoiceState::Rejected;
    __try{
        auto* app=reinterpret_cast<App>(base+VoiceAppRva)();
        if(app){
            reinterpret_cast<GetScheduler>(base+VoiceSchedulerRva)(app,&scheduler);
            if(scheduler.object&&scheduler.control){
                state=VoiceState::Uncertain;
                reinterpret_cast<Enqueue>(base+VoiceEnqueueRva)(scheduler.object,&future,&location,work,1);
                state=VoiceState::Queued;
            }
        }
    }__except(EXCEPTION_EXECUTE_HANDLER){voiceFaulted=true;}
    const bool futureReleased=ReleaseVoiceShared(future);
    if(!ReleaseVoiceShared(scheduler)||!futureReleased)voiceFaulted=true;
    return state;
}

void VoiceReply(httplib::Response& res,const VoiceOperation& operation) {
    const auto state=operation.state.load();
    const char* name="queued";
    switch(state){
        case VoiceState::Accepted:name="accepted";break;
        case VoiceState::Rejected:name="rejected";break;
        case VoiceState::Uncertain:name="uncertain";break;
        case VoiceState::Queued:
        case VoiceState::Running:break;
    }
    res.set_content(json({{"ret",state==VoiceState::Rejected?1:0},{"state",name},
        {"operationId",operation.id},{"target",operation.target}}).dump(),"application/json");
}

DWORD WINAPI Run(void*){
    // Resolve module paths on our reserved-stack worker, never in DllMain.
    std::vector<wchar_t> modulePath(32768);
    const DWORD pathLength=GetModuleFileNameW(reinterpret_cast<HMODULE>(OwnModule),modulePath.data(),static_cast<DWORD>(modulePath.size()));
    if(!pathLength||pathLength>=modulePath.size())return 7;
    ConfigFile=std::filesystem::path(std::wstring(modulePath.data(),pathLength)).parent_path()/L"wechatagent-hook.json";
    base=reinterpret_cast<uintptr_t>(GetModuleHandleW(L"Weixin.dll"));
    if(!ProfileMatches()){Event("profile-mismatch");return 1;}
    if(WaitForInputIdle(GetCurrentProcess(),15000)!=WAIT_OBJECT_0){Event("gui-startup-not-idle");return 6;}
    Event("gui-startup-idle");
    StackLog=CreateFileW((ConfigFile.parent_path()/L"stack-failure.jsonl").c_str(),FILE_APPEND_DATA,FILE_SHARE_READ|FILE_SHARE_WRITE,nullptr,OPEN_ALWAYS,FILE_ATTRIBUTE_NORMAL,nullptr);
    AddVectoredExceptionHandler(1,StackFailure);StackState("backend-thread");
    json config;try{config=Config();}catch(...){Event("config-unavailable");return 2;}
    std::ifstream tokenFile(ConfigFile.parent_path()/L"wechatagent-hook.token");
    std::string token;std::getline(tokenFile,token);if(!token.empty()&&token.back()=='\r')token.pop_back();
    if(token.size()!=64||config.value("expectedVersion","")!="4.2.0.12"){Event("config-invalid");return 3;}
    const auto startupFault=GuardProbe();
    if(startupFault||!nativeCppError.empty()){faulted=true;Event("construction-probe-failed");return 5;}
    probeReady=true;
    const bool voiceProfile=VoiceProfileMatches();
    const bool voiceTestOnly=config.value("voiceTestOnly",false);
    if(!voiceProfile)Event("voice-profile-mismatch");
    std::map<std::string,std::shared_ptr<VoiceOperation>> voiceOperations;
    std::weak_ptr<VoiceOperation> lastVoice;
    httplib::Server server;server.new_task_queue=[](){return new ObservedPool();};server.set_payload_max_length(MaxVoiceBody);
    auto authorized=[token](const httplib::Request& req,httplib::Response& res){
        const std::string expected="Bearer "+token,supplied=req.get_header_value("Authorization");
        unsigned difference=static_cast<unsigned>(expected.size()^supplied.size());
        for(size_t i=0;i<expected.size();++i)difference|=expected[i]^(i<supplied.size()?supplied[i]:0);
        if(difference){res.status=401;res.set_content("{\"error\":\"unauthorized\"}","application/json");return false;}
        if(req.path!="/SendVoiceMsg"&&req.body.size()>65536){res.status=413;return false;}
        return true;
    };
    server.set_pre_routing_handler([&](const httplib::Request& req,httplib::Response& res){
        return req.method=="POST"&&req.path=="/SendVoiceMsg"&&!authorized(req,res)
            ?httplib::Server::HandlerResponse::Handled:httplib::Server::HandlerResponse::Unhandled;
    });
    server.Get("/WeChatAgent/health",[&](const httplib::Request& req,httplib::Response& res){
        if(!authorized(req,res))return;
        res.set_content(json({{"backend","wechat-hook"},{"integration","WeChatAgent-1"},{"profile","4.2.0.12-stickers-v2"},{"startupState",probeReady.load()&&!faulted.load()?"ready":"failed"},{"version",Version()},
          {"pid",GetCurrentProcessId()},{"databaseAccounts",Accounts()},{"nativeTextSend",probeReady.load()&&!faulted.load()},
          {"nativeImageSend",probeReady.load()&&!faulted.load()},{"nativeMentionSend",probeReady.load()&&!faulted.load()},
          {"nativeQuoteSend",false},{"nativeStickerSend",probeReady.load()&&!faulted.load()},{"phase",phase.load()},{"faulted",faulted.load()},
          {"nativeVoiceSend",voiceProfile&&!voiceFaulted&&!faulted},{"nativeVoiceProtocol",VoiceProtocol},{"nativeVoiceTestOnly",voiceTestOnly},
          {"diagnostics",{{"messageTableRva",actualMessageTable.load()},{"receiverLength",receiverLength.load()},
            {"receiverCapacity",receiverCapacity.load()},{"contentLength",contentLength.load()},{"contentCapacity",contentCapacity.load()}}}}).dump(),"application/json");
    });
    server.Post("/WeChatAgent/probe",[&](const httplib::Request& req,httplib::Response& res){
        if(!authorized(req,res))return;std::lock_guard<std::mutex> lock(sendMutex);
        if(faulted){res.status=409;res.set_content("{\"error\":\"native fault; no retry\"}","application/json");return;}
        try{DWORD code=GuardProbe();if(code){faulted=true;throw std::runtime_error("native construction fault "+std::to_string(code));}
            if(!nativeCppError.empty())throw std::runtime_error(nativeCppError);
            probeReady=true;Event("construction-probe-passed");res.set_content("{\"ok\":true,\"sendCalls\":0,\"desktopInputs\":0}","application/json");
        }catch(const std::exception& e){faulted=true;probeReady=false;res.status=503;res.set_content(json({{"error",e.what()},{"phase",phase.load()}}).dump(),"application/json");}
    });
    server.Post("/SendTextMsg",[&](const httplib::Request& req,httplib::Response& res){
        if(!authorized(req,res))return;std::lock_guard<std::mutex> lock(sendMutex);
        const auto accounts=Accounts();
        if(!probeReady||faulted||accounts.size()!=1||!accounts.count(req.get_header_value("X-WeChatAgent-Account"))){
            res.status=409;res.set_content("{\"ret\":1,\"error\":\"native backend or account not ready\"}","application/json");return;}
        try{
            const auto body=json::parse(req.body);const auto target=body.value("wxidorgid",""),text=body.value("msg","");
            if(target.empty()||target.size()>256||text.empty()||text.size()>16000||target.find('\0')!=std::string::npos||text.find('\0')!=std::string::npos){
                res.status=400;res.set_content("{\"ret\":1,\"error\":\"invalid text request\"}","application/json");return;}
            const DWORD code=GuardSubmit(&target,&text);
            if(code){faulted=true;Event("native-send-fault");throw std::runtime_error("native submission uncertain "+std::to_string(code));}
            if(!nativeCppError.empty())throw std::runtime_error(nativeCppError);
            Event("native-send-accepted");res.set_content("{\"ret\":0,\"retmsg\":\"accepted\"}","application/json");
        }catch(const std::exception& e){res.status=503;res.set_content(json({{"ret",1},{"error",e.what()},{"phase",phase.load()}}).dump(),"application/json");}
    });
    auto readyFor=[&](const httplib::Request& req,httplib::Response& res){
        const auto accounts=Accounts();
        if(!probeReady||faulted||accounts.size()!=1||!accounts.count(req.get_header_value("X-WeChatAgent-Account"))){
            res.status=409;res.set_content("{\"ret\":1,\"error\":\"native backend or account not ready\"}","application/json");return false;
        }return true;
    };
    server.Post("/SendVoiceMsg",[&](const httplib::Request& req,httplib::Response& res){
        if(!authorized(req,res))return;
        auto operation=std::make_shared<VoiceOperation>();
        std::string silk;
        try{silk=VoiceSilk(json::parse(req.body),*operation);}
        catch(const json::exception&){res.status=400;return;}
        catch(const std::invalid_argument&){res.status=400;return;}
        if(voiceTestOnly&&operation->target!="filehelper"){res.status=403;return;}
        std::lock_guard<std::mutex> lock(sendMutex);
        if(!readyFor(req,res))return;
        operation->accountDirectory=req.get_header_value("X-WeChatAgent-Account");
        const auto previous=voiceOperations.find(operation->id);
        if(previous!=voiceOperations.end()){
            const auto& saved=*previous->second;
            if(saved.accountDirectory!=operation->accountDirectory||saved.accountWxid!=operation->accountWxid||
               saved.target!=operation->target||saved.duration!=operation->duration||saved.digest!=operation->digest){
                res.status=409;
                return;
            }
            VoiceReply(res,saved);
            return;
        }
        if(!voiceProfile||voiceFaulted){
            res.status=409;
            return;
        }
        const auto pending=lastVoice.lock();
        if(pending){
            const auto state=pending->state.load();
            if(state==VoiceState::Queued||state==VoiceState::Running){res.status=429;return;}
        }
        // The adapter owns the durable delivery record. Retain recent transport
        // operations here to recover lost HTTP responses and suppress duplicates.
        if(voiceOperations.size()>=4096){
            for(auto it=voiceOperations.begin();it!=voiceOperations.end();){
                if(GetTickCount64()-it->second->created>60*60*1000)it=voiceOperations.erase(it);
                else ++it;
            }
            if(voiceOperations.size()>=4096){res.status=429;return;}
        }
        std::function<void()> send=[operation,silk=std::move(silk)](){
            auto expected=VoiceState::Queued;
            if(!operation->state.compare_exchange_strong(expected,VoiceState::Running)){
                if(expected!=VoiceState::Uncertain||
                   !operation->state.compare_exchange_strong(expected,VoiceState::Running))return;
            }
            operation->state=SendVoiceOnCore(*operation,silk);
        };
        voiceOperations.emplace(operation->id,operation);
        lastVoice=operation;
        const auto queued=QueueVoice(&send);
        if(queued!=VoiceState::Queued){
            auto expected=VoiceState::Queued;
            operation->state.compare_exchange_strong(expected,queued);
        }
        VoiceReply(res,*operation);
    });
    server.Get(R"(/WeChatAgent/voice-deliveries/([a-f0-9-]{36}))",[&](const httplib::Request& req,httplib::Response& res){
        if(!authorized(req,res))return;
        std::lock_guard<std::mutex> lock(sendMutex);
        const auto operation=voiceOperations.find(req.matches[1].str());
        if(operation==voiceOperations.end()){res.status=404;return;}
        if(!readyFor(req,res))return;
        if(operation->second->accountDirectory!=req.get_header_value("X-WeChatAgent-Account")){
            res.status=409;
            return;
        }
        VoiceReply(res,*operation->second);
    });
    server.Post("/SendImgMsg",[&](const httplib::Request& req,httplib::Response& res){
        if(!authorized(req,res))return;std::lock_guard<std::mutex> lock(sendMutex);if(!readyFor(req,res))return;
        std::string target,file;uint64_t bytes=0;
        try{
            const auto body=json::parse(req.body);target=body.value("wxidorgid","");if(!ValidTarget(target))throw std::runtime_error("invalid target");
            const auto image=CheckedImage(body.value("path",""),std::filesystem::u8path(config.value("imageRoot","")));file=image.u8string();bytes=std::filesystem::file_size(image);
        }catch(const std::exception& e){res.status=400;res.set_content(json({{"ret",1},{"error",e.what()}}).dump(),"application/json");return;}
        const DWORD code=GuardImage(&target,&file,bytes);
        if(code||!nativeCppError.empty()){
            faulted=true;Event("native-image-send-uncertain");res.status=503;res.set_content("{\"ret\":1,\"error\":\"native image submission uncertain; do not retry\"}","application/json");return;
        }
        Event("native-image-send-accepted");res.set_content("{\"ret\":0,\"retmsg\":\"accepted\"}","application/json");
    });
    server.Post("/SendStickerMsg",[&](const httplib::Request& req,httplib::Response& res){
        if(!authorized(req,res))return;std::lock_guard<std::mutex> lock(sendMutex);if(!readyFor(req,res))return;
        std::string target,file;uint64_t bytes=0;
        try{
            const auto body=json::parse(req.body);target=body.value("wxidorgid","");if(!ValidTarget(target))throw std::runtime_error("invalid target");
            const auto sticker=CheckedSticker(body.value("path",""),body.at("sticker"),std::filesystem::u8path(config.value("stickerRoot","")));file=sticker.u8string();bytes=std::filesystem::file_size(sticker);
        }catch(const std::exception& e){res.status=400;res.set_content(json({{"ret",1},{"error",e.what()}}).dump(),"application/json");return;}
        const DWORD code=GuardSticker(&target,&file,bytes);
        if(code||!nativeCppError.empty()){
            faulted=true;Event("native-sticker-send-uncertain");res.status=503;res.set_content("{\"ret\":1,\"error\":\"native sticker submission uncertain; do not retry\"}","application/json");return;
        }
        Event("native-sticker-send-accepted");res.set_content("{\"ret\":0,\"retmsg\":\"accepted\"}","application/json");
    });
    server.Post("/SendTextAtMsg",[&](const httplib::Request& req,httplib::Response& res){
        if(!authorized(req,res))return;std::lock_guard<std::mutex> lock(sendMutex);if(!readyFor(req,res))return;
        std::string target,text,ids;
        try{
            const auto body=json::parse(req.body);target=body.value("wxidorgid","");text=body.value("msg","");
            if(!ValidTarget(target)||target.size()<10||target.substr(target.size()-9)!="@chatroom"||text.empty()||text.size()>16000||text.find('\0')!=std::string::npos)throw std::runtime_error("invalid group mention request");
            ids=MentionList(body.at("atUserIds"));
        }catch(const std::exception& e){res.status=400;res.set_content(json({{"ret",1},{"error",e.what()}}).dump(),"application/json");return;}
        const DWORD code=GuardMention(&target,&text,&ids);
        if(code||!nativeCppError.empty()){
            faulted=true;Event("native-mention-send-uncertain");res.status=503;res.set_content("{\"ret\":1,\"error\":\"native mention submission uncertain; do not retry\"}","application/json");return;
        }
        Event("native-mention-send-accepted");res.set_content("{\"ret\":0,\"retmsg\":\"accepted\"}","application/json");
    });
    const auto url=config.value("baseUrl","");
    std::smatch match;
    const int port=std::regex_match(url,match,std::regex(R"(http://127\.0\.0\.1:([0-9]{1,5}))"))?std::stoi(match[1]):0;
    if(port<1024||port>65535){Event("invalid-loopback-port");return 4;}
    Event("loopback-backend-starting");server.listen("127.0.0.1",port);Event("loopback-backend-stopped");return 0;
}
}
BOOL WINAPI DllMain(HINSTANCE instance,DWORD reason,void*){
    if(reason==DLL_PROCESS_ATTACH){
        // /MT requires thread notifications. Keep every notification frame tiny.
        OwnModule=reinterpret_cast<uintptr_t>(instance);
        HANDLE thread=CreateThread(nullptr,2*1024*1024,Run,nullptr,STACK_SIZE_PARAM_IS_A_RESERVATION,nullptr);if(thread)CloseHandle(thread);
    }return TRUE;
}
