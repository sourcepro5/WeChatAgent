"""Read-only verification of the packaged reader dependencies."""
import sys
import sqlcipher3
import cryptography
import zstandard
import Crypto
import PIL
import imageio_ffmpeg
import importlib.util
import pathlib
import subprocess
import json
from sqlcipher3 import dbapi2

connection = dbapi2.connect(':memory:')
assert connection.execute('select 1').fetchone() == (1,)
connection.close()
root = pathlib.Path(__file__).resolve().parent.parent
for name in ('wechat_media', 'wechat_forwarded', 'wechat_quote', 'wechat_sticker_send', 'wechat_sticker', 'wechat_sticker_labels'):
    if not (root / 'scripts' / (name + '.py')).is_file():
        raise RuntimeError('Reader module missing: ' + name)
spec = importlib.util.spec_from_file_location('reader_runtime_probe', root / 'scripts' / 'reader-api.py')
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)
if not (root / 'components/weflow-cli/resources/key/win32/x64/wx_key.dll').is_file():
    raise RuntimeError('Reader key component missing')
# This must run in a fresh child, rather than inheriting the reader's sys.path.
probe = subprocess.run([sys.executable, '-B', str(root / 'scripts/resolve-wechat-image.py'), '--check-runtime'],
    capture_output=True, text=True, encoding='utf-8', timeout=20,
    creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
if probe.returncode:
    code, _ = reader.image_worker_failure(probe.stderr)
    raise RuntimeError('Image worker startup check failed: ' + code)
try:
    result = json.loads(probe.stdout.strip().splitlines()[-1])
except (ValueError, IndexError):
    raise RuntimeError('Image worker returned an invalid startup result') from None
if result.get('success') is not True or result.get('imageWorkerReady') is not True:
    raise RuntimeError('Image worker startup check did not pass')
print('Bundled Python reader dependencies and image worker verified: ' + sys.version.split()[0])
