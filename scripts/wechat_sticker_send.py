"""Extract only cached-native forwarding fields from a bound sticker message."""
import re
import io
import xml.etree.ElementTree as ET
from PIL import Image
from wechat_sticker import emoji_attributes

APPMSG_STICKER_TYPE = 8 * 2**32 + 49


def native_gif_bytes(raw):
    # Keep every frame of received GIFs byte-for-byte. Static image stickers
    # need GIF encoding for the current native appmsg-8 upload path.
    if raw.startswith((b'GIF87a',b'GIF89a')):return raw
    try:
        with Image.open(io.BytesIO(raw)) as image:
            if image.format not in ('JPEG','PNG','WEBP') or getattr(image,'n_frames',1)!=1:
                raise RuntimeError('STICKER_NATIVE_FORMAT_UNSUPPORTED')
            if not 0<image.width<=4096 or not 0<image.height<=4096:
                raise RuntimeError('STICKER_NATIVE_IMAGE_TOO_LARGE')
            output=io.BytesIO()
            image.convert('RGBA').save(output,format='GIF')
            result=output.getvalue()
            if not result or len(result)>8*1024*1024:raise RuntimeError('STICKER_NATIVE_IMAGE_TOO_LARGE')
            return result
    except RuntimeError:
        raise
    except Exception:
        raise RuntimeError('STICKER_NATIVE_FORMAT_UNSUPPORTED') from None


def sticker_receipt_md5(local_type, xml):
    """Recognize native emoji-47 and appmsg-8, never an arbitrary attachment."""
    if local_type == 47:
        try:
            return emoji_attributes(xml)['md5']
        except RuntimeError:
            return None
    if local_type not in (49, APPMSG_STICKER_TYPE) or not xml or len(xml)>100_000 or '<!DOCTYPE' in xml.upper() or '<!ENTITY' in xml.upper():
        return None
    try:
        root=ET.fromstring(xml)
        app=root.find('appmsg') if root.tag=='msg' else root if root.tag=='appmsg' else None
        if app is None or app.findtext('type')!='8':return None
        md5=app.findtext('appattach/emoticonmd5','')
        return md5.lower() if re.fullmatch(r'[a-fA-F0-9]{32}',md5) else None
    except ET.ParseError:
        return None


def sticker_send_fields(xml):
    attrs = emoji_attributes(xml)
    product = attrs.get('productid', '')
    if not re.fullmatch(r'[A-Za-z0-9._-]{0,128}', product):
        raise RuntimeError('STICKER_PRODUCT_INVALID')
    result = {'md5': attrs['md5'], 'productid': product}
    for key, maximum in [('len', 8*1024*1024), ('type', 5), ('width', 4096), ('height', 4096)]:
        raw = attrs.get(key, '0')
        if not re.fullmatch(r'\d{1,10}', raw) or int(raw)>maximum:
            raise RuntimeError('STICKER_METADATA_INVALID')
        result[key] = int(raw)
    return result
