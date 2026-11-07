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
}
