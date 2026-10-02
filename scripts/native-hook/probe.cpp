// Exercise the real integration routes in a process with a synthetic DB handle.
#define WIN32_LEAN_AND_MEAN
#include <Windows.h>
#include <iostream>
#include "httplib.h"
#include "wechatagent_hook.h"
namespace WeixinSend { void SendText(const std::string&, const std::string&) { ExitProcess(9); } }
int wmain(int argc, wchar_t** argv) {
    if (argc != 2) return 2;
    HANDLE file = CreateFileW(argv[1], GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, 0, nullptr);
    if (file == INVALID_HANDLE_VALUE) return 3;
    httplib::Server server;
    RegisterWeChatAgentRoutes(server);
    int port = server.bind_to_any_port("127.0.0.1");
    if (port <= 0) return 4;
    std::cout << port << std::endl;
    server.listen_after_bind();
    CloseHandle(file);
    return 0;
}
