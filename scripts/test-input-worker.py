"""Desktop-free tests for scripts/input-worker.py: a fake backend drives execute()."""
import contextlib
import base64
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

_spec = importlib.util.spec_from_file_location("input_worker", Path(__file__).with_name("input-worker.py"))
worker = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(worker)

ACCOUNT = "wxid_a_1234"


class FakeDesktop:
    def __init__(self, *, hooks=(), visible=True, active=False, drafts=None, cleared=True, file_ok=True, change_pid=False):
        self.hooks, self.visible, self.active = list(hooks), visible, active
        self.drafts = list(drafts if drafts is not None else [None, "你好"])
        self.cleared, self.file_ok, self.change_pid = cleared, file_ok, change_pid
        self.calls = []
        self.binds = 0

    def bind(self, executable):
        self.binds += 1
        pid = 99 if self.change_pid and self.binds > 1 else 1
        return {"pid": pid, "version": "4.2.0.12", "databaseAccounts": [ACCOUNT], "hookModules": self.hooks, "visible": self.visible}

    def user_active(self, idle_ms):
        return self.active

    @contextlib.contextmanager
    def session(self):
        self.calls.append("session-start")
        try:
            yield
        finally:
            self.calls.append("session-end")

    def activate(self): self.calls.append("activate")
    def open_chat(self, name): self.calls.append(("open", name))
    def cancel_search(self): self.calls.append("cancel-search")
    def draft(self):
        self.calls.append("draft")
        return self.drafts.pop(0) if self.drafts else None
    def paste_text(self, text): self.calls.append(("paste", text))
    def paste_file(self, path): self.calls.append(("paste-file", path))
    def file_staged(self, path): return self.file_ok
    def assert_foreground(self): self.calls.append("foreground-ok")
    def submit(self, key): self.calls.append(("submit", key))
    def input_cleared(self): return self.cleared
    def discard_input(self): self.calls.append("discard")


class WorkerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "config").mkdir()
        (self.root / "client").mkdir()
        self.config = {
            "runtime": {"sender": "wechat-input"},
            "input": {"wechatExecutable": str(self.root / "client" / "Weixin.exe"), "sendKey": "enter"},
            "wechat": {"whitelist": {"private": ["123"], "groups": ["456"]}},
        }
        self.save()

    def tearDown(self):
        self.tmp.cleanup()

    def save(self):
        (self.root / "config" / "wechatagent.json").write_text(json.dumps(self.config), encoding="utf-8")

    def run_text(self, desktop, **request):
        payload = {"operation": "text", "account": ACCOUNT, "kind": "private", "target": "123", "name": "小明", "text": "你好", **request}
        return worker.execute(self.root, payload, desktop)

    def assertCode(self, code, fn, *, attempted=False, retryable=False):
        with self.assertRaises(worker.InputError) as caught:
            fn()
        self.assertEqual(caught.exception.code, code)
        self.assertEqual(caught.exception.attempted, attempted)
        self.assertEqual(caught.exception.retryable, retryable)

    def test_successful_send_checks_before_and_after_paste(self):
        desktop = FakeDesktop()
        self.assertEqual(self.run_text(desktop), {"ret": 0, "submitted": True, "receiptRequired": True})
        self.assertEqual(desktop.calls, ["session-start", "activate", ("open", "小明"), "draft", ("paste", "你好"), "draft",
                                         "foreground-ok", ("submit", "enter"), "session-end"])

    def test_health_never_touches_the_desktop(self):
        desktop = FakeDesktop()
        health = worker.execute(self.root, {"operation": "health", "account": ACCOUNT.upper()}, desktop)
        self.assertEqual((health["backend"], health["ocr"], health["mouse"], health["hookLoaded"], health["ready"]), ("wechat-input", False, False, False, True))
        self.assertEqual(desktop.calls, [])

    def test_voice_requires_explicit_opt_in_and_only_accepts_filehelper(self):
        payload = {"operation": "voice", "account": ACCOUNT, "kind": "private", "target": "123", "wxid": "filehelper",
                   "name": "文件传输助手", "pcmBase64": base64.b64encode(bytes(3200)).decode()}
        desktop = FakeDesktop()
        self.assertCode("INPUT_VOICE_UNSUPPORTED", lambda: worker.execute(self.root, payload, desktop))
        self.config["input"]["voiceSend"] = True
        self.save()
        self.assertCode("INPUT_VOICE_FILEHELPER_ONLY",
                        lambda: worker.execute(self.root, {**payload, "name": "好友"}, desktop))
        self.assertEqual(desktop.calls, [])
        cable = Mock()
        playback = Mock()
        cable.prepare.side_effect = lambda _: contextlib.nullcontext(playback)
        desktop = FakeDesktop(drafts=[None])
        desktop.record_voice = Mock(side_effect=lambda play, duration, guard: play(guard))
        with patch.object(worker, "VoiceCable", return_value=cable):
            self.assertTrue(worker.execute(self.root, payload, desktop)["submitted"])
        self.assertEqual(desktop.record_voice.call_args.args[1], 0.1)
        playback.assert_called_once()

    def test_voice_always_releases_record_key_when_playback_is_interrupted(self):
        desktop = worker.WindowsInput.__new__(worker.WindowsInput)
        desktop.user32 = SimpleNamespace(GetAsyncKeyState=lambda _: 0)
        desktop._last_input = lambda: SimpleNamespace(dwTime=100)
        desktop._keys = Mock()
        play = Mock(side_effect=worker.VoiceOutputError("VOICE_CABLE_PLAYBACK_FAILED"))
        with patch.object(worker.time, "sleep"):
            self.assertCode("INPUT_VOICE_RECORDING_INTERRUPTED",
                            lambda: desktop.record_voice(play, 1, lambda: None), attempted=True)
        self.assertEqual([call.args[0] for call in desktop._keys.call_args_list],
                         [[("right_alt", True)], [("right_alt", False)]])

    def test_hooked_or_proxy_clients_are_refused(self):
        self.assertCode("INPUT_CLIENT_HAS_HOOK", lambda: self.run_text(FakeDesktop(hooks=["wechatagent-text-4.2.0.12.dll"])))
        (self.root / "client" / "version.dll").write_bytes(b"")
        self.assertCode("INPUT_CLIENT_HAS_PROXY_DLL", lambda: self.run_text(FakeDesktop()))

    def test_permission_pause_and_user_activity_stop_before_any_keystroke(self):
        desktop = FakeDesktop()
        self.assertCode("INPUT_TARGET_NOT_ALLOWED", lambda: self.run_text(desktop, target="999"))
        self.assertCode("INPUT_TARGET_NOT_ALLOWED", lambda: self.run_text(desktop, kind="group"))
        self.assertCode("INPUT_USER_ACTIVE", lambda: self.run_text(FakeDesktop(active=True)), retryable=True)
        self.assertCode("INPUT_WINDOW_NOT_VISIBLE", lambda: self.run_text(FakeDesktop(visible=False)))
        self.config["input"]["paused"] = True
        self.save()
        self.assertCode("INPUT_PAUSED", lambda: self.run_text(desktop), retryable=True)
        self.assertEqual(desktop.calls, [])
        self.assertCode("INPUT_ACCOUNT_MISMATCH", lambda: worker.execute(self.root, {"operation": "health", "account": "other"}, FakeDesktop()))

    def test_a_user_draft_is_left_untouched(self):
        desktop = FakeDesktop(drafts=["我还没写完"])
        self.assertCode("INPUT_DRAFT_PRESENT", lambda: self.run_text(desktop))
        self.assertNotIn("discard", desktop.calls)
        self.assertFalse(any(isinstance(call, tuple) and call[0] in ("paste", "submit") for call in desktop.calls))

    def test_search_without_result_closes_search_and_stops(self):
        desktop = FakeDesktop(drafts=["小明"])
        self.assertCode("INPUT_TARGET_NOT_FOUND", lambda: self.run_text(desktop))
        self.assertIn("cancel-search", desktop.calls)
        self.assertNotIn("discard", desktop.calls)

    def test_mismatched_paste_is_discarded_and_never_submitted(self):
        desktop = FakeDesktop(drafts=[None, "你"])
        self.assertCode("INPUT_CONTENT_MISMATCH", lambda: self.run_text(desktop))
        self.assertIn("discard", desktop.calls)
        self.assertFalse(any(isinstance(call, tuple) and call[0] == "submit" for call in desktop.calls))

    def test_changes_after_paste_are_rechecked_before_submit(self):
        desktop = FakeDesktop(change_pid=True)
        self.assertCode("INPUT_ACCOUNT_CHANGED", lambda: self.run_text(desktop))
        self.assertIn("discard", desktop.calls)

        class Revoking(FakeDesktop):
            def paste_text(inner, text):
                super().paste_text(text)
                self.config["wechat"]["whitelist"]["private"] = []
                self.save()
        revoking = Revoking()
        self.assertCode("INPUT_TARGET_NOT_ALLOWED", lambda: self.run_text(revoking))
        self.assertIn("discard", revoking.calls)

    def test_submit_without_cleared_input_is_attempted_and_receipt_only(self):
        desktop = FakeDesktop(cleared=False)
        self.assertCode("INPUT_SUBMIT_UNCONFIRMED", lambda: self.run_text(desktop), attempted=True)
        self.assertNotIn("discard", desktop.calls)

    def test_crlf_text_matches_after_round_trip_and_ctrl_enter_is_used(self):
        self.config["input"]["sendKey"] = "ctrl-enter"
        self.save()
        desktop = FakeDesktop(drafts=[None, "第一行\r\n第二行"])
        self.run_text(desktop, text="第一行\n第二行")
        self.assertIn(("submit", "ctrl-enter"), desktop.calls)

    def test_files_must_come_from_the_outbox_and_not_be_media(self):
        outbox = self.root / "state" / "files" / "outgoing"
        outbox.mkdir(parents=True)
        document = outbox / "a.pdf"
        document.write_bytes(b"pdf")
        import hashlib
        md5 = hashlib.md5(b"pdf").hexdigest()
        base = {"operation": "file", "account": ACCOUNT, "kind": "private", "target": "123", "name": "小明", "size": 3, "md5": md5}
        desktop = FakeDesktop(drafts=[None])
        self.assertEqual(worker.execute(self.root, {**base, "path": str(document)}, desktop)["submitted"], True)
        self.assertIn(("paste-file", str(document.resolve())), desktop.calls)
        image = outbox / "a.png"
        image.write_bytes(b"pdf")
        self.assertCode("INPUT_MEDIA_UNSUPPORTED", lambda: worker.execute(self.root, {**base, "path": str(image)}, FakeDesktop()))
        outside = self.root / "a.pdf"
        outside.write_bytes(b"pdf")
        self.assertCode("INPUT_FILE_OUTSIDE_OUTBOX", lambda: worker.execute(self.root, {**base, "path": str(outside)}, FakeDesktop()))
        self.assertCode("INPUT_FILE_CHANGED", lambda: worker.execute(self.root, {**base, "path": str(document), "md5": "0" * 32}, FakeDesktop()))
        self.assertCode("INPUT_CONTENT_MISMATCH", lambda: worker.execute(self.root, {**base, "path": str(document)}, FakeDesktop(drafts=[None], file_ok=False)))

    def test_open_dry_run_never_pastes_or_submits(self):
        desktop = FakeDesktop(drafts=[None])
        self.assertEqual(self.run_text(desktop, operation="open"), {"opened": True, "draftPresent": False, "submitted": False})
        self.assertEqual(desktop.calls, ["session-start", "activate", ("open", "小明"), "draft", "session-end"])
        self.assertCode("INPUT_TARGET_NOT_FOUND", lambda: self.run_text(FakeDesktop(drafts=["小明"]), operation="open"))

    def test_hook_module_and_window_helpers(self):
        client = str(self.root / "client")
        self.assertEqual(worker.hook_modules([client + "\\Weixin.dll", "C:\\x\\wechatagent-text-4.2.0.12.dll"], client), ["wechatagent-text-4.2.0.12.dll"])
        self.assertEqual(worker.hook_modules([client + "\\version.dll", "C:\\Windows\\System32\\version.dll"], client), ["version.dll"])
        self.assertEqual(worker.hook_modules(["C:\\Windows\\System32\\version.dll"], client), [])
        rows = [(1, 7, ["a"]), (2, 7, ["a"])]
        self.assertEqual(worker.main_window_candidates(rows, lambda hwnd: hwnd == 2, lambda hwnd: ""), [(2, 7, ["a"])])
        self.assertEqual(worker.main_window_candidates(rows, lambda hwnd: True, lambda hwnd: "微信" if hwnd == 1 else "图片"), [(1, 7, ["a"])])
        self.assertEqual(len(worker.main_window_candidates(rows, lambda hwnd: True, lambda hwnd: "微信")), 2)


if __name__ == "__main__":
    unittest.main()
