"""Synthetic encrypted media fixtures; no real account data or keys."""
import importlib.util
import io
import pathlib
import struct
import tempfile
import unittest

from Crypto.Cipher import AES
from Crypto.Util.Padding import pad
from PIL import Image
import wechat_media as media

spec = importlib.util.spec_from_file_location('image_worker', pathlib.Path(__file__).with_name('resolve-wechat-image.py'))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class ImageCodecChecks(unittest.TestCase):
    def test_encrypted_image_round_trip_preserves_pixels_before_normalizing(self):
        output = io.BytesIO()
        Image.new('RGB', (80, 40), (20, 60, 180)).save(output, format='PNG')
        raw, key, xor = output.getvalue(), b'fixture-key-1234', 0x53
        aes_size, xor_size = 23, 17
        encrypted = AES.new(key, AES.MODE_ECB).encrypt(pad(raw[:aes_size], 16))
        container = struct.pack('<6sLLx', media.V2_MAGIC, aes_size, xor_size) + encrypted
        container += raw[aes_size:-xor_size] + bytes(value ^ xor for value in raw[-xor_size:])
        with tempfile.TemporaryDirectory() as directory:
            file = pathlib.Path(directory) / 'fixture.dat'
            file.write_bytes(container)
            decoded = media.decode_wechat_v2(str(file), xor, key)
            self.assertEqual(decoded, (raw, 'image/png'))
            normalized = worker.normalize_image(decoded[0])
            self.assertEqual((normalized['width'], normalized['height']), (80, 40))
            self.assertEqual(normalized['mime'], 'image/jpeg')
            self.assertIsNone(media.decode_wechat_v2(str(file), xor, b'wrong-key-1234567'))
            file.write_bytes(container[:10])
            self.assertIsNone(media.decode_wechat_v2(str(file), xor, key))

    def test_transport_limits_and_downscaling(self):
        with self.assertRaisesRegex(RuntimeError, 'IMAGE_TOO_LARGE_OR_EMPTY'):
            worker.normalize_image(b'')
        output = io.BytesIO()
        Image.new('RGB', (2400, 1200), 'blue').save(output, format='JPEG')
        normalized = worker.normalize_image(output.getvalue())
        self.assertEqual((normalized['width'], normalized['height']), (1280, 640))
        self.assertLessEqual(normalized['bytes'], 768 * 1024)


if __name__ == '__main__':
    unittest.main()
