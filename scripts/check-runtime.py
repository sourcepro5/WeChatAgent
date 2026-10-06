"""Read-only verification of the packaged reader dependencies."""
import sys
import sqlcipher3
import cryptography
import zstandard
import Crypto
import PIL
import imageio_ffmpeg
from sqlcipher3 import dbapi2

connection = dbapi2.connect(':memory:')
assert connection.execute('select 1').fetchone() == (1,)
connection.close()
print('Bundled Python reader dependencies verified: ' + sys.version.split()[0])
