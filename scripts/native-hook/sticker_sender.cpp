#define WIN32_LEAN_AND_MEAN
#include <Windows.h>
#include <cstdint>
#include <filesystem>
#include "global.h"
#include "sticker_sender.h"

namespace WeixinSend {
    // A real 4.1.10.27 UI GIF send uses an appmsg input (49, subtype 8), not
    // an image input with type 47. Both type getters are on the common base.
    struct InnerStruct2;
    InnerStruct2* BuildSendParam1(uint64_t);
    void BuildSendParam2_Image(uint64_t*);
    bool SendStickerFile(const std::string& target,const std::string& path) {
        auto base=reinterpret_cast<uintptr_t>(GetModuleHandleW(L"Weixin.dll"));
        if(!base || reinterpret_cast<uintptr_t>(g_hWeixinDll)!=base)return false;
        struct SharedMessage {uintptr_t body,owner;};
        SharedMessage message{};
        using Factory=SharedMessage*(*)(SharedMessage*);
        reinterpret_cast<Factory>(base+WeChatAgentSticker::EmojiFactory)(&message);
        if(!message.body || message.body!=message.owner+0x10 ||
          *reinterpret_cast<uintptr_t*>(message.owner)!=base+WeChatAgentSticker::EmojiOwnerVtable ||
          *reinterpret_cast<uintptr_t*>(message.body)!=base+WeChatAgentSticker::EmojiVtable)return false;
        // The native constructor supplies sender/account state and the message
        // identifier. Set only fields validated against the current layout.
        *reinterpret_cast<std::string*>(message.body+0xB0)=target;
        auto size=MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,path.data(),static_cast<int>(path.size()),nullptr,0);
        if(size<=0)return false;
        std::wstring wide(size,L'\0');
        if(MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,path.data(),static_cast<int>(path.size()),wide.data(),size)!=size)return false;
        *reinterpret_cast<std::wstring*>(message.body+0xE0)=wide;
        if(std::filesystem::path(wide).extension()!=L".gif")return false;
        *reinterpret_cast<uint32_t*>(message.body+0xD8)=49;
        *reinterpret_cast<uint32_t*>(message.body+0xDC)=8;
        *reinterpret_cast<std::string*>(message.body+0x168)=std::filesystem::path(wide).filename().string();
        *reinterpret_cast<uint64_t*>(message.body+0x188)=std::filesystem::file_size(std::filesystem::path(wide));
        auto first=BuildSendParam1(message.owner);
        auto second=static_cast<uint64_t*>(HeapAlloc(GetProcessHeap(),HEAP_ZERO_MEMORY,0xE8));
        if(!first || !second)return false;
        BuildSendParam2_Image(second);
        using Send=__int64(*)(uint64_t,uint64_t);
        reinterpret_cast<Send>(base+offset::send_message)(reinterpret_cast<uint64_t>(first),reinterpret_cast<uint64_t>(second));
        // Native work owns the queued objects; completion is checked by the
        // reader's new matching native sticker row and nonzero server ID.
        return true;
    }
}
