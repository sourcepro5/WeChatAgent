"""Loopback bridge to Helper's text and voice SDK for explicitly authorized chats."""
import base64
import contextlib
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import tempfile
import threading
import uuid

VERSION = "4.2.0.12"
INTEGRATION = "WeChatAgent-Helper-Voice-1"
SILK_HEADER = b"\x02#!SILK_V3"
MAX_SILK = 2 * 1024 * 1024
MAX_BODY = 4 * ((MAX_SILK + 2) // 3) + 1024
OPERATION = re.compile(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}")
# Text operations reuse WeChatAgent's 64-hex text delivery key.
TEXT_OPERATION = re.compile(r"[a-f0-9]{64}")
# Helper splits longer text into several messages; one request stays one message.
MAX_TEXT_BYTES = 1023
TARGET = re.compile(r"[A-Za-z0-9_.-]{1,128}(?:@chatroom)?")
DEFAULT_TARGET = "filehelper"
RECEIPT_PREFIX = "/WeChatAgent/voice-deliveries/"


class RequestError(Exception):
    def __init__(self, status, code):
        self.status, self.code = status, code


def read_audio(body):
    if not isinstance(body, dict):
        raise RequestError(400, "VOICE_INVALID_REQUEST")
    target = body.get("wxidorgid")
    if not isinstance(target, str) or not TARGET.fullmatch(target):
        raise RequestError(400, "VOICE_INVALID_TARGET")
    operation = body.get("operationId")
    if not isinstance(operation, str) or not OPERATION.fullmatch(operation):
        raise RequestError(400, "VOICE_INVALID_OPERATION")
    try:
        audio = base64.b64decode(body.get("silkBase64", ""), validate=True)
    except (ValueError, TypeError):
        raise RequestError(400, "VOICE_INVALID_SILK") from None
    if not audio.startswith(SILK_HEADER) or len(audio) > MAX_SILK:
        raise RequestError(400, "VOICE_INVALID_SILK")
    cursor, frames = len(SILK_HEADER), 0
    while cursor < len(audio):
        size = int.from_bytes(audio[cursor:cursor + 2], "little")
        cursor += size + 2
        frames += 1
        if not size or cursor > len(audio) or frames > 3000:
            raise RequestError(400, "VOICE_INVALID_SILK")
    duration = body.get("durationMs")
    if not frames or type(duration) is not int or duration != frames * 20:
        raise RequestError(400, "VOICE_INVALID_DURATION")
    return operation, target, audio


def read_text(body):
    if not isinstance(body, dict):
        raise RequestError(400, "VOICE_INVALID_REQUEST")
    target = body.get("wxidorgid")
    if not isinstance(target, str) or not TARGET.fullmatch(target):
        raise RequestError(400, "VOICE_INVALID_TARGET")
    operation = body.get("operationId")
    if not isinstance(operation, str) or not TEXT_OPERATION.fullmatch(operation):
        raise RequestError(400, "VOICE_INVALID_OPERATION")
    text = body.get("msg")
    if not isinstance(text, str) or not text.strip() or "\0" in text:
        raise RequestError(400, "HELPER_TEXT_INVALID")
    if len(text.encode("utf-8")) > MAX_TEXT_BYTES:
        raise RequestError(400, "HELPER_TEXT_TOO_LONG")
    return operation, target, text


class VoiceBridge:
    def __init__(self, ctx, token_file):
        self.ctx = ctx
        targets = ctx.config.get("allowed_targets", [DEFAULT_TARGET])
        if not isinstance(targets, list) or len(targets) > 500 or any(
                not isinstance(target, str) or not TARGET.fullmatch(target) for target in targets):
            raise ValueError("VOICE_HELPER_TARGETS_INVALID")
        self.targets = frozenset(targets)
        self.token = token_file.read_text(encoding="utf-8-sig").strip()
        if not re.fullmatch(r"[a-f0-9]{64}", self.token):
            raise ValueError("VOICE_HELPER_TOKEN_INVALID")
        self.directory = token_file.parent / "helper-voice-operations"
        self.closing = threading.Event()
        self.sending = threading.Lock()

    def identity(self, expected=None):
        # The SDK pins sends by session. Read the live identity from the same
        # connection object since PluginContext has no public identity getter.
        service = self.ctx._service
        with service._lock:
            backend = service._backend
            if self.closing.is_set() or not service._available or backend is None:
                raise RequestError(503, "VOICE_HELPER_NOT_READY")
            account = getattr(backend, "self_wxid", None)
            session = getattr(backend, "session_id", None)
            if getattr(backend, "wechat_version", None) != VERSION or not account or not session:
                raise RequestError(503, "VOICE_HELPER_BUILD_UNSUPPORTED")
            if expected is not None and account != expected:
                raise RequestError(409, "VOICE_HELPER_ACCOUNT_MISMATCH")
            return account, session

    def file(self, account, operation, kind="voice"):
        name = account + "\0" + operation if kind == "voice" else account + "\0text\0" + operation
        return self.directory / (hashlib.sha256(name.encode()).hexdigest() + ".json")

    def text_capable(self):
        service = self.ctx._service
        with service._lock:
            return callable(getattr(service._backend, "send_text", None)) and callable(getattr(service, "send_text", None))

    def require_target(self, target):
        if target not in self.targets:
            raise RequestError(403, "VOICE_HELPER_TARGET_NOT_ALLOWED")

    def receipt(self, account, operation):
        if not OPERATION.fullmatch(operation):
            raise RequestError(400, "VOICE_INVALID_OPERATION")
        account, _ = self.identity(account)
        try:
            record = json.loads(self.file(account, operation).read_text(encoding="utf-8"))
        except FileNotFoundError:
            raise RequestError(404, "VOICE_DELIVERY_NOT_FOUND") from None
        target = record.get("target", DEFAULT_TARGET)
        self.require_target(target)
        return {"operationId": operation, "target": target, "state": record["state"]}

    @contextlib.contextmanager
    def dispatch_guard(self):
        if self.closing.is_set():
            raise RequestError(503, "VOICE_HELPER_NOT_READY")
        yield

    def send(self, account, body):
        operation, target, audio = read_audio(body)
        self.require_target(target)
        account, session = self.identity(account)
        digest = hashlib.sha256(audio).hexdigest()
        if not self.sending.acquire(blocking=False):
            raise RequestError(429, "VOICE_HELPER_BUSY")
        try:
            return self.submit(account, session, operation, target, audio, digest)
        finally:
            self.sending.release()

    def send_text(self, account, body):
        operation, target, text = read_text(body)
        self.require_target(target)
        account, session = self.identity(account)
        if not self.text_capable():
            raise RequestError(409, "HELPER_TEXT_UNSUPPORTED")
        if not self.sending.acquire(blocking=False):
            raise RequestError(429, "VOICE_HELPER_BUSY")
        try:
            return self.submit_text(account, session, operation, target, text)
        finally:
            self.sending.release()

    def submit_text(self, account, session, operation, target, text):
        self.directory.mkdir(parents=True, exist_ok=True)
        dest = self.file(account, operation, "text")
        digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
        record = {"kind": "text", "target": target, "state": "submitting", "sha256": digest}
        try:
            with dest.open("x", encoding="utf-8") as stream:
                json.dump(record, stream)
                stream.flush()
                os.fsync(stream.fileno())
        except FileExistsError:
            previous = json.loads(dest.read_text(encoding="utf-8"))
            if previous["sha256"] != digest or previous.get("target") != target:
                raise RequestError(409, "VOICE_OPERATION_CONFLICT") from None
            return {"operationId": operation, "target": target, "state": previous["state"]}
        accepted = False
        try:
            # PluginContext.send_text has no session pin; the service call does.
            accepted = self.ctx._service.send_text(
                target, text, expected_session=session, delivery_guard=self.dispatch_guard,
            ) is not False
        except Exception:
            # The SDK may have accepted the request before raising or disconnecting.
            self.ctx.logger.warning("WeChatAgent text submission is unconfirmed")
        record["state"] = "accepted" if accepted else "uncertain"
        temp = dest.with_suffix("." + uuid.uuid4().hex + ".tmp")
        try:
            with temp.open("x", encoding="utf-8") as stream:
                json.dump(record, stream)
                stream.flush()
                os.fsync(stream.fileno())
            temp.replace(dest)
        finally:
            temp.unlink(missing_ok=True)
        return {"operationId": operation, "target": target, "state": record["state"]}

    def submit(self, account, session, operation, target, audio, digest):
        self.directory.mkdir(parents=True, exist_ok=True)
        dest = self.file(account, operation)
        record = {"target": target, "state": "submitting", "sha256": digest}
        try:
            with dest.open("x", encoding="utf-8") as stream:
                json.dump(record, stream)
                stream.flush()
                os.fsync(stream.fileno())
        except FileExistsError:
            previous = json.loads(dest.read_text(encoding="utf-8"))
            if previous["sha256"] != digest or previous.get("target", DEFAULT_TARGET) != target:
                raise RequestError(409, "VOICE_OPERATION_CONFLICT") from None
            return {"operationId": operation, "target": target, "state": previous["state"]}

        accepted = False
        try:
            with tempfile.TemporaryDirectory(prefix="wechatagent-voice-") as folder:
                clip = Path(folder) / "voice.silk"
                clip.write_bytes(audio)
                accepted = self.ctx.send_voice(
                    target, str(clip), expected_session=session, delivery_guard=self.dispatch_guard,
                ) is True
        except Exception:
            # The SDK may have accepted the request before raising or disconnecting.
            self.ctx.logger.warning("WeChatAgent voice submission is unconfirmed")
        record["state"] = "accepted" if accepted else "uncertain"
        temp = dest.with_suffix("." + uuid.uuid4().hex + ".tmp")
        try:
            with temp.open("x", encoding="utf-8") as stream:
                json.dump(record, stream)
                stream.flush()
                os.fsync(stream.fileno())
            temp.replace(dest)
        finally:
            temp.unlink(missing_ok=True)
        return {"operationId": operation, "target": target, "state": record["state"]}


def handler_for(bridge):
    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            self.request.settimeout(8)
            super().setup()

        def log_message(self, *_):
            pass

        def respond(self, status, value):
            data = json.dumps(value).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def run_request(self, action):
            try:
                auth = self.headers.get("Authorization", "").encode("utf-8")
                if not hmac.compare_digest(auth, ("Bearer " + bridge.token).encode()):
                    raise RequestError(401, "VOICE_UNAUTHORIZED")
                result = action()
            except RequestError as error:
                self.respond(error.status, {"error": error.code})
            except Exception:
                self.respond(503, {"error": "VOICE_HELPER_UNAVAILABLE"})
            else:
                self.respond(200, result)

        def do_GET(self):
            def get():
                if self.path == "/WeChatAgent/health":
                    account, _ = bridge.identity()
                    return {"integration": INTEGRATION, "nativeVoiceSend": True, "nativeTextSend": bridge.text_capable(),
                            "version": VERSION, "account": account, "voiceTargets": sorted(bridge.targets)}
                if self.path.startswith(RECEIPT_PREFIX):
                    return bridge.receipt(self.account(), self.path[len(RECEIPT_PREFIX):])
                raise RequestError(404, "VOICE_ROUTE_NOT_FOUND")
            self.run_request(get)

        def account(self):
            value = self.headers.get("X-WeChatAgent-Account", "")
            if not value:
                raise RequestError(400, "VOICE_HELPER_ACCOUNT_REQUIRED")
            return value

        def do_POST(self):
            def post():
                if self.path not in ("/SendVoiceMsg", "/SendTextMsg"):
                    raise RequestError(404, "VOICE_ROUTE_NOT_FOUND")
                account = self.account()
                if self.headers.get_content_type() != "application/json":
                    raise RequestError(415, "VOICE_JSON_REQUIRED")
                length = self.headers.get("Content-Length", "")
                if not re.fullmatch(r"[0-9]{1,8}", length):
                    raise RequestError(411, "VOICE_LENGTH_REQUIRED")
                if not 0 < int(length) <= MAX_BODY:
                    raise RequestError(413, "VOICE_TOO_LARGE")
                raw = self.rfile.read(int(length))
                if len(raw) != int(length):
                    raise RequestError(400, "VOICE_INVALID_REQUEST")
                try:
                    body = json.loads(raw)
                except (UnicodeDecodeError, ValueError):
                    raise RequestError(400, "VOICE_INVALID_REQUEST") from None
                if self.path == "/SendTextMsg":
                    result = bridge.send_text(account, body)
                    # Only an accepted submit is a success; anything else must be checked by receipt.
                    if result["state"] != "accepted":
                        raise RequestError(503, "HELPER_TEXT_UNCONFIRMED")
                    return {**result, "ret": 0}
                return bridge.send(account, body)
            self.run_request(post)

    return Handler


class Plugin:
    def on_load(self, ctx):
        token_file = Path(ctx.config["token_file"])
        port = ctx.config.get("port", 8777)
        if not token_file.is_absolute() or type(port) is not int or not 1 <= port <= 65535:
            raise ValueError("VOICE_HELPER_CONFIG_INVALID")
        self.bridge = VoiceBridge(ctx, token_file)
        self.server = ThreadingHTTPServer(("127.0.0.1", port), handler_for(self.bridge))
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.1}, daemon=True)
        self.thread.start()

    def on_message(self, message, ctx):
        pass

    def on_unload(self, ctx):
        if hasattr(self, "bridge"):
            self.bridge.closing.set()
        if hasattr(self, "server"):
            if getattr(self, "thread", None) and self.thread.is_alive():
                self.server.shutdown()
            self.server.server_close()
