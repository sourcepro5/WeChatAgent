"""Private first-run discovery, credential verification and Windows key capture."""
import contextlib
import ctypes
from ctypes import wintypes
import io
import json
import os
import pathlib
import re
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'components' / 'weflow-cli' / 'scripts'))


class SetupError(Exception):
    pass


def emit(event):
    print(json.dumps(event, ensure_ascii=False), flush=True)


def progress(message):
    emit({'type': 'progress', 'message': message})


def discover_accounts(selected=''):
    roots = [pathlib.Path(selected)] if selected else []
    if not selected:
        home = pathlib.Path.home()
        documents = [home / 'Documents', home]
        for name in ('OneDrive', 'OneDriveConsumer', 'OneDriveCommercial'):
            if os.environ.get(name):
                documents.append(pathlib.Path(os.environ[name]) / 'Documents')
        if os.name == 'nt':
            import winreg
            for key, value in [('Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders', 'Personal'),
                               ('Software\\Tencent\\WeChat', 'FileSavePath'), ('Software\\Tencent\\Weixin', 'FileSavePath')]:
                try:
                    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key) as handle:
                        location = winreg.QueryValueEx(handle, value)[0]
                        if isinstance(location, str) and location not in ('', 'MyDocument:'):
                            documents.append(pathlib.Path(os.path.expandvars(location)))
                except OSError:
                    pass
        for folder in documents:
            roots.extend([folder, folder / 'xwechat_files', folder / 'WeChat Files'])
    accounts = {}
    for folder in roots:
        if folder.name.lower() == 'db_storage':
            folder = folder.parent
        try:
            candidates = [folder] if (folder / 'db_storage').is_dir() else [p for p in folder.iterdir() if p.is_dir()]
            for candidate in candidates:
                if not (candidate / 'db_storage').is_dir():
                    continue
                full = str(candidate.resolve())
                accounts[os.path.normcase(full)] = {'dbPath': full, 'myWxid': candidate.name,
                    'ready': (candidate / 'db_storage' / 'message' / 'message_0.db').is_file()
                        and (candidate / 'db_storage' / 'contact' / 'contact.db').is_file()}
        except OSError:
            continue
    return sorted(accounts.values(), key=lambda item: item['dbPath'].casefold())


class Blob(ctypes.Structure):
    _fields_ = [('cbData', wintypes.DWORD), ('pbData', ctypes.POINTER(ctypes.c_ubyte))]


def credential(value, protect=False):
    import base64
    if not protect and not value.startswith('userdpapi:'):
        if value.startswith('safe:'):
            raise SetupError('READER_SECRET_UNAVAILABLE')
        return value
    if os.name != 'nt':
        raise SetupError('READER_SECRET_UNAVAILABLE')
    try:
        data = value.encode('utf-8') if protect else base64.b64decode(value.split(':', 1)[1], validate=True)
        buffer = (ctypes.c_ubyte * len(data)).from_buffer_copy(data)
        source, output = Blob(len(data), buffer), Blob()
        crypt = ctypes.WinDLL('crypt32', use_last_error=True)
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.LocalFree.argtypes = [ctypes.c_void_p]
        kernel.LocalFree.restype = ctypes.c_void_p
        function = crypt.CryptProtectData if protect else crypt.CryptUnprotectData
        function.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
                             ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
        function.restype = wintypes.BOOL
        if not function(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(output)):
            raise SetupError('READER_SECRET_UNAVAILABLE')
        try:
            result = ctypes.string_at(output.pbData, output.cbData)
            return 'userdpapi:' + base64.b64encode(result).decode('ascii') if protect else result.decode('utf-8')
        finally:
            kernel.LocalFree(output.pbData)
    except (ValueError, OSError, UnicodeError):
        raise SetupError('READER_SECRET_UNAVAILABLE') from None


def verify_database(account, key):
    import nt_decrypt as nt
    message = pathlib.Path(account) / 'db_storage' / 'message' / 'message_0.db'
    contact = pathlib.Path(account) / 'db_storage' / 'contact' / 'contact.db'
    if not message.is_file() or not contact.is_file():
        raise SetupError('READER_DATABASE_MISSING')
    if not re.fullmatch(r'[0-9a-fA-F]{64}', key) or nt.verify_passphrase_native(key, str(message)) is not True:
        raise SetupError('READER_KEY_INVALID')
    # Read-only queries prove the runtime works as well as the page authentication.
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        try:
            try:
                nt.require_sqlcipher()
            except (RuntimeError, ImportError, OSError):
                raise SetupError('READER_DEPENDENCY_MISSING') from None
            contact_key, salt = nt.derive_database_key(str(contact), '', '', key)
            if not nt.load_contact_names(str(contact), contact_key, salt):
                raise SetupError('READER_DATABASE_UNREADABLE')
            pairs, failures = nt.connect_message_shards_detailed(str(message), '', '', key)
            try:
                if failures or not pairs:
                    raise SetupError('READER_DATABASE_UNREADABLE')
                for _, connection in pairs:
                    connection.execute('PRAGMA query_only=ON')
                    connection.execute('SELECT name FROM sqlite_master LIMIT 1').fetchone()
            finally:
                for _, connection in pairs:
                    connection.close()
        except (ImportError, OSError):
            raise SetupError('READER_DEPENDENCY_MISSING') from None
        except SetupError:
            raise
        except Exception:
            raise SetupError('READER_DATABASE_UNREADABLE') from None


def wechat_pids(executable):
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    class ProcessEntry(ctypes.Structure):
        _fields_ = [('dwSize', wintypes.DWORD), ('cntUsage', wintypes.DWORD), ('th32ProcessID', wintypes.DWORD),
                    ('th32DefaultHeapID', ctypes.c_size_t), ('th32ModuleID', wintypes.DWORD), ('cntThreads', wintypes.DWORD),
                    ('th32ParentProcessID', wintypes.DWORD), ('pcPriClassBase', wintypes.LONG),
                    ('dwFlags', wintypes.DWORD), ('szExeFile', wintypes.WCHAR * 260)]
    kernel.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    kernel.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel.Process32FirstW.argtypes = kernel.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessEntry)]
    kernel.Process32FirstW.restype = kernel.Process32NextW.restype = wintypes.BOOL
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    kernel.QueryFullProcessImageNameW.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL
    snapshot = kernel.CreateToolhelp32Snapshot(2, 0)
    if snapshot == ctypes.c_void_p(-1).value:
        raise SetupError('READER_KEY_ACCESS_DENIED')
    matches, denied = [], False
    try:
        entry = ProcessEntry(); entry.dwSize = ctypes.sizeof(entry)
        exists = kernel.Process32FirstW(snapshot, ctypes.byref(entry))
        while exists:
            if entry.szExeFile.casefold() == pathlib.Path(executable).name.casefold():
                process = kernel.OpenProcess(0x1000, False, entry.th32ProcessID)
                if process:
                    try:
                        size = wintypes.DWORD(32768); full = ctypes.create_unicode_buffer(size.value)
                        if kernel.QueryFullProcessImageNameW(process, 0, full, ctypes.byref(size)):
                            if os.path.normcase(os.path.abspath(full.value)) == os.path.normcase(os.path.abspath(executable)):
                                matches.append(entry.th32ProcessID)
                    finally:
                        kernel.CloseHandle(process)
                else:
                    denied = True
            exists = kernel.Process32NextW(snapshot, ctypes.byref(entry))
    finally:
        kernel.CloseHandle(snapshot)
    if not matches and denied:
        raise SetupError('READER_KEY_ACCESS_DENIED')
    return matches


def capture_key(executable, account, timeout=180, clock=time.monotonic, sleep=time.sleep, pids=wechat_pids, library=None):
    dll = ROOT / 'components' / 'weflow-cli' / 'resources' / 'key' / 'win32' / 'x64' / 'wx_key.dll'
    if library is None:
        try:
            library = ctypes.CDLL(str(dll))
            library.InitializeHook.argtypes = [wintypes.DWORD]; library.InitializeHook.restype = ctypes.c_bool
            library.PollKeyData.argtypes = [ctypes.c_void_p, ctypes.c_int]; library.PollKeyData.restype = ctypes.c_bool
            library.CleanupHook.argtypes = []; library.CleanupHook.restype = ctypes.c_bool
            library.GetStatusMessage.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.POINTER(ctypes.c_int)]
            library.GetStatusMessage.restype = ctypes.c_bool
            library.GetLastErrorMsg.argtypes = []; library.GetLastErrorMsg.restype = ctypes.c_char_p
        except (OSError, AttributeError):
            raise SetupError('READER_KEY_COMPONENT_MISSING') from None
    deadline = clock() + timeout
    attached = None; observed_process = False; seen = set(); buffer = ctypes.create_string_buffer(128)
    progress('正在连接匹配微信。请在微信中完成登录；已登录时可退出账号后重新登录，程序会等待。')
    try:
        while clock() < deadline:
            processes = pids(executable)
            if len(processes) > 1:
                raise SetupError('WECHAT_MULTIPLE_PROCESSES')
            pid = processes[0] if processes else None
            if attached and pid != attached:
                library.CleanupHook(); attached = None
            if not pid:
                if not observed_process:
                    raise SetupError('WECHAT_NOT_RUNNING')
                sleep(0.5); continue
            if attached is None:
                if not library.InitializeHook(pid):
                    error = library.GetLastErrorMsg() or b''
                    raise SetupError('READER_KEY_ACCESS_DENIED' if b'ACCESS_DENIED' in error or b'0xC0000022' in error else 'READER_SETUP_FAILED')
                attached = pid
                observed_process = True
            if library.PollKeyData(buffer, len(buffer)):
                key = buffer.value.decode('ascii', errors='ignore')
                if re.fullmatch(r'[0-9a-fA-F]{64}', key) and key not in seen:
                    seen.add(key)
                    try:
                        verify_database(account, key)
                        return key
                    except SetupError as error:
                        if str(error) != 'READER_KEY_INVALID':
                            raise
                        progress('检测到的密钥与所选账号不匹配。请登录该目录对应的微信账号，或等待本次结束后重新选择账号。')
            for _ in range(8):
                status = ctypes.create_string_buffer(512); level = ctypes.c_int()
                if not library.GetStatusMessage(status, len(status), ctypes.byref(level)):
                    break
            sleep(0.12)
    finally:
        library.CleanupHook()
    raise SetupError('READER_SETUP_TIMEOUT')


def connect(request):
    accounts = discover_accounts(request.get('dbPath', ''))
    selected = [a for a in accounts if a['myWxid'] == request.get('myWxid')]
    if len(selected) != 1:
        raise SetupError('READER_PATH_MISSING')
    account = selected[0]
    if not account['ready']:
        raise SetupError('READER_DATABASE_MISSING')
    key = ''
    try:
        key = credential(request.get('decryptKey', ''))
        if key:
            progress('正在验证当前账号的已有密钥与数据库…')
            verify_database(account['dbPath'], key)
    except SetupError as error:
        if not request.get('autoKey') or str(error) not in ('READER_SECRET_UNAVAILABLE', 'READER_KEY_INVALID'):
            raise
        key = ''
    if not key:
        if not request.get('autoKey'):
            raise SetupError('READER_KEY_REQUIRED')
        key = capture_key(request['wechatExecutable'], account['dbPath'])
    progress('数据库验证通过，正在安全保存读取凭据…')
    return {'type': 'result', 'ok': True, **account, 'protectedKey': credential(key, protect=True)}


def main():
    try:
        request = json.loads(sys.stdin.read(128001))
        if request.get('operation') == 'discover':
            emit({'type': 'result', 'ok': True, 'accounts': discover_accounts(request.get('dbPath', ''))})
        else:
            emit(connect(request))
    except SetupError as error:
        emit({'type': 'result', 'ok': False, 'code': str(error)})
    except (ImportError, OSError):
        emit({'type': 'result', 'ok': False, 'code': 'READER_DEPENDENCY_MISSING'})
    except Exception:
        emit({'type': 'result', 'ok': False, 'code': 'READER_SETUP_FAILED'})


if __name__ == '__main__':
    main()
