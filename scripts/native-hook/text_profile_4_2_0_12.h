#pragma once
#include <cstddef>
#include <cstdint>

// Exact 4.2.0.12 candidate; every changed native build requires live acceptance.
// Runtime checks also verify SizeOfImage, send entry bytes and sender vtable.
namespace WeChatAgentText42012 {
constexpr uintptr_t SendRva=0x1a13470,TextCtorRva=0x78d5c0,FactoryRva=0xf910;
constexpr uintptr_t OwnerTable=0x912d1a8,MessageTable=0x912d238,SenderTable=0x93f5098;
constexpr uintptr_t ImageCtorRva=0x1ac5d80,ImageOwnerTable=0x93bd4a8,ImageMessageTable=0x93bd538;
constexpr uintptr_t StickerFactoryRva=0x1c3c160,StickerOwnerTable=0x93bd728,StickerMessageTable=0x93bd7b8;
constexpr size_t StickerOwnerSize=0x790;
constexpr uintptr_t AllocateRva=0x76a53bc,FreeRva=0x76a5400;
constexpr size_t ImageSize=206417920;

// Voice ABI observed in the exact 4.2.0.12 core (Helper native compatibility profile).
constexpr uint32_t VoiceCoreTimestamp=0x6ae33707;
constexpr uint64_t VoiceCoreFileSize=205932072;
constexpr unsigned char VoiceCoreSha256[32]={
    0x2b,0x36,0x77,0xc3,0xf9,0x32,0xda,0xaa,0x4e,0xf8,0x4c,0x8b,0x2a,0xcd,0x0a,0xee,
    0x12,0xcb,0xe5,0xa7,0x79,0xff,0x9e,0x74,0x0c,0x37,0x07,0x61,0xe5,0xc2,0x91,0xce
};
constexpr uintptr_t VoiceAppRva=0x45d10,VoiceSchedulerRva=0x47310,VoiceEnqueueRva=0x311990;
constexpr uintptr_t VoiceContextRva=0x47220,VoiceProviderRva=0x384730,VoiceManagerRva=0x71b380;
constexpr uintptr_t VoiceFactoryRva=0x6e53af0,VoiceSendRva=0x17ce4c0,VoiceMessageTable=0x9e27e18;
constexpr uintptr_t VoiceAccountRoot=0xbd0ce30,VoiceAccountRootTable=0x9055b98,VoiceContextTable=0x90d5f68;
}
