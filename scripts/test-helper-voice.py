import base64
import importlib.util
import json
import logging
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

MODULE = Path(__file__).resolve().parents[1] / "extensions/wechatagent_voice/__init__.py"
SPEC = importlib.util.spec_from_file_location("wechatagent_voice", MODULE)
bridge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bridge)

TOKEN = "a" * 64
ACCOUNT = "wxid_fixture"
OPERATION = "11111111-2222-4333-8444-555555555555"
CLIP = b"\x02#!SILK_V3\x02\x00\x12\x34"


class HelperVoiceTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.token_file = Path(self.temp.name) / "helper-voice.token"
        self.token_file.write_text(TOKEN, encoding="utf-8")
        self.calls = []
        self.backend = SimpleNamespace(self_wxid=ACCOUNT, session_id="session", wechat_version="4.2.0.12")
        self.ctx = SimpleNamespace(
            _service=SimpleNamespace(_backend=self.backend, _lock=threading.Lock(), _available=True),
            config={}, send_voice=self.send, logger=logging.getLogger("test-helper-voice"),
        )
        self.payload = {"wxidorgid": "filehelper", "operationId": OPERATION, "durationMs": 20,
                        "silkBase64": base64.b64encode(CLIP).decode()}

    def send(self, target, path, *, expected_session, delivery_guard):
        with delivery_guard():
            self.calls.append((target, Path(path).read_bytes(), expected_session))
        self.assertEqual(Path(path).suffix, ".silk")
        return True

    def request(self, path, body=None, *, token=TOKEN, account=ACCOUNT):
        headers = {"Authorization": "Bearer " + token, "X-WeChatAgent-Account": account}
        if body is not None:
            headers["Content-Type"] = "application/json"
        request = Request(self.url + path, data=None if body is None else json.dumps(body).encode(), headers=headers)
        try:
            response = urlopen(request, timeout=4)
        except HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response)

    def test_http_contract_checks_identity_and_replays_without_a_second_send(self):
        implementation = bridge.VoiceBridge(self.ctx, self.token_file)
        server = bridge.ThreadingHTTPServer(("127.0.0.1", 0), bridge.handler_for(implementation))
        self.addCleanup(server.server_close)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.shutdown)
        self.url = f"http://127.0.0.1:{server.server_port}"
        self.assertEqual(self.request("/WeChatAgent/health", token="wrong")[0], 401)
        self.assertEqual(self.request("/WeChatAgent/health")[1]["account"], ACCOUNT)
        self.assertEqual(self.request("/WeChatAgent/health")[1]["voiceTargets"], ["filehelper"])
        self.backend.wechat_version = "4.2.0.11"
        self.assertEqual(self.request("/WeChatAgent/health")[0], 503)
        self.backend.wechat_version = "4.2.0.12"
        self.assertEqual(self.request("/SendVoiceMsg", self.payload, account="wxid_wrong")[0], 409)
        self.assertEqual(self.request("/SendVoiceMsg", {**self.payload, "wxidorgid": "wxid_other"})[0], 403)
        self.assertEqual(self.request("/SendVoiceMsg", {**self.payload, "durationMs": 40})[0], 400)
        self.assertEqual(self.calls, [])
        result = (200, {"operationId": OPERATION, "target": "filehelper", "state": "accepted"})
        self.assertEqual(self.request("/SendVoiceMsg", self.payload), result)
        self.assertEqual(self.request("/WeChatAgent/voice-deliveries/" + OPERATION), result)
        self.assertEqual(self.request("/SendVoiceMsg", self.payload), result)
        self.assertEqual(self.calls, [("filehelper", CLIP, "session")])

    def test_allowed_friends_and_groups_keep_their_target_binding_across_restart(self):
        friend, group = "wxid_friend", "12345@chatroom"
        self.ctx.config["allowed_targets"] = [friend, group]
        implementation = bridge.VoiceBridge(self.ctx, self.token_file)
        self.assertEqual(implementation.send(ACCOUNT, {**self.payload, "wxidorgid": friend})["target"], friend)
        restarted = bridge.VoiceBridge(self.ctx, self.token_file)
        with self.assertRaises(bridge.RequestError) as error:
            restarted.send(ACCOUNT, {**self.payload, "wxidorgid": group})
        self.assertEqual(error.exception.status, 409)
        group_operation = "11111111-2222-4333-8444-555555555556"
        self.assertEqual(restarted.send(ACCOUNT, {
            **self.payload, "wxidorgid": group, "operationId": group_operation,
        })["target"], group)
        self.ctx.config["allowed_targets"] = [group]
        revoked = bridge.VoiceBridge(self.ctx, self.token_file)
        with self.assertRaises(bridge.RequestError) as error:
            revoked.receipt(ACCOUNT, OPERATION)
        self.assertEqual(error.exception.status, 403)
        self.assertEqual(self.calls, [(friend, CLIP, "session"), (group, CLIP, "session")])

    def test_uncertain_submission_survives_provider_restart(self):
        def lost_response(*args, **kwargs):
            self.send(*args, **kwargs)
            raise TimeoutError
        self.ctx.send_voice = lost_response
        implementation = bridge.VoiceBridge(self.ctx, self.token_file)
        self.assertEqual(implementation.send(ACCOUNT, self.payload)["state"], "uncertain")
        restarted = bridge.VoiceBridge(self.ctx, self.token_file)
        self.assertEqual(restarted.send(ACCOUNT, self.payload)["state"], "uncertain")
        self.assertEqual(len(self.calls), 1)
        changed = {**self.payload, "silkBase64": base64.b64encode(CLIP[:-1] + b"\x56").decode()}
        with self.assertRaises(bridge.RequestError) as error:
            restarted.send(ACCOUNT, changed)
        self.assertEqual(error.exception.status, 409)

    def test_legacy_records_remain_bound_to_filehelper(self):
        self.ctx.config["allowed_targets"] = ["filehelper", "wxid_friend"]
        implementation = bridge.VoiceBridge(self.ctx, self.token_file)
        implementation.send(ACCOUNT, self.payload)
        old_file = implementation.file(ACCOUNT, OPERATION)
        record = json.loads(old_file.read_text(encoding="utf-8"))
        del record["target"]
        old_file.write_text(json.dumps(record), encoding="utf-8")
        self.assertEqual(implementation.receipt(ACCOUNT, OPERATION)["target"], "filehelper")
        with self.assertRaises(bridge.RequestError) as error:
            implementation.send(ACCOUNT, {**self.payload, "wxidorgid": "wxid_friend"})
        self.assertEqual(error.exception.status, 409)
        self.assertEqual(len(self.calls), 1)


    def serve(self):
        implementation = bridge.VoiceBridge(self.ctx, self.token_file)
        server = bridge.ThreadingHTTPServer(("127.0.0.1", 0), bridge.handler_for(implementation))
        self.addCleanup(server.server_close)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.shutdown)
        self.url = f"http://127.0.0.1:{server.server_port}"
        return implementation

    def enable_text(self, result=True):
        texts = []
        def send_text(target, text, *, expected_session, delivery_guard):
            with delivery_guard():
                texts.append((target, text, expected_session))
            if isinstance(result, Exception):
                raise result
            return result
        self.ctx._service.send_text = send_text
        self.backend.send_text = lambda *args: True
        return texts

    def test_text_route_shares_targets_session_and_replay_with_voice(self):
        self.ctx.config["allowed_targets"] = ["filehelper", "wxid_friend"]
        self.serve()
        self.assertIs(self.request("/WeChatAgent/health")[1]["nativeTextSend"], False)
        operation = "c" * 64
        body = {"wxidorgid": "wxid_friend", "operationId": operation, "msg": "你好"}
        self.assertEqual(self.request("/SendTextMsg", body), (409, {"error": "HELPER_TEXT_UNSUPPORTED"}))
        texts = self.enable_text()
        self.assertIs(self.request("/WeChatAgent/health")[1]["nativeTextSend"], True)
        self.assertEqual(self.request("/SendTextMsg", body, token="b" * 64)[0], 401)
        self.assertEqual(self.request("/SendTextMsg", body, account="wxid_wrong")[0], 409)
        self.assertEqual(self.request("/SendTextMsg", {**body, "wxidorgid": "wxid_stranger"})[0], 403)
        self.assertEqual(self.request("/SendTextMsg", {**body, "operationId": OPERATION})[0], 400)
        self.assertEqual(self.request("/SendTextMsg", {**body, "msg": "字" * 342})[1], {"error": "HELPER_TEXT_TOO_LONG"})
        self.assertEqual(self.request("/SendTextMsg", {**body, "msg": "a\u0000b"})[0], 400)
        self.assertEqual(texts, [])
        accepted = (200, {"operationId": operation, "target": "wxid_friend", "state": "accepted", "ret": 0})
        self.assertEqual(self.request("/SendTextMsg", body), accepted)
        self.assertEqual(self.request("/SendTextMsg", body), accepted)
        self.assertEqual(self.request("/SendTextMsg", {**body, "msg": "别的内容"})[0], 409)
        self.assertEqual(texts, [("wxid_friend", "你好", "session")])
        # Text and voice records never collide even with related operation IDs.
        self.assertEqual(self.request("/SendVoiceMsg", self.payload)[0], 200)
        self.assertEqual(len(self.calls), 1)

    def test_an_uncertain_text_submit_is_reported_as_unconfirmed_and_never_resent(self):
        texts = self.enable_text(TimeoutError())
        self.serve()
        body = {"wxidorgid": "filehelper", "operationId": "d" * 64, "msg": "结果未知"}
        self.assertEqual(self.request("/SendTextMsg", body), (503, {"error": "HELPER_TEXT_UNCONFIRMED"}))
        self.assertEqual(self.request("/SendTextMsg", body), (503, {"error": "HELPER_TEXT_UNCONFIRMED"}))
        self.assertEqual(len(texts), 1)
        rejected = self.enable_text(False)
        restarted = bridge.VoiceBridge(self.ctx, self.token_file)
        self.assertEqual(restarted.send_text(ACCOUNT, {**body, "operationId": "e" * 64})["state"], "uncertain")
        self.assertEqual(len(rejected), 1)


if __name__ == "__main__":
    unittest.main()
