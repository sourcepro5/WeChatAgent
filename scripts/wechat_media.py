"""Local-only media helpers copied from weflow-cli 3d56da9 (MIT).

Only image codec and verified local key lookup are retained. This module has
no export UI, remote fetching, process-memory access, or persistent secrets.
Original license: components/weflow-cli/LICENSE.
"""
import os
import re
import struct
import hashlib
import json
from pathlib import Path
MAX_EMBED_SIZE = 8 * 1024 * 1024
MAX_IMAGE_SOURCE_SIZE = 32 * 1024 * 1024
IMAGE_SOURCE_VERSION = 2
V2_MAGIC = b"\x07\x08V2\x08\x07"
V2_CIPHERTEXT_START = 15


def clean_account_wxid(value):
    value = str(value or '').strip()
    parts = value.rsplit('_', 1)
    if len(parts) == 2 and len(parts[1]) == 4 and parts[1].isalnum():
        return parts[0]
    return value

def resolve_v2_media_key(account_dir, own_wxid='', kvcomm_dir=''):
    """Derive and verify the local WeChat V2 image key without persisting it."""
    if not account_dir:
        return None
    if not kvcomm_dir:
        appdata = os.environ.get('APPDATA', '')
        kvcomm_dir = os.path.join(appdata, 'Tencent', 'xwechat', 'net', 'kvcomm')
    try:
        codes = sorted({
            int(match.group(1))
            for name in os.listdir(kvcomm_dir)
            if (match := re.fullmatch(r'key_(\d+)_.+\.statistic', name, re.IGNORECASE))
        })
    except (OSError, ValueError):
        return None
    if not codes:
        return None

    templates = []
    for root in ('msg', 'cache', 'resource'):
        search_root = os.path.join(account_dir, root)
        if not os.path.isdir(search_root):
            continue
        for current_root, _, files in os.walk(search_root):
            for name in files:
                if not name.lower().endswith('_t.dat'):
                    continue
                path = os.path.join(current_root, name)
                try:
                    with open(path, 'rb') as stream:
                        header = stream.read(V2_CIPHERTEXT_START + 16)
                    if header.startswith(V2_MAGIC) and len(header) >= V2_CIPHERTEXT_START + 16:
                        templates.append(header[V2_CIPHERTEXT_START:V2_CIPHERTEXT_START + 16])
                except OSError:
                    continue
                if len(templates) >= 32:
                    break
            if len(templates) >= 32:
                break
        if len(templates) >= 32:
            break
    if not templates:
        return None

    wxids = list(dict.fromkeys(filter(None, (
        clean_account_wxid(own_wxid),
        clean_account_wxid(Path(account_dir).name),
    ))))
    try:
        from Crypto.Cipher import AES
    except ImportError:
        return None
    for wxid in wxids:
        for code in codes:
            aes_key = hashlib.md5(f'{code}{wxid}'.encode()).hexdigest()[:16].encode('ascii')
            try:
                plaintext = AES.new(aes_key, AES.MODE_ECB).decrypt(templates[0])
            except (TypeError, ValueError):
                continue
            if detect_mime_from_bytes(plaintext) or plaintext.startswith((b'wxgf', b'WXGF')):
                return code & 0xff, aes_key
    return None

def decode_wechat_v2(filepath, xor_key, aes_key, max_size=MAX_EMBED_SIZE):
    try:
        from Crypto.Cipher import AES
        from Crypto.Util import Padding
        with open(filepath, 'rb') as stream:
            data = stream.read(max_size + 1)
        if len(data) > max_size or not data.startswith(V2_MAGIC):
            return None
        signature, aes_size, xor_size = struct.unpack('<6sLLx', data[:V2_CIPHERTEXT_START])
        if signature != V2_MAGIC:
            return None
        encrypted_size = aes_size + 16 - aes_size % 16
        encrypted = data[V2_CIPHERTEXT_START:V2_CIPHERTEXT_START + encrypted_size]
        decrypted = Padding.unpad(AES.new(aes_key, AES.MODE_ECB).decrypt(encrypted), 16)
        remainder = data[V2_CIPHERTEXT_START + encrypted_size:]
        if xor_size:
            if xor_size > len(remainder):
                return None
            raw = remainder[:-xor_size]
            tail = bytes(value ^ xor_key for value in remainder[-xor_size:])
        else:
            raw, tail = remainder, b''
        output = decrypted + raw + tail
        mime = detect_mime_from_bytes(output[:16]) or ('image/x-wxgf' if output[:4].lower() == b'wxgf' else None)
        return (output, mime) if mime else None
    except (OSError, ValueError, struct.error):
        return None


def read_plain_image(filepath, max_size=MAX_IMAGE_SOURCE_SIZE):
    """Read an already-decrypted image file (WeChat ImageTemp temp copies are plain JPEG)."""
    try:
        with open(filepath, 'rb') as stream:
            head = stream.read(16)
            if not (head.startswith(b'\xff\xd8') or head.startswith(b'\x89PNG') or head.startswith(b'GIF8') or head[:4].lower() == b'wxgf'):
                return None
            stream.seek(0)
            data = stream.read(max_size + 1)
        if len(data) > max_size:
            return None
        mime = detect_mime_from_bytes(data[:16]) or ('image/x-wxgf' if data[:4].lower() == b'wxgf' else None)
        return (data, mime) if mime else None
    except OSError:
        return None


def local_image_temp_candidates(account, talker, local_id, create_time):
    """WeChat writes the freshly downloaded original into cache/<month>/Message/<md5(talker)>/ImageTemp."""
    result = []
    try:
        local_id = int(local_id)
        create_time = int(create_time)
    except (TypeError, ValueError):
        return result
    if local_id <= 0 or create_time <= 0:
        return result
    import datetime
    month = datetime.datetime.fromtimestamp(create_time).strftime('%Y-%m')
    folder = Path(account) / 'cache' / month / 'Message' / hashlib.md5(talker.encode()).hexdigest() / 'ImageTemp'
    for suffix, thumb in (('_mid_temp', False), ('_thumb_temp', True)):
        file = folder / f'{local_id}_{create_time}{suffix}'
        try:
            info = file.stat()
        except OSError:
            continue
        if 0 < info.st_size <= MAX_IMAGE_SOURCE_SIZE:
            result.append((file, thumb, info.st_size, info.st_mtime_ns))
    return result


def local_image_candidates(account, talker, ids, local_id=None, create_time=None):
    """Find only message-bound files in this conversation, full copies first."""
    wanted = {value.lower() for value in ids if isinstance(value, str) and re.fullmatch(r'[a-fA-F0-9]{32}', value)}
    attach = Path(account) / 'msg' / 'attach' / hashlib.md5(talker.encode()).hexdigest()
    result = list(local_image_temp_candidates(account, talker, local_id, create_time))
    if not wanted or not attach.is_dir():
        return result
    # Enumerate names once per bucket, rather than issuing thousands of stat
    # calls for the sliding binary resource-ID candidates.
    for month in sorted(attach.iterdir(), reverse=True):
        folder = month / 'Img'
        if not folder.is_dir():
            continue
        with os.scandir(folder) as entries:
            for entry in entries:
                match = re.fullmatch(r'([a-f0-9]{32})(_h|_t)?\.dat', entry.name, re.IGNORECASE)
                if not match or match[1].lower() not in wanted or not entry.is_file():
                    continue
                try:
                    info = entry.stat()
                except OSError:
                    continue  # A downloading file can disappear between scans.
                result.append((Path(entry.path), (match[2] or '').lower() == '_t', info.st_size, info.st_mtime_ns))
    return sorted(result, key=lambda item: (item[1], -item[2], str(item[0])))


def image_source_fingerprint(account, candidates):
    """Notice newly downloaded originals and updated message-resource mappings."""
    account = Path(account)
    state = [(str(p.relative_to(account)), thumb, size, modified) for p, thumb, size, modified in candidates]
    resource = account / 'db_storage' / 'message' / 'message_resource.db'
    for file in (resource, resource.with_name(resource.name + '-wal')):
        try:
            info = file.stat()
            state.append((file.name, info.st_size, info.st_mtime_ns))
        except FileNotFoundError:
            state.append((file.name, None))
    return hashlib.sha256(json.dumps([IMAGE_SOURCE_VERSION, state], sort_keys=True).encode()).hexdigest()


def image_cache_current(account, talker, cached):
    if not isinstance(cached, dict):
        return False
    source = cached.get('_imageSource', {})
    if not isinstance(source, dict):
        return False
    ids = source.get('ids')
    if source.get('version') != IMAGE_SOURCE_VERSION or not isinstance(ids, list) or not ids or len(ids) > 4096:
        return False
    if any(not isinstance(value, str) or not re.fullmatch(r'[a-f0-9]{32}', value) for value in ids):
        return False
    candidates = local_image_candidates(account, talker, ids)
    return source.get('fingerprint') == image_source_fingerprint(account, candidates)

def extract_media_md5s(value):
    matches = re.findall(r'(?<![0-9a-f])([0-9a-f]{32})(?![0-9a-f])', str(value or ''), re.IGNORECASE)
    return list(dict.fromkeys(match.lower() for match in matches))

def extract_blob_md5s(value, known_md5s=None):
    if value is None:
        return []
    if isinstance(value, memoryview):
        data = value.tobytes()
    elif isinstance(value, (bytes, bytearray)):
        data = bytes(value)
    else:
        data = str(value).encode('utf-8', errors='ignore')
    matches = re.findall(rb'(?i)([0-9a-f]{32})(?:[._][thbc])?\.dat', data)
    if not matches:
        matches = re.findall(rb'(?i)(?<![0-9a-f])([0-9a-f]{32})(?![0-9a-f])', data)
    result = [item.decode('ascii').lower() for item in matches]
    # MessageResourceInfo commonly stores MD5 values as raw 16-byte fields.
    # Index those candidates; get_cached_image will retain only candidates
    # that resolve to an actual local media file.
    for offset in range(0, max(0, len(data) - 15)):
        candidate = data[offset:offset + 16]
        candidate_hex = candidate.hex()
        if (candidate not in (b'\x00' * 16, b'\xff' * 16)
                and (known_md5s is None or candidate_hex in known_md5s)):
            result.append(candidate_hex)
    return list(dict.fromkeys(result))

def detect_mime_from_bytes(header_bytes):
    """Detect MIME type from byte header."""
    if header_bytes[:2] == b'\xff\xd8':
        return 'image/jpeg'
    if header_bytes[:4] == b'\x89PNG':
        return 'image/png'
    if header_bytes[:3] == b'GIF':
        return 'image/gif'
    if header_bytes[:4] == b'RIFF' and len(header_bytes) >= 12 and header_bytes[8:12] == b'WEBP':
        return 'image/webp'
    return None
