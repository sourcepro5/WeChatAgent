"""Resolve one authorized image locally using unchanged weflow-cli codecs."""
import base64
import hashlib
import importlib.util
import io
import json
import pathlib
import re
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
# Embedded Python uses an isolated _pth file and does not add the script directory.
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
sys.path.insert(0, str(ROOT / 'components' / 'weflow-cli' / 'scripts'))
try:
    import wechat_media as media
    from wechat_sticker import resolve_sticker
    from PIL import Image, ImageOps, UnidentifiedImageError
    import subprocess
    spec = importlib.util.spec_from_file_location('reader_api_image', ROOT / 'scripts' / 'reader-api.py')
    reader_api = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(reader_api)
except (ImportError, OSError) as error:
    if __name__ != '__main__':
        raise
    code = 'IMAGE_DEPENDENCY_MISSING' if isinstance(error, ModuleNotFoundError) else 'IMAGE_DEPENDENCY_LOAD_FAILED'
    result = {'success': False, 'error': code, 'exceptionType': type(error).__name__}
    name = getattr(error, 'name', '') or ''
    if re.fullmatch(r'[A-Za-z0-9_.]{1,80}', name):
        result['module'] = name
    print(json.dumps(result), file=sys.stderr)
    sys.exit(1)


from wechat_image_normalize import normalize_image, decode_image_source


def resolve(descriptor):
    reader = reader_api.Reader(ROOT, metadata_readonly=True)
    talker = descriptor['talker']
    if not reader.image_talker_allowed(talker):
        raise RuntimeError('IMAGE_CONVERSATION_NOT_ALLOWED')
    row = reader.image_row(talker, descriptor)
    content = row['imageXml']
    if row['localType'] == 47:
        project = reader_api.read_json(ROOT / 'config' / 'wechatagent.json')
        return resolve_sticker(reader.account, content, normalize_image,
            allow_cdn=project.get('wechat', {}).get('media', {}).get('allowStickerCdn', False) is True,
            allow_cdn_alias=project.get('wechat', {}).get('media', {}).get('allowStickerCdnAlias', False) is True)
    resource = reader.account / 'db_storage' / 'message' / 'message_resource.db'
    ids = list(media.extract_media_md5s(content))
    if resource.is_file():
        connection = None
        try:
            key, salt = reader_api.nt.derive_database_key(str(resource), '', '', reader.passphrase)
            connection, cursor = reader_api.nt.connect_nt_db(str(resource), key, salt)
            cursor.execute('PRAGMA query_only=ON')
            if int(descriptor['serverId'] or 0):
                cursor.execute('SELECT packed_info FROM MessageResourceInfo WHERE message_svr_id=? AND message_local_id=? AND message_create_time=? LIMIT 8', (int(descriptor['serverId']), descriptor['localId'], descriptor['createTime']))
                for (packed,) in cursor.fetchall():
                    ids.extend(media.extract_blob_md5s(packed))
        except Exception:
            pass  # Exact cache identity remains available; never guess another image.
        finally:
            if connection is not None:
                connection.close()
    ids = list(dict.fromkeys(value.lower() for value in ids if re.fullmatch(r'[a-fA-F0-9]{32}', value)))
    settings = reader_api.read_json(reader.settings_file)
    keys = []
    try:
        saved = reader_api.local_secret(str(settings.get('imageAesKey') or ''))
        aes = bytes.fromhex(saved) if re.fullmatch(r'[a-fA-F0-9]{32}', saved) else saved.encode('ascii')
        xor = int(reader_api.local_secret(str(settings.get('imageXorKey') or '0')), 0) & 255
        if len(aes) == 16:
            keys.append((xor, aes))
    except Exception:
        pass
    derived = media.resolve_v2_media_key(str(reader.account), reader.own_wxid)
    if derived and derived not in keys:
        keys.append(derived)
    # Resource IDs bind files to the exact server message. Local IDs alone are
    # deliberately insufficient because they collide between shards/chats.
    ids = ids[:4096]
    candidates = media.local_image_candidates(reader.account, talker, ids, descriptor.get('localId'), descriptor.get('createTime'))
    fingerprint = media.image_source_fingerprint(reader.account, candidates)
    wxgf_deadline = time.monotonic() + 5
    for thumbnail in (False, True):
        best, best_area = None, 0
        for file, is_thumbnail, size, _ in candidates:
            if is_thumbnail != thumbnail or size > media.MAX_IMAGE_SOURCE_SIZE:
                continue
            for xor, aes in keys:
                decoded = media.read_plain_image(str(file)) or media.decode_wechat_v2(str(file), xor, aes, max_size=media.MAX_IMAGE_SOURCE_SIZE)
                if decoded:
                    try:
                        raw = decoded[0]
                        if decoded[1] == 'image/x-wxgf':
                            remaining = wxgf_deadline - time.monotonic()
                            if remaining <= .05:
                                break
                            raw = decode_image_source(raw, timeout=remaining)
                        with Image.open(io.BytesIO(raw)) as image:
                            width, height = image.size
                        area = width * height
                        if best_area < area <= 40_000_000:
                            best = {**normalize_image(raw, max_side=2048, max_source_bytes=media.MAX_IMAGE_SOURCE_SIZE),
                                'sourceQuality': 'thumbnail' if thumbnail else 'full', 'sourceWidth': width, 'sourceHeight': height,
                                '_imageSource': {'version': media.IMAGE_SOURCE_VERSION, 'ids': ids, 'fingerprint': fingerprint}}
                            best_area = area
                        break
                    except Exception:
                        continue
        if best is not None:
            return best
    raise RuntimeError('IMAGE_LOCAL_COPY_UNAVAILABLE')


def image_error_code(error):
    if isinstance(error, RuntimeError) and re.fullmatch(r'IMAGE_[A-Z_]{3,80}', str(error)):
        return str(error)
    if isinstance(error, RuntimeError) and str(error) == 'NORMALIZED_IMAGE_TOO_LARGE':
        return 'IMAGE_NORMALIZED_TOO_LARGE'
    if isinstance(error, (UnidentifiedImageError, EOFError)):
        return 'IMAGE_FORMAT_UNSUPPORTED'
    if isinstance(error, PermissionError):
        return 'IMAGE_FILE_ACCESS_DENIED'
    if isinstance(error, FileNotFoundError):
        return 'IMAGE_LOCAL_FILE_MISSING'
    if isinstance(error, subprocess.TimeoutExpired):
        return 'IMAGE_DECODE_TIMEOUT'
    if isinstance(error, (MemoryError, Image.DecompressionBombError)):
        return 'IMAGE_PIXEL_LIMIT'
    if isinstance(error, (json.JSONDecodeError, KeyError, TypeError)):
        return 'IMAGE_DESCRIPTOR_INVALID'
    return 'IMAGE_RESOLUTION_FAILED'


def image_failure_payload(error):
    result = {'success': False, 'error': image_error_code(error),
              'exceptionType': type(error).__name__}
    if result['error'] == 'IMAGE_STICKER_LOCAL_COPY_UNAVAILABLE' and getattr(error, 'reason', None) == 'STICKER_CDN_DISABLED':
        result.update(reason='STICKER_CDN_DISABLED', setting='wechat.media.allowStickerCdn')
    return result


if __name__ == '__main__':
    try:
        if sys.argv[1:] == ['--check-runtime']:
            print(json.dumps({'success': True, 'imageWorkerReady': True}))
        else:
            descriptor = json.loads(sys.stdin.read(16384))
            print(json.dumps({'success': True, **resolve(descriptor)}))
    except Exception as error:
        print(json.dumps(image_failure_payload(error)), file=sys.stderr)
        sys.exit(1)
