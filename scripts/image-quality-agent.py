"""Image quality agent.

Watches newly registered WeChat images and tells the native hook which quality
level to request for each message (1 = HD original, 2 = mid, 3 = thumbnail).

The native hook (wechatagent-text-4.2.0.12.dll) waits briefly for this decision,
so an image with an available HD copy is downloaded at original quality while
ordinary compressed images are downloaded at mid quality.
"""
import importlib.util
import json
import os
import re
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'scripts'))
sys.path.insert(0, str(ROOT / 'components' / 'weflow-cli' / 'scripts'))

LOG = ROOT / 'state' / 'image-quality-agent.log'
INDEX = ROOT / 'state' / 'media' / 'index.json'
HOOK_TOKEN_FILE = ROOT / 'state' / 'hook' / 'native-token.txt'
HOOK_URL = 'http://127.0.0.1:30001/WeChatAgent/ImageQuality'
POLL_SECONDS = 0.25
MAX_LOG_BYTES = 1_000_000


def log(message):
    try:
        if LOG.exists() and LOG.stat().st_size > MAX_LOG_BYTES:
            LOG.write_text('', encoding='utf-8')
        with LOG.open('a', encoding='utf-8') as handle:
            handle.write(time.strftime('[%Y-%m-%d %H:%M:%S] ') + message + '\n')
    except OSError:
        pass


def load_reader():
    spec = importlib.util.spec_from_file_location('reader_api_iq', ROOT / 'scripts' / 'reader-api.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.Reader()


def attrs_of(xml):
    return dict(re.findall(r'([A-Za-z0-9]+)="([^"]*)"', xml or ''))


def post_quality(token, local_id, mode):
    body = json.dumps({'localId': int(local_id), 'mode': int(mode)}).encode('utf-8')
    request = urllib.request.Request(
        HOOK_URL, data=body, method='POST',
        headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=3) as response:
        return response.read().decode('utf-8', 'replace')


def main():
    reader = load_reader()
    token = HOOK_TOKEN_FILE.read_text(encoding='utf-8-sig').strip()
    seen = set()
    try:
        now = time.time()
        for key, value in json.loads(INDEX.read_text(encoding='utf-8')).items():
            created = int(value.get('createTime') or 0) if isinstance(value, dict) else 0
            if created and now - created > 600:
                seen.add(key)
    except (OSError, ValueError, TypeError):
        pass
    log('agent start, baseline=%d' % len(seen))
    while True:
        try:
            try:
                index = json.loads(INDEX.read_text(encoding='utf-8'))
            except (OSError, ValueError):
                time.sleep(POLL_SECONDS)
                continue
            for image_id, descriptor in index.items():
                if image_id in seen:
                    continue
                seen.add(image_id)
                if not isinstance(descriptor, dict) or descriptor.get('localType') != 3:
                    continue
                local_id = descriptor.get('localId')
                try:
                    row = reader.image_row(descriptor['talker'], descriptor)
                    attrs = attrs_of(row.get('imageXml'))
                    hd_length = int(attrs.get('hdlength') or 0)
                    mode = 1 if (hd_length > 0 and attrs.get('cdnbigimgurl')) else 2
                    reply = post_quality(token, local_id, mode)
                    log('localId=%s hdlength=%d mode=%d reply=%s' % (local_id, hd_length, mode, reply))
                except Exception as error:  # keep the service alive
                    log('localId=%s failed: %s' % (local_id, type(error).__name__))
        except Exception as error:
            log('loop error: %s' % type(error).__name__)
        time.sleep(POLL_SECONDS)


if __name__ == '__main__':
    main()
