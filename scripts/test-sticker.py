"""Synthetic sticker boundaries, downloads, decoding and animation checks."""
import hashlib
import importlib.util
import io
import pathlib
import tempfile
import time
import unittest
import subprocess
from Crypto.Cipher import AES
from Crypto.Util.Padding import pad
from PIL import Image
import wechat_sticker as sticker

spec = importlib.util.spec_from_file_location('worker', pathlib.Path(__file__).with_name('resolve-wechat-image.py'))
worker = importlib.util.module_from_spec(spec); spec.loader.exec_module(worker)


class StickerChecks(unittest.TestCase):
    def test_cdn_accepts_only_https_to_the_observed_tencent_host(self):
        self.assertEqual(sticker.trusted_cdn_url('http://wxapp.tc.qq.com/path?fixture=1'), 'https://wxapp.tc.qq.com/path?fixture=1')
        self.assertEqual(sticker.trusted_cdn_url('http://vweixinf.tc.qq.com/path'), 'https://vweixinf.tc.qq.com/path')
        self.assertEqual(sticker.sticker_download_url('http://vweixinf.tc.qq.com/path?fixture=1'), 'https://vweixinf.tc.qq.com/path?fixture=1')
        self.assertEqual(sticker.sticker_download_url('http://vweixinf.tc.qq.com/path?fixture=1',True), 'https://wxapp.tc.qq.com/path?fixture=1')
        for value in ['http://127.0.0.1/a', 'https://wxapp.tc.qq.com.evil.invalid/a', 'https://user:pass@wxapp.tc.qq.com/a', 'https://wxapp.tc.qq.com:80/a', 'file:///a', 'https://wxapp.tc.qq.com/a\n']:
            with self.assertRaisesRegex(RuntimeError, 'CDN_REJECTED'):
                sticker.trusted_cdn_url(value)
        self.assertIsNone(sticker.NoRedirect().redirect_request(None,None,302,'',{},'https://wxapp.tc.qq.com/next'))

    def test_download_is_bounded_and_errors_do_not_expose_credentials(self):
        class Response(io.BytesIO):
            status = 200
            headers = {'Content-Length':str(sticker.MAX_BYTES+1)}
        class Opener:
            def open(self, request, timeout):
                return Response(b'x')
        with self.assertRaisesRegex(RuntimeError, 'DOWNLOAD_TOO_LARGE'):
            sticker.download_sticker('https://wxapp.tc.qq.com/a?secret=fixture',time.monotonic()+1,Opener())
        with self.assertRaisesRegex(RuntimeError, '^IMAGE_STICKER_DOWNLOAD_FAILED$'):
            sticker.download_sticker('https://wxapp.tc.qq.com/a?secret=fixture',time.monotonic()-1,Opener())

    def test_cache_is_md5_bound_and_cdn_is_opt_in(self):
        output=io.BytesIO(); Image.new('RGB',(30,20),'red').save(output,format='PNG')
        raw=output.getvalue(); md5=hashlib.md5(raw).hexdigest(); key=b'fixture-key-1234'
        xml=f'<msg><emoji md5="{md5}" aeskey="{key.hex()}" /></msg>'
        with tempfile.TemporaryDirectory() as directory:
            base=pathlib.Path(directory)/'cache/2026-01/Emoticon'/md5[:2]; base.mkdir(parents=True)
            file=base/md5;file.write_bytes(AES.new(key,AES.MODE_CBC,key).encrypt(pad(raw,16)))
            result=sticker.resolve_sticker(directory,xml,worker.normalize_image)
            self.assertEqual((result['width'],result['height']),(30,20))
            file.write_bytes(b'wrong-message-content')
            with self.assertRaisesRegex(RuntimeError,'LOCAL_COPY_UNAVAILABLE'):
                sticker.resolve_sticker(directory,xml,worker.normalize_image)

    def test_animated_sticker_samples_later_frames_and_stays_small(self):
        output=io.BytesIO();frames=[Image.new('RGB',(40,30),color) for color in ('white','red','blue')]
        frames[0].save(output,format='GIF',save_all=True,append_images=frames[1:],duration=100,loop=0)
        result=worker.normalize_image(output.getvalue(),animated=True)
        image=Image.open(io.BytesIO(__import__('base64').b64decode(result['b64'])))
        self.assertEqual(image.size,(80,30))
        self.assertGreater(image.getpixel((60,15))[2],200)
        self.assertLessEqual(result['bytes'],768*1024)

    def test_wxgf_decodes_a_bounded_synthetic_hevc_stream(self):
        import imageio_ffmpeg
        with tempfile.TemporaryDirectory() as directory:
            file=pathlib.Path(directory)/'fixture.hevc'
            process=subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(),'-hide_banner','-loglevel','error','-nostdin',
                '-f','lavfi','-i','color=c=red:s=32x32:r=3','-frames:v','3','-c:v','libx265',
                '-x265-params','log-level=error:pools=1:frame-threads=1','-f','hevc',str(file)],
                capture_output=True,timeout=12,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
            self.assertEqual(process.returncode,0,'Synthetic HEVC generation failed')
            result=worker.normalize_image(sticker.decode_wxgf(b'wxgf'+file.read_bytes()),animated=True)
            self.assertGreater(result['width'],0); self.assertLessEqual(result['width'],1280)


if __name__=='__main__':
    unittest.main()
