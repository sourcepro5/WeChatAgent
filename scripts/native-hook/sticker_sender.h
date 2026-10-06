#pragma once
#include <cstdint>
#include <string>
namespace WeixinSend { bool SendStickerFile(const std::string& target,const std::string& path); }
namespace WeChatAgentSticker {
    inline constexpr uintptr_t FileFactory=0x1C4CE70;
    inline constexpr uintptr_t FileConstructor=0x18EEDC0;
    inline constexpr uintptr_t Dispatch=0x16BED80;
    inline constexpr uintptr_t EmojiFactory=0x1B09F90;
    inline constexpr uintptr_t EmojiOwnerVtable=0x84F9938;
    inline constexpr uintptr_t EmojiVtable=0x84F99C8;
    bool StartTrace(const std::string& target);
    std::string TraceJson();
}
