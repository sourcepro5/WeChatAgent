#!/usr/bin/env python3
"""Foreground keyboard-simulation sender for WeChat 4.x (development build).

No OCR and no mouse: the chat is opened with Ctrl+F + the reader's unique
display name + Enter, the text is pasted from the clipboard and checked with
Ctrl+A/Ctrl+C before Enter. Delivery is decided by the adapter's database
receipt, never by this process.
"""
import argparse
import base64
import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import threading
import time

# The embedded Windows runtime uses an isolated ._pth and omits the script directory.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from wechat_voice_output import BYTE_RATE, MAX_PCM_BYTES, VoiceCable, VoiceOutputError

BACKEND = "wechat-input"
INTEGRATION = "WeChatAgent-Input-1"
OPERATIONS = ("health", "text", "file", "open", "voice")
VOICE_CLIENT_VERSION = "4.2.0.12"
MAX_REQUEST_BYTES = 4 * ((MAX_PCM_BYTES + 2) // 3) + 4096
MAIN_WINDOW_CLASS = re.compile(r"Qt\d+QWindowIcon|WeChatMainWndForPC|mmui::MainWindow")
MAIN_WINDOW_TITLES = ("微信", "Weixin", "WeChat")
HOOK_MODULE = re.compile(r"^wechatagent[-_].*\.dll$", re.IGNORECASE)
MEDIA_SUFFIXES = (".gif", ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".mp4", ".mov")


class InputError(Exception):
    def __init__(self, code, *, attempted=False, retryable=False):
        super().__init__(code)
        self.code = code
        self.attempted = attempted
        self.retryable = retryable


def read_config(root):
    return json.loads((root / "config" / "wechatagent.json").read_text(encoding="utf-8-sig"))


def input_settings(config, root):
    section = config.get("input") or {}
    executable = section.get("wechatExecutable")
    if executable is None or executable == "":
        executable = (config.get("hook") or {}).get("wechatExecutable")
    if not isinstance(executable, str) or not executable or re.search(r'[\r\n"\x00]', executable):
        raise InputError("INPUT_CLIENT_REQUIRED")
    path = Path(executable)
    if not path.is_absolute():
        path = root / path
    send_key = section.get("sendKey", "enter")
    if send_key not in ("enter", "ctrl-enter"):
        raise InputError("INPUT_SEND_KEY_INVALID")
    idle = section.get("idleMs", 2000)
    if not isinstance(idle, int) or isinstance(idle, bool) or not 0 <= idle <= 30000:
        raise InputError("INPUT_IDLE_INVALID")
    return {"executable": str(path.resolve()), "sendKey": send_key, "idleMs": idle,
            "paused": section.get("paused", False) is True, "voiceSend": section.get("voiceSend") is True}


def account_names(files):
    result = set()
    for file in files:
        parts = str(file).replace("/", "\\").lower().split("\\")
        for index, part in enumerate(parts):
            if part == "db_storage" and index:
                result.add(parts[index - 1])
    return sorted(result)


def hook_modules(modules, client_directory):
    """WeChatAgent Hook code inside the client process, by module path."""
    client = os.path.normcase(os.path.normpath(client_directory))
    found = []
    for module in modules:
        name = os.path.basename(module)
        if HOOK_MODULE.match(name):
            found.append(name)
        elif name.lower() == "version.dll" and os.path.normcase(os.path.dirname(os.path.normpath(module))) == client:
            found.append(name)
    return sorted(set(found))


def main_window_candidates(candidates, is_visible, title_of):
    """One process may own hidden helper windows of the main class; prefer one visible main window.

    Several processes, or several visible windows that are not the titled main window, stay ambiguous."""
    if len({pid for _, pid, _ in candidates}) != 1:
        return candidates
    visible = [row for row in candidates if is_visible(row[0])]
    if len(visible) == 1:
        return visible
    titled = [row for row in (visible or candidates) if title_of(row[0]) in MAIN_WINDOW_TITLES]
    return titled if len(titled) == 1 else candidates


def normalize_text(text):
    return text.replace("\r\n", "\n").replace("\r", "\n")


def _md5(file):
    digest = hashlib.md5()
    for chunk in iter(lambda: file.read(1024 * 1024), b""):
        digest.update(chunk)
    return digest.hexdigest()


def validate_file(root, request):
    source = Path(request.get("path", ""))
    base = root / "state" / "files" / "outgoing"
    try:
        source.resolve().relative_to(base.resolve())
    except ValueError:
        raise InputError("INPUT_FILE_OUTSIDE_OUTBOX")
    if not source.is_file() or source.is_symlink() or source.stat().st_size != request.get("size"):
        raise InputError("INPUT_FILE_INVALID")
    for parent in source.parents:
        if parent == root:
            break
        if parent.is_symlink():
            raise InputError("INPUT_FILE_INVALID")
    if source.suffix.lower() in MEDIA_SUFFIXES:
        raise InputError("INPUT_MEDIA_UNSUPPORTED")
    with source.open("rb") as file:
        digest = hashlib.file_digest(file, "md5").hexdigest() if hasattr(hashlib, "file_digest") else _md5(file)
    if digest != request.get("md5"):
        raise InputError("INPUT_FILE_CHANGED")
    return source.resolve()


def execute(root, request, backend, cancelled=lambda: False):
    config = read_config(root)
    operation = request.get("operation")
    if config["runtime"]["sender"] != BACKEND:
        raise InputError("INPUT_BACKEND_CHANGED")
    if operation not in OPERATIONS:
        raise InputError("INPUT_OPERATION_UNSUPPORTED")
    settings = input_settings(config, root)
    executable = settings["executable"]
    if os.path.exists(os.path.join(os.path.dirname(executable), "version.dll")):
        raise InputError("INPUT_CLIENT_HAS_PROXY_DLL")
    expected = str(request.get("account", "")).lower()
    identity = backend.bind(executable)
    if identity["hookModules"]:
        raise InputError("INPUT_CLIENT_HAS_HOOK")
    if not expected or identity["databaseAccounts"] != [expected]:
        raise InputError("INPUT_ACCOUNT_MISMATCH")
    if operation == "health":
        health = {
            "pid": identity["pid"], "version": identity["version"], "databaseAccounts": identity["databaseAccounts"],
            "backend": BACKEND, "integration": INTEGRATION, "ready": identity["visible"], "hookLoaded": False,
            "ocr": False, "mouse": False, "textSend": True, "fileSend": True, "stickerSend": False,
            "paused": settings["paused"], "sendKey": settings["sendKey"],
        }
        if settings["voiceSend"] and identity["version"] == VOICE_CLIENT_VERSION:
            try:
                VoiceCable().device()
                health["voiceSend"] = True
            except VoiceOutputError as error:
                health["voiceSend"] = False
                health["voiceSendError"] = str(error)
        return health
    if settings["paused"]:
        raise InputError("INPUT_PAUSED", retryable=True)
    if not identity["visible"]:
        raise InputError("INPUT_WINDOW_NOT_VISIBLE")
    kind, target = request.get("kind"), request.get("target")
    key = "groups" if kind == "group" else "private"
    if kind not in ("group", "private") or str(target) not in map(str, config["wechat"]["whitelist"][key]):
        raise InputError("INPUT_TARGET_NOT_ALLOWED")
    name = request.get("name")
    if not isinstance(name, str) or not name.strip() or len(name) > 200 or re.search(r"[\r\n\x00]", name):
        raise InputError("INPUT_TARGET_INVALID")
    if operation == "voice":
        return send_voice(root, request, backend, settings, identity, expected, cancelled)
    if operation == "open":
        # Manual dry run (CLI only): open the chat exactly like a send, then stop.
        if backend.user_active(settings["idleMs"]):
            raise InputError("INPUT_USER_ACTIVE", retryable=True)
        with backend.session():
            backend.activate()
            backend.open_chat(name)
            existing = backend.draft()
            if existing == name:
                backend.cancel_search()
                raise InputError("INPUT_TARGET_NOT_FOUND")
        return {"opened": True, "draftPresent": existing is not None, "submitted": False}
    text = request.get("text")
    if operation == "text" and (not isinstance(text, str) or not text.strip() or len(text.encode("utf-8")) > 16000):
        raise InputError("INPUT_TEXT_INVALID")
    source = validate_file(root, request) if operation == "file" else None
    if backend.user_active(settings["idleMs"]):
        raise InputError("INPUT_USER_ACTIVE", retryable=True)

    attempted = False
    staged = False
    with backend.session():
        try:
            backend.activate()
            backend.open_chat(name)
            existing = backend.draft()
            if existing is not None:
                if existing == name:
                    # Enter opened nothing: focus is still in the search box holding the name.
                    backend.cancel_search()
                    raise InputError("INPUT_TARGET_NOT_FOUND")
                raise InputError("INPUT_DRAFT_PRESENT")
            staged = True
            if operation == "text":
                backend.paste_text(text)
                pasted = backend.draft()
                if pasted is None or normalize_text(pasted) != normalize_text(text):
                    raise InputError("INPUT_CONTENT_MISMATCH")
            else:
                backend.paste_file(str(source))
                if not backend.file_staged(str(source)):
                    raise InputError("INPUT_CONTENT_MISMATCH")
            # Re-read permission and pause settings after navigation/paste.
            latest = read_config(root)
            latest_settings = input_settings(latest, root)
            if latest["runtime"]["sender"] != BACKEND or latest_settings["paused"]:
                raise InputError("INPUT_PAUSED", retryable=True)
            if str(target) not in map(str, latest["wechat"]["whitelist"][key]):
                raise InputError("INPUT_TARGET_NOT_ALLOWED")
            current = backend.bind(executable)
            if current["pid"] != identity["pid"] or current["databaseAccounts"] != [expected] or current["hookModules"]:
                raise InputError("INPUT_ACCOUNT_CHANGED")
            backend.assert_foreground()
            attempted = True
            backend.submit(latest_settings["sendKey"])
            if not backend.input_cleared():
                raise InputError("INPUT_SUBMIT_UNCONFIRMED", attempted=True)
        except InputError as error:
            error.attempted = error.attempted or attempted
            if staged and not error.attempted:
                backend.discard_input()
            raise
        except Exception:
            if staged and not attempted:
                with contextlib.suppress(Exception):
                    backend.discard_input()
            raise InputError("INPUT_OPERATION_FAILED", attempted=attempted)
    return {"ret": 0, "submitted": True, "receiptRequired": True}


def send_voice(root, request, backend, settings, identity, account, cancelled):
    if not settings["voiceSend"] or identity["version"] != VOICE_CLIENT_VERSION:
        raise InputError("INPUT_VOICE_UNSUPPORTED")
    if (request["kind"] != "private" or request.get("wxid") != "filehelper"
            or request["name"] not in ("文件传输助手", "File Transfer")):
        raise InputError("INPUT_VOICE_FILEHELPER_ONLY")
    try:
        pcm = base64.b64decode(request.get("pcmBase64", ""), validate=True)
    except (ValueError, TypeError):
        raise InputError("INPUT_VOICE_INVALID_PCM") from None
    if not 0 < len(pcm) <= MAX_PCM_BYTES or len(pcm) % 2:
        raise InputError("INPUT_VOICE_INVALID_PCM")
    if backend.user_active(settings["idleMs"]):
        raise InputError("INPUT_USER_ACTIVE", retryable=True)

    def guard():
        if cancelled():
            raise InputError("INPUT_VOICE_CANCELLED")
        backend.assert_foreground()

    try:
        cable = VoiceCable()
        with backend.session(), cable.prepare(pcm) as play:
            if cancelled():
                raise InputError("INPUT_VOICE_CANCELLED")
            backend.activate()
            backend.open_chat(request["name"])
            existing = backend.draft()
            if existing is not None:
                if existing == request["name"]:
                    backend.cancel_search()
                    raise InputError("INPUT_TARGET_NOT_FOUND")
                raise InputError("INPUT_DRAFT_PRESENT")
            latest = read_config(root)
            current_settings = input_settings(latest, root)
            if (latest["runtime"]["sender"] != BACKEND or current_settings["paused"] or not current_settings["voiceSend"]
                    or current_settings["executable"] != settings["executable"]):
                raise InputError("INPUT_VOICE_CANCELLED")
            if str(request["target"]) not in map(str, latest["wechat"]["whitelist"]["private"]):
                raise InputError("INPUT_TARGET_NOT_ALLOWED")
            current = backend.bind(settings["executable"])
            if current["pid"] != identity["pid"] or current["databaseAccounts"] != [account] or current["hookModules"]:
                raise InputError("INPUT_ACCOUNT_CHANGED")
            cable.device()
            guard()
            backend.record_voice(play, len(pcm) / BYTE_RATE, guard)
    except VoiceOutputError as error:
        raise InputError(str(error)) from None
    return {"ret": 0, "submitted": True, "receiptRequired": True}


def watch_parent(pid, on_exit=None):
    # Windows service shutdown can terminate Node without delivering SIGTERM.
    # Keep a handle to that exact process so an orphan cannot continue sending.
    if not isinstance(pid, int) or pid <= 0:
        raise InputError("INPUT_PARENT_INVALID")
    import ctypes
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [ctypes.c_uint, ctypes.c_bool, ctypes.c_uint]
    kernel.OpenProcess.restype = ctypes.c_void_p
    kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_uint]
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    handle = kernel.OpenProcess(0x00100000, False, pid)
    if not handle:
        raise InputError("INPUT_PARENT_NOT_RUNNING")
    if kernel.WaitForSingleObject(handle, 0) != 258:
        kernel.CloseHandle(handle)
        raise InputError("INPUT_PARENT_NOT_RUNNING")
    def monitor():
        kernel.WaitForSingleObject(handle, 0xFFFFFFFF)
        kernel.CloseHandle(handle)
        if on_exit is None:
            os._exit(6)
        on_exit()
    threading.Thread(target=monitor, daemon=True).start()


class WindowsInput:
    """Win32 desktop operations: SendInput keystrokes and the clipboard only."""

    VK = {"ctrl": 0x11, "alt": 0x12, "right_alt": 0xA5, "enter": 0x0D, "escape": 0x1B, "delete": 0x2E, "end": 0x23,
          "a": 0x41, "c": 0x43, "f": 0x46, "v": 0x56}
    EXTENDED = {"delete", "end", "right_alt"}

    def __init__(self):
        try:
            import ctypes
            from ctypes import wintypes
            import psutil
            import win32api
            import win32clipboard
            import win32con
            import win32gui
            import win32process
        except ImportError:
            raise InputError("INPUT_DEPENDENCIES_MISSING")
        self.ctypes, self.wintypes, self.psutil = ctypes, wintypes, psutil
        self.api, self.clip, self.con, self.gui, self.process = win32api, win32clipboard, win32con, win32gui, win32process
        self.user32 = ctypes.WinDLL("user32", use_last_error=True)
        u = self.user32
        u.GetForegroundWindow.restype = ctypes.c_void_p
        for fn in (u.SetForegroundWindow, u.BringWindowToTop, u.IsWindow):
            fn.argtypes = [ctypes.c_void_p]
        u.GetWindowThreadProcessId.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        u.GetWindowThreadProcessId.restype = wintypes.DWORD
        u.AttachThreadInput.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.BOOL]
        u.GetClipboardSequenceNumber.restype = wintypes.DWORD
        self.hwnd = None
        self.pid = None
        self.sentinel = None
        self.owned_sequence = None
        self._define_input()

    # --- process and window -------------------------------------------------
    def file_version(self, executable):
        version = self.api.GetFileVersionInfo(executable, "\\")
        ms, ls = version["FileVersionMS"], version["FileVersionLS"]
        return f"{ms >> 16}.{ms & 65535}.{ls >> 16}.{ls & 65535}"

    def modules(self, pid):
        handle = self.api.OpenProcess(0x0400 | 0x0010, False, pid)
        try:
            return [self.process.GetModuleFileNameEx(handle, module) for module in self.process.EnumProcessModulesEx(handle, 0x03)]
        finally:
            self.api.CloseHandle(handle)

    def locate(self, executable):
        candidates, matching = [], set()
        def inspect(hwnd, _):
            try:
                if not MAIN_WINDOW_CLASS.fullmatch(self.gui.GetClassName(hwnd)):
                    return
                _, pid = self.process.GetWindowThreadProcessId(hwnd)
                process = self.psutil.Process(pid)
                if os.path.normcase(process.exe()) != os.path.normcase(executable):
                    return
                matching.add(pid)
                accounts = account_names(file.path for file in process.open_files())
                if accounts:
                    candidates.append((hwnd, pid, accounts))
            except (self.psutil.Error, OSError):
                return
        self.gui.EnumWindows(inspect, None)
        if not candidates:
            raise InputError("INPUT_ACCOUNT_UNVERIFIED" if matching else "INPUT_WECHAT_NOT_RUNNING")
        rows = main_window_candidates(candidates, self.gui.IsWindowVisible, self.gui.GetWindowText)
        if len(rows) != 1:
            raise InputError("INPUT_WINDOW_OR_ACCOUNT_AMBIGUOUS")
        return rows[0]

    def bind(self, executable):
        hwnd, pid, accounts = self.locate(executable)
        if self.hwnd is not None and hwnd != self.hwnd:
            raise InputError("INPUT_WINDOW_CHANGED")
        self.hwnd, self.pid = hwnd, pid
        try:
            hooks = hook_modules(self.modules(pid), os.path.dirname(executable))
        except Exception:
            raise InputError("INPUT_CLIENT_UNVERIFIED")
        return {"pid": pid, "version": self.file_version(executable), "databaseAccounts": accounts,
                "hookModules": hooks, "visible": bool(self.gui.IsWindowVisible(hwnd))}

    def user_active(self, idle_ms):
        info = self._last_input()
        return idle_ms > 0 and (self.api.GetTickCount() - info) & 0xFFFFFFFF < idle_ms

    def _last_input(self):
        class LASTINPUTINFO(self.ctypes.Structure):
            _fields_ = [("cbSize", self.wintypes.UINT), ("dwTime", self.wintypes.DWORD)]
        info = LASTINPUTINFO(self.ctypes.sizeof(LASTINPUTINFO), 0)
        if not self.user32.GetLastInputInfo(self.ctypes.byref(info)):
            raise InputError("INPUT_IDLE_UNAVAILABLE")
        return info.dwTime

    # --- foreground ----------------------------------------------------------
    def assert_foreground(self):
        if self.user32.GetForegroundWindow() != self.hwnd:
            raise InputError("INPUT_FOREGROUND_CHANGED")

    def _bring(self, hwnd):
        current = self.user32.GetForegroundWindow()
        this_thread = self.api.GetCurrentThreadId()
        target_thread = self.user32.GetWindowThreadProcessId(hwnd, None)
        foreground_thread = self.user32.GetWindowThreadProcessId(current, None) if current else 0
        attached = []
        for thread in {target_thread, foreground_thread} - {0, this_thread}:
            if self.user32.AttachThreadInput(this_thread, thread, True):
                attached.append(thread)
        try:
            self.user32.BringWindowToTop(hwnd)
            self.user32.SetForegroundWindow(hwnd)
        finally:
            for thread in attached:
                self.user32.AttachThreadInput(this_thread, thread, False)

    def activate(self):
        if self.gui.IsIconic(self.hwnd):
            self.gui.ShowWindow(self.hwnd, self.con.SW_RESTORE)
            time.sleep(0.3)
        for attempt in range(3):
            self._bring(self.hwnd)
            time.sleep(0.25)
            if self.user32.GetForegroundWindow() == self.hwnd:
                return
            if attempt == 0:
                # A lone Alt tap lets a background process take the foreground.
                self._keys([("alt", True), ("alt", False)])
        raise InputError("INPUT_FOREGROUND_DENIED")

    # --- keyboard ------------------------------------------------------------
    def _define_input(self):
        ctypes, wintypes = self.ctypes, self.wintypes
        ulong_ptr = ctypes.c_size_t
        class KEYBDINPUT(ctypes.Structure):
            _fields_ = [("wVk", wintypes.WORD), ("wScan", wintypes.WORD), ("dwFlags", wintypes.DWORD),
                        ("time", wintypes.DWORD), ("dwExtraInfo", ulong_ptr)]
        class MOUSEINPUT(ctypes.Structure):
            _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG), ("mouseData", wintypes.DWORD),
                        ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD), ("dwExtraInfo", ulong_ptr)]
        class UNION(ctypes.Union):
            _fields_ = [("ki", KEYBDINPUT), ("mi", MOUSEINPUT)]
        class INPUT(ctypes.Structure):
            _fields_ = [("type", wintypes.DWORD), ("u", UNION)]
        self.KEYBDINPUT, self.INPUT = KEYBDINPUT, INPUT
        self.user32.SendInput.argtypes = [wintypes.UINT, ctypes.POINTER(INPUT), ctypes.c_int]

    def _keys(self, steps):
        items = (self.INPUT * len(steps))()
        for index, (key, down) in enumerate(steps):
            items[index].type = 1
            flags = (0 if down else 0x0002) | (0x0001 if key in self.EXTENDED else 0)
            items[index].u.ki = self.KEYBDINPUT(self.VK[key], 0, flags, 0, 0)
        if self.user32.SendInput(len(steps), items, self.ctypes.sizeof(self.INPUT)) != len(steps):
            raise InputError("INPUT_KEYS_BLOCKED")

    def _combo(self, *keys):
        self.assert_foreground()
        self._keys([(key, True) for key in keys] + [(key, False) for key in reversed(keys)])

    # --- clipboard -----------------------------------------------------------
    def _open(self):
        for _ in range(20):
            try:
                self.clip.OpenClipboard()
                return
            except Exception:
                time.sleep(0.05)
        raise InputError("INPUT_CLIPBOARD_BUSY", retryable=True)

    def _set(self, items, tolerant=False):
        self._open()
        try:
            self.clip.EmptyClipboard()
            for fmt, data in items:
                if tolerant:
                    with contextlib.suppress(Exception):
                        self.clip.SetClipboardData(fmt, data)
                else:
                    self.clip.SetClipboardData(fmt, data)
        finally:
            self.clip.CloseClipboard()
        self.owned_sequence = self.user32.GetClipboardSequenceNumber()

    def _read_text(self):
        self._open()
        try:
            if self.clip.IsClipboardFormatAvailable(self.con.CF_UNICODETEXT):
                return self.clip.GetClipboardData(self.con.CF_UNICODETEXT)
            return None
        finally:
            self.clip.CloseClipboard()

    def _read_files(self):
        self._open()
        try:
            if self.clip.IsClipboardFormatAvailable(self.con.CF_HDROP):
                return list(self.clip.GetClipboardData(self.con.CF_HDROP))
            return None
        finally:
            self.clip.CloseClipboard()

    def _snapshot(self):
        """Copy the user's clipboard formats that can be restored as plain bytes/text."""
        saved = []
        skip = {2, 3, 9, 14}  # bitmap/metafile/palette handles
        self._open()
        try:
            fmt = self.clip.EnumClipboardFormats(0)
            while fmt:
                if fmt not in skip:
                    with contextlib.suppress(Exception):
                        data = self.clip.GetClipboardData(fmt)
                        if fmt == self.con.CF_HDROP:
                            data = self._dropfiles(list(data))
                        if isinstance(data, (bytes, str)):
                            saved.append((fmt, data))
                fmt = self.clip.EnumClipboardFormats(fmt)
        finally:
            self.clip.CloseClipboard()
        return saved

    @staticmethod
    def _dropfiles(paths):
        import struct
        header = struct.pack("<IiiII", 20, 0, 0, 0, 1)
        return header + ("\0".join(paths) + "\0\0").encode("utf-16-le")

    def _copy_selection(self):
        """Ctrl+A, Ctrl+C in the focused field; the sentinel survives when it is empty."""
        self.sentinel = "WeChatAgent-input-" + os.urandom(8).hex()
        self._set([(self.con.CF_UNICODETEXT, self.sentinel)])
        self._combo("ctrl", "a")
        time.sleep(0.12)
        self._combo("ctrl", "c")
        time.sleep(0.25)
        # Our own copy changed the clipboard; it still counts as ours for the restore.
        self.owned_sequence = self.user32.GetClipboardSequenceNumber()

    # --- chat operations ----------------------------------------------------
    @contextlib.contextmanager
    def session(self):
        previous = self.user32.GetForegroundWindow()
        saved = self._snapshot()
        try:
            yield
        finally:
            with contextlib.suppress(Exception):
                if self.owned_sequence is not None and self.user32.GetClipboardSequenceNumber() == self.owned_sequence:
                    if saved:
                        self._set(saved, tolerant=True)
                    else:
                        self._open()
                        try:
                            self.clip.EmptyClipboard()
                        finally:
                            self.clip.CloseClipboard()
            with contextlib.suppress(Exception):
                if previous and previous != self.hwnd and self.user32.IsWindow(previous) and self.user32.GetForegroundWindow() == self.hwnd:
                    self._bring(previous)

    def open_chat(self, name):
        self.assert_foreground()
        self._combo("ctrl", "f")
        time.sleep(0.5)
        self._combo("ctrl", "a")
        time.sleep(0.1)
        self._set([(self.con.CF_UNICODETEXT, name)])
        self._combo("ctrl", "v")
        time.sleep(0.7)
        self._combo("enter")
        time.sleep(0.9)

    def cancel_search(self):
        if self.user32.GetForegroundWindow() == self.hwnd:
            self._combo("escape")
            time.sleep(0.2)

    def draft(self):
        """Text of the focused input, or None when it is empty."""
        self._copy_selection()
        text = self._read_text()
        if text == self.sentinel:
            return None
        return text if text is not None else ""

    def paste_text(self, text):
        self._set([(self.con.CF_UNICODETEXT, text)])
        self._combo("ctrl", "v")
        time.sleep(min(len(text) * 0.002, 1.0) + 0.3)

    def paste_file(self, path):
        effect = self.clip.RegisterClipboardFormat("Preferred DropEffect")
        self._set([(self.con.CF_HDROP, self._dropfiles([path])), (effect, (1).to_bytes(4, "little"))])
        self._combo("ctrl", "v")
        time.sleep(1.2)

    def file_staged(self, path):
        self._copy_selection()
        files = self._read_files()
        if files is not None:
            return [os.path.normcase(item) for item in files] == [os.path.normcase(path)]
        return self._read_text() not in (None, self.sentinel)

    def submit(self, send_key):
        self._combo("ctrl", "end")
        time.sleep(0.08)
        if send_key == "ctrl-enter":
            self._combo("ctrl", "enter")
        else:
            self._combo("enter")
        time.sleep(0.5)

    def record_voice(self, play, duration, guard):
        if any(self.user32.GetAsyncKeyState(key) & 0x8000 for key in (0x10, 0x11, 0x12)):
            raise InputError("INPUT_MODIFIER_HELD", retryable=True)
        guard()
        self._keys([("right_alt", True)])
        try:
            time.sleep(0.05)
            input_tick = self._last_input().dwTime
            def recording_guard():
                guard()
                if self._last_input().dwTime != input_tick:
                    raise InputError("INPUT_USER_ACTIVE")
            time.sleep(0.30)
            recording_guard()
            play(recording_guard)
            time.sleep(max(0.35, 0.8 - duration))
            recording_guard()
        except Exception as error:
            code = error.code if isinstance(error, InputError) else "INPUT_VOICE_RECORDING_INTERRUPTED"
            raise InputError(code, attempted=True) from None
        finally:
            try:
                self._keys([("right_alt", False)])
            except InputError as error:
                raise InputError(error.code, attempted=True) from None

    def input_cleared(self):
        return self.draft() is None

    def discard_input(self):
        if self.user32.GetForegroundWindow() != self.hwnd:
            return
        self._combo("ctrl", "a")
        time.sleep(0.08)
        self._combo("delete")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--parent-pid", type=int, required=True)
    args = parser.parse_args()
    raw = sys.stdin.buffer.readline(MAX_REQUEST_BYTES + 1)
    if len(raw) > MAX_REQUEST_BYTES:
        raise InputError("INPUT_REQUEST_TOO_LARGE")
    request = json.loads(raw.decode("utf-8"))
    if sys.platform != "win32":
        raise InputError("INPUT_WINDOWS_REQUIRED")
    cancelled = threading.Event()
    if request.get("operation") == "voice":
        watch_parent(args.parent_pid, cancelled.set)
        def watch_pipe():
            try:
                os.read(sys.stdin.fileno(), 1)
            finally:
                cancelled.set()
        threading.Thread(target=watch_pipe, daemon=True).start()
    else:
        watch_parent(args.parent_pid)
    import ctypes
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_bool, ctypes.c_wchar_p]
    kernel.CreateMutexW.restype = ctypes.c_void_p
    kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_uint]
    kernel.ReleaseMutex.argtypes = [ctypes.c_void_p]
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    mutex = kernel.CreateMutexW(None, False, "Local\\WeChatAgent-Input-Sender-v1")
    if not mutex:
        raise InputError("INPUT_MUTEX_UNAVAILABLE")
    acquired = False
    try:
        acquired = kernel.WaitForSingleObject(mutex, 0) in (0, 128)
        if not acquired:
            raise InputError("INPUT_DESKTOP_BUSY", retryable=True)
        return execute(args.workspace.resolve(), request, WindowsInput(), cancelled.is_set)
    finally:
        if acquired:
            kernel.ReleaseMutex(mutex)
        kernel.CloseHandle(mutex)


if __name__ == "__main__":
    try:
        result = {"ok": True, "data": main()}
    except InputError as error:
        result = {"ok": False, "code": error.code, "attempted": error.attempted, "retryable": error.retryable}
    except Exception:
        result = {"ok": False, "code": "INPUT_OPERATION_FAILED", "attempted": False}
    sys.stdout.write(json.dumps(result, ensure_ascii=True))
