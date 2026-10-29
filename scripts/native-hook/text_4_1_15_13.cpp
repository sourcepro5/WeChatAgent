// Native text/image/mention APIs for the exact 4.1.15.13 x64 profile.
// No UIA, input simulation, desktop hooks or window activation.
#define WIN32_LEAN_AND_MEAN
#include <Windows.h>
#include <winternl.h>
#include <atomic>
#include <cstring>
#include <cwctype>
#include <filesystem>
#include <fstream>
#include <functional>
#include <mutex>
#include <set>
#include <vector>
#include <regex>
#include "text_profile_4_1_15_13.h"
#include "httplib.h"
#include "json.hpp"

using json=nlohmann::json;
namespace {
using namespace WeChatAgentText41513;
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
    wchar_t path[32768]{};GetModuleFileNameW(reinterpret_cast<HMODULE>(base),path,32768);
    DWORD ignored=0,size=GetFileVersionInfoSizeW(path,&ignored);if(!size)return "";
    std::vector<BYTE> data(size);if(!GetFileVersionInfoW(path,0,size,data.data()))return "";
    VS_FIXEDFILEINFO* info=nullptr;UINT length=0;if(!VerQueryValueW(data.data(),L"\\",reinterpret_cast<void**>(&info),&length)||!info)return "";
    return std::to_string(HIWORD(info->dwFileVersionMS))+"."+std::to_string(LOWORD(info->dwFileVersionMS))+"."+
      std::to_string(HIWORD(info->dwFileVersionLS))+"."+std::to_string(LOWORD(info->dwFileVersionLS));
}
bool ProfileMatches(){
    if(!base||Version()!="4.1.15.13")return false;
    auto* dos=reinterpret_cast<IMAGE_DOS_HEADER*>(base);
    auto* pe=reinterpret_cast<IMAGE_NT_HEADERS64*>(base+dos->e_lfanew);
    if(pe->OptionalHeader.SizeOfImage!=ImageSize)return false;
    const BYTE entry[]={0x55,0x41,0x56,0x56,0x57,0x53,0x48,0x81,0xec,0xe0,1,0,0};
    if(memcmp(reinterpret_cast<void*>(base+SendRva),entry,sizeof(entry)))return false;
    if(*reinterpret_cast<uintptr_t*>(base+SenderTable+16)!=base+SendRva)return false;
    const uintptr_t code[]={SendRva,TextCtorRva,ImageCtorRva,FactoryRva,AllocateRva,FreeRva};
    for(auto rva:code){MEMORY_BASIC_INFORMATION m{};
        if(!VirtualQuery(reinterpret_cast<void*>(base+rva),&m,sizeof(m))||m.State!=MEM_COMMIT||
          !(m.Protect&(PAGE_EXECUTE|PAGE_EXECUTE_READ|PAGE_EXECUTE_READWRITE|PAGE_EXECUTE_WRITECOPY)))return false;
    }
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
    for(ULONG_PTR i=0;i<snapshot->count;++i){
        auto file=snapshot->entries[i].value;if(GetFileType(file)!=FILE_TYPE_DISK)continue;
        wchar_t name[32768]{};DWORD n=GetFinalPathNameByHandleW(file,name,32768,FILE_NAME_NORMALIZED);if(!n||n>=32768)continue;
        std::wstring path(name,n);for(auto& ch:path){if(ch==L'/')ch=L'\\';ch=towlower(ch);}
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

DWORD WINAPI Run(void*){
    base=reinterpret_cast<uintptr_t>(GetModuleHandleW(L"Weixin.dll"));
    if(!ProfileMatches()){Event("profile-mismatch");return 1;}
    json config;try{config=Config();}catch(...){Event("config-unavailable");return 2;}
    std::ifstream tokenFile(ConfigFile.parent_path()/L"wechatagent-hook.token");
    std::string token;std::getline(tokenFile,token);if(!token.empty()&&token.back()=='\r')token.pop_back();
    if(token.size()!=64||config.value("expectedVersion","")!="4.1.15.13"){Event("config-invalid");return 3;}
    const auto startupFault=GuardProbe();
    if(startupFault||!nativeCppError.empty()){faulted=true;Event("construction-probe-failed");return 5;}
    probeReady=true;
    httplib::Server server;server.set_payload_max_length(65536);
    auto authorized=[token](const httplib::Request& req,httplib::Response& res){
        const std::string expected="Bearer "+token,supplied=req.get_header_value("Authorization");
        unsigned difference=static_cast<unsigned>(expected.size()^supplied.size());
        for(size_t i=0;i<expected.size();++i)difference|=expected[i]^(i<supplied.size()?supplied[i]:0);
        if(difference){res.status=401;res.set_content("{\"error\":\"unauthorized\"}","application/json");return false;}return true;
    };
    server.Get("/WeChatAgent/health",[&](const httplib::Request& req,httplib::Response& res){
        if(!authorized(req,res))return;
        res.set_content(json({{"backend","wechat-hook"},{"integration","WeChatAgent-1"},{"profile","4.1.15.13-media-mentions-v2"},{"startupState",probeReady.load()&&!faulted.load()?"ready":"failed"},{"version",Version()},
          {"pid",GetCurrentProcessId()},{"databaseAccounts",Accounts()},{"nativeTextSend",probeReady.load()&&!faulted.load()},
          {"nativeImageSend",probeReady.load()&&!faulted.load()},{"nativeMentionSend",probeReady.load()&&!faulted.load()},
          {"nativeQuoteSend",false},{"nativeStickerSend",false},{"phase",phase.load()},{"faulted",faulted.load()},
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
        wchar_t path[32768]{};GetModuleFileNameW(instance,path,32768);
        ConfigFile=std::filesystem::path(path).parent_path()/L"wechatagent-hook.json";
        DisableThreadLibraryCalls(instance);HANDLE thread=CreateThread(nullptr,0,Run,nullptr,0,nullptr);if(thread)CloseHandle(thread);
    }return TRUE;
}

