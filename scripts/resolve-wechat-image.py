"""Resolve one authorized image locally using unchanged weflow-cli codecs."""
import base64
import hashlib
import importlib.util
import io
import json
import pathlib
import re
import sys

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


def normalize_image(raw, animated=False):
    if not raw or len(raw) > 8 * 1024 * 1024:
        raise RuntimeError('IMAGE_TOO_LARGE_OR_EMPTY')
    with Image.open(io.BytesIO(raw)) as source:
        if source.width * source.height > 40_000_000:
            raise RuntimeError('IMAGE_PIXEL_LIMIT')
        if animated and getattr(source, 'is_animated', False):
            # Bound decoded pixels and frames. A static sheet conveys sampled
            # animation content without repeatedly sending entire animations.
            budget = min(32, max(1, 80_000_000 // (source.width * source.height)))
            samples, last = [], None
            for index in range(budget):
                try:
                    source.seek(index)
                except EOFError:
                    break
                frame = source.convert('RGBA')
                frame.thumbnail((384, 384))
                background = Image.new('RGB', frame.size, 'white')
                background.paste(frame, mask=frame.getchannel('A'))
                last = (index, background)
                if index in (0, 8, 24):
                    samples.append(last)
            if last and samples[-1][0] != last[0]:
                samples.append(last)
            chosen = [samples[0], samples[len(samples)//2], samples[-1]]
            frames = [entry[1] for entry in {entry[0]: entry for entry in chosen}.values()]
            image = Image.new('RGB', (sum(f.width for f in frames), max(f.height for f in frames)), 'white')
            x = 0
            for frame in frames:
                image.paste(frame, (x, 0)); x += frame.width
        else:
            image = ImageOps.exif_transpose(source).convert('RGB')
        image.thumbnail((1280, 1280))
        output = io.BytesIO()
        image.save(output, format='JPEG', quality=85, optimize=True)
        data = output.getvalue()
        if len(data) > 768 * 1024:
            output = io.BytesIO()
            image.save(output, format='JPEG', quality=65, optimize=True)
            data = output.getvalue()
        if len(data) > 768 * 1024:
            raise RuntimeError('NORMALIZED_IMAGE_TOO_LARGE')
        return {'b64': base64.b64encode(data).decode('ascii'), 'mime': 'image/jpeg',
            'width': image.width, 'height': image.height, 'bytes': len(data),
            'sha256': hashlib.sha256(data).hexdigest()}


def resolve(descriptor):
    reader = reader_api.Reader(ROOT)
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
    attach = reader.account / 'msg' / 'attach' / hashlib.md5(talker.encode()).hexdigest()
    # Resource IDs bind files to the exact server message. Local IDs alone are
    # deliberately insufficient because they collide between shards/chats.
    for file_id in ids:
        candidates = []
        if attach.is_dir():
            for month in sorted(attach.iterdir(), reverse=True):
                image_dir = month / 'Img'
                for suffix in ('.dat', '_h.dat', '_t.dat'):
                    file = image_dir / (file_id + suffix)
                    if file.is_file() and file.stat().st_size <= media.MAX_EMBED_SIZE:
                        candidates.append(file)
        for file in candidates:
            for xor, aes in keys:
                decoded = media.decode_wechat_v2(str(file), xor, aes)
                if decoded:
                    try:
                        return normalize_image(decoded[0])
                    except Exception:
                        continue
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


if __name__ == '__main__':
    try:
        if sys.argv[1:] == ['--check-runtime']:
            print(json.dumps({'success': True, 'imageWorkerReady': True}))
        else:
            descriptor = json.loads(sys.stdin.read(16384))
            print(json.dumps({'success': True, **resolve(descriptor)}))
    except Exception as error:
        print(json.dumps({'success': False, 'error': image_error_code(error),
                         'exceptionType': type(error).__name__}), file=sys.stderr)
        sys.exit(1)
