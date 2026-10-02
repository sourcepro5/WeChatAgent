"""Message-bound sticker decoding. No process access or arbitrary URL input.

Cache layout and AES-CBC key=IV convention follow weflow-cli 3d56da9 (MIT).
Original license: components/weflow-cli/LICENSE. Credentials stay in memory.
"""
import hashlib
import io
import pathlib
import re
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

from Crypto.Cipher import AES
from Crypto.Util.Padding import unpad
from PIL import Image

MAX_BYTES = 8 * 1024 * 1024
CDN_HOSTS = frozenset({'wxapp.tc.qq.com', 'vweixinf.tc.qq.com'})


def emoji_attributes(content):
    if not content or len(content) > 100_000 or '<!DOCTYPE' in content.upper() or '<!ENTITY' in content.upper():
        raise RuntimeError('IMAGE_STICKER_METADATA_INVALID')
    try:
        root = ET.fromstring(content)
        emoji = root.find('emoji') if root.tag == 'msg' else None
        attrs = dict(emoji.attrib) if emoji is not None else {}
        if not re.fullmatch(r'[a-fA-F0-9]{32}', attrs.get('md5', '')):
            raise ValueError()
        attrs['md5'] = attrs['md5'].lower()
        return attrs
    except (ET.ParseError, ValueError):
        raise RuntimeError('IMAGE_STICKER_METADATA_INVALID') from None


def trusted_cdn_url(value):
    if not isinstance(value, str) or len(value) > 8192 or any(ord(c) < 33 for c in value):
        raise RuntimeError('IMAGE_STICKER_CDN_REJECTED')
    try:
        url = urllib.parse.urlsplit(value)
        if url.scheme not in ('http', 'https') or url.hostname not in CDN_HOSTS or url.username or url.password or url.port not in (None, 443) or url.fragment:
            raise ValueError()
        return urllib.parse.urlunsplit(('https', url.hostname, url.path, url.query, ''))
    except ValueError:
        raise RuntimeError('IMAGE_STICKER_CDN_REJECTED') from None


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_):
        return None


def sticker_download_url(value, allow_alias=False):
    url = trusted_cdn_url(value)
    # Explicitly opt-in: retain TLS verification while mapping only the
    # observed legacy Tencent host to its verified compatibility endpoint.
    if allow_alias and urllib.parse.urlsplit(url).hostname == 'vweixinf.tc.qq.com':
        url = url.replace('https://vweixinf.tc.qq.com/', 'https://wxapp.tc.qq.com/', 1)
    return url


def download_sticker(value, deadline, opener=None):
    url = trusted_cdn_url(value)
    # Ignore proxy environment variables and reject all redirects, including
    # redirects to otherwise trusted hosts. Never expose token-bearing URLs.
    opener = opener or urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError()
        request = urllib.request.Request(url, headers={'User-Agent': 'WeChatAgent/0.1'})
        with opener.open(request, timeout=min(8, remaining)) as response:
            if response.status != 200:
                raise ValueError()
            size = response.headers.get('Content-Length')
            if size and int(size) > MAX_BYTES:
                raise RuntimeError('IMAGE_STICKER_DOWNLOAD_TOO_LARGE')
            chunks, total = [], 0
            while True:
                if time.monotonic() >= deadline:
                    raise TimeoutError()
                data = response.read(min(65536, MAX_BYTES + 1 - total))
                if not data:
                    break
                total += len(data)
                if total > MAX_BYTES:
                    raise RuntimeError('IMAGE_STICKER_DOWNLOAD_TOO_LARGE')
                chunks.append(data)
            return b''.join(chunks)
    except RuntimeError:
        raise
    except Exception:
        raise RuntimeError('IMAGE_STICKER_DOWNLOAD_FAILED') from None


def plain_candidates(raw, aes_hex=''):
    yield raw
    if raw and len(raw) % 16 == 0 and re.fullmatch(r'[a-fA-F0-9]{32}', aes_hex):
        key = bytes.fromhex(aes_hex)
        for iv in (key, bytes(16)):
            decoded = AES.new(key, AES.MODE_CBC, iv).decrypt(raw)
            try:
                yield unpad(decoded, 16)
            except ValueError:
                pass


def decode_wxgf(raw):
    if not raw.startswith(b'wxgf'):
        return raw
    try:
        import imageio_ffmpeg
        executable = imageio_ffmpeg.get_ffmpeg_exe()
    except (ImportError, RuntimeError):
        raise RuntimeError('IMAGE_STICKER_FFMPEG_UNAVAILABLE') from None
    with tempfile.TemporaryDirectory(prefix='wechatagent-sticker-') as directory:
        base = pathlib.Path(directory)
        source = base / 'input.hevc'
        source.write_bytes(raw[4:])
        result = subprocess.run([executable, '-hide_banner', '-loglevel', 'error', '-nostdin',
            '-threads', '1', '-f', 'hevc', '-i', str(source), '-frames:v', '24',
            '-vf', 'scale=384:384:force_original_aspect_ratio=decrease',
            '-vsync', '0', str(base / 'frame-%02d.png')],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=12,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        files = sorted(base.glob('frame-*.png'))
        if result.returncode != 0 or not files:
            raise RuntimeError('IMAGE_STICKER_WXGF_DECODE_FAILED')
        picks = list(dict.fromkeys([files[0], files[len(files)//2], files[-1]]))
        images = []
        for file in picks:
            with Image.open(file) as image:
                images.append(image.convert('RGB'))
        sheet = Image.new('RGB', (sum(i.width for i in images), max(i.height for i in images)), 'white')
        x = 0
        for image in images:
            sheet.paste(image, (x, 0)); x += image.width
        output = io.BytesIO(); sheet.save(output, format='PNG')
        return output.getvalue()


def resolve_sticker(account, content, normalize, allow_cdn=False, allow_cdn_alias=False):
    attrs = emoji_attributes(content)
    md5, key = attrs['md5'], attrs.get('aeskey', '')
    account = pathlib.Path(account).resolve()
    def decode(raw):
        for candidate in plain_candidates(raw, key):
            if hashlib.md5(candidate).hexdigest() != md5:
                continue
            return normalize(decode_wxgf(candidate), animated=True)
        return None
    bases = [account / 'business' / 'emoticon' / n for n in ('Persist', 'Thumb', 'Temp')]
    cache = account / 'cache'
    if cache.is_dir():
        bases.extend(p / 'Emoticon' for p in sorted(cache.iterdir(), reverse=True) if re.fullmatch(r'\d{4}-\d{2}', p.name))
    for base in bases:
        file = base / md5[:2] / md5
        if file.is_file() and file.resolve().is_relative_to(account) and file.stat().st_size <= MAX_BYTES:
            result = decode(file.read_bytes())
            if result:
                return result
    if not allow_cdn:
        raise RuntimeError('IMAGE_STICKER_LOCAL_COPY_UNAVAILABLE')
    deadline = time.monotonic() + 20
    error = 'IMAGE_STICKER_SOURCE_UNAVAILABLE'
    for name in ('cdnurl', 'encrypturl'):
        if not attrs.get(name):
            continue
        try:
            result = decode(download_sticker(sticker_download_url(attrs[name], allow_cdn_alias), deadline))
            if result:
                return result
            error = 'IMAGE_STICKER_CONTENT_MISMATCH'
        except RuntimeError as failure:
            error = str(failure)
    raise RuntimeError(error)
