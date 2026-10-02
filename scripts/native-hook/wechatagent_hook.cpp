// Outer integration endpoints; the upstream send implementation is unchanged.
#define WIN32_LEAN_AND_MEAN
#include <Windows.h>
#include <winternl.h>
#include <cwctype>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <set>
#include <vector>
#include "httplib.h"
#include "json.hpp"
#include "wx_send.h"
#include "wechatagent_hook.h"

using json = nlohmann::json;
static std::timed_mutex sendMutex;

static std::string Utf8(const std::wstring& value) {
    int size = WideCharToMultiByte(CP_UTF8, 0, value.data(), (int)value.size(), nullptr, 0, nullptr, nullptr);
    std::string out(size, '\0');
    if (size) WideCharToMultiByte(CP_UTF8, 0, value.data(), (int)value.size(), out.data(), size, nullptr, nullptr);
    return out;
}

static std::wstring ModulePath(HMODULE module = nullptr) {
    wchar_t file[32768] = {};
    DWORD size = GetModuleFileNameW(module, file, 32768);
    return size && size < 32768 ? std::wstring(file, size) : L"";
}

static std::string CoreVersion() {
    std::wstring path = ModulePath(GetModuleHandleW(L"Weixin.dll"));
    DWORD ignored = 0, size = GetFileVersionInfoSizeW(path.c_str(), &ignored);
    if (!size) return "";
    std::vector<BYTE> bytes(size);
    if (!GetFileVersionInfoW(path.c_str(), 0, size, bytes.data())) return "";
    VS_FIXEDFILEINFO* info = nullptr;
    UINT length = 0;
    if (!VerQueryValueW(bytes.data(), L"\\", (void**)&info, &length) || !info) return "";
    return std::to_string(HIWORD(info->dwFileVersionMS)) + "." +
        std::to_string(LOWORD(info->dwFileVersionMS)) + "." +
        std::to_string(HIWORD(info->dwFileVersionLS)) + "." +
        std::to_string(LOWORD(info->dwFileVersionLS));
}

// Query this process's file handles, without reading database pages or keys.
// ProcessHandleInformation is supported on Windows 8+; failure closes the gate.
struct HandleEntry {
    HANDLE value;
    ULONG_PTR handleCount, pointerCount;
    ULONG grantedAccess, objectTypeIndex, attributes, reserved;
};
struct HandleSnapshot { ULONG_PTR count, reserved; HandleEntry entries[1]; };

static std::set<std::string> DatabaseAccounts() {
    using Query = NTSTATUS(NTAPI*)(HANDLE, ULONG, PVOID, ULONG, PULONG);
    auto query = (Query)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQueryInformationProcess");
    if (!query) return {};
    std::vector<BYTE> buffer(65536);
    ULONG required = 0;
    NTSTATUS status = query(GetCurrentProcess(), 51, buffer.data(), (ULONG)buffer.size(), &required);
    if (status < 0 && required > buffer.size() && required < 16 * 1024 * 1024) {
        buffer.resize(required + 4096);
        status = query(GetCurrentProcess(), 51, buffer.data(), (ULONG)buffer.size(), &required);
    }
    if (status < 0) return {};
    auto* snapshot = (HandleSnapshot*)buffer.data();
    if (snapshot->count > (buffer.size() - 2 * sizeof(ULONG_PTR)) / sizeof(HandleEntry)) return {};
    std::set<std::string> accounts;
    for (ULONG_PTR i = 0; i < snapshot->count; ++i) {
        HANDLE file = snapshot->entries[i].value;
        if (GetFileType(file) != FILE_TYPE_DISK) continue;
        wchar_t name[32768] = {};
        DWORD size = GetFinalPathNameByHandleW(file, name, 32768, FILE_NAME_NORMALIZED);
        if (!size || size >= 32768) continue;
        std::wstring path(name, size);
        for (auto& ch : path) { if (ch == L'/') ch = L'\\'; ch = towlower(ch); }
        const std::wstring marker = L"\\db_storage\\";
        size_t at = path.find(marker);
        if (at == std::wstring::npos) continue;
        std::wstring suffix = path.substr(at + marker.size());
        if (suffix != L"contact\\contact.db" && suffix != L"contact\\contact.db-wal" &&
            suffix != L"session\\session.db" && suffix.rfind(L"message\\message_", 0) != 0) continue;
        size_t previous = path.rfind(L'\\', at - 1);
        if (previous != std::wstring::npos) accounts.insert(Utf8(path.substr(previous + 1, at - previous - 1)));
    }
    return accounts;
}

void RegisterWeChatAgentRoutes(httplib::Server& server) {
    std::ifstream file(std::filesystem::path(ModulePath()).parent_path() / L"wechatagent-hook.token");
    std::string token;
    std::getline(file, token);
    if (!token.empty() && token.back() == '\r') token.pop_back();
    server.set_payload_max_length(65536);
    auto authorized = [token](const httplib::Request& req, httplib::Response& res) {
        std::string supplied = req.get_header_value("Authorization"), expected = "Bearer " + token;
        unsigned int difference = (unsigned int)(supplied.size() ^ expected.size());
        for (size_t i = 0; i < expected.size(); ++i) difference |= expected[i] ^ (i < supplied.size() ? supplied[i] : 0);
        if (token.size() != 64 || difference) {
            res.status = 401; res.set_content("{\"error\":\"Unauthorized\"}", "application/json");
            return false;
        }
        return true;
    };
    server.Get("/WeChatAgent/health", [authorized](const httplib::Request& req, httplib::Response& res) {
        if (!authorized(req, res)) return;
        json data = {{"backend", "wechat-hook"}, {"integration", "WeChatAgent-1"},
            {"version", CoreVersion()}, {"pid", GetCurrentProcessId()}, {"databaseAccounts", DatabaseAccounts()}};
        res.set_content(data.dump(), "application/json");
    });
    server.Post("/SendTextMsg", [authorized](const httplib::Request& req, httplib::Response& res) {
        if (!authorized(req, res)) return;
        try {
            auto accounts = DatabaseAccounts();
            std::string account = req.get_header_value("X-WeChatAgent-Account");
            if (CoreVersion() != "4.1.10.27" || account.empty() || accounts.size() != 1 || !accounts.count(account)) {
                res.status = 409; res.set_content("{\"ret\":1,\"error\":\"Version or account mismatch\"}", "application/json"); return;
            }
            json data = json::parse(req.body);
            std::string target = data.value("wxidorgid", ""), text = data.value("msg", "");
            if (target.empty() || target.size() > 256 || text.empty() || text.size() > 16000) {
                res.status = 400; res.set_content("{\"ret\":1}", "application/json"); return;
            }
            std::unique_lock<std::timed_mutex> lock(sendMutex, std::defer_lock);
            if (!lock.try_lock_for(std::chrono::seconds(1))) {
                res.status = 429; res.set_content("{\"ret\":1,\"error\":\"Busy\"}", "application/json"); return;
            }
            WeixinSend::SendText(target, text);
            // Acceptance only. The OneBot adapter still requires a new server receipt.
            res.set_content("{\"ret\":0,\"retmsg\":\"accepted\"}", "application/json");
        } catch (...) {
            res.status = 500; res.set_content("{\"ret\":1,\"error\":\"Native send failed\"}", "application/json");
        }
    });
    // Route handlers run after the bounded request body is read. Rejecting a
    // POST before reading its body can reset TCP and truncate the error JSON.
    auto unknown = [authorized](const httplib::Request& req, httplib::Response& res) {
        if (!authorized(req, res)) return;
        res.status = 404; res.set_content("{}", "application/json");
    };
    server.Get(".*", unknown);
    server.Post(".*", unknown);
}
