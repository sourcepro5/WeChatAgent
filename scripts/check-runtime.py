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
print('Bundled Python reader dependencies verified: ' + sys.version.split()[0])
