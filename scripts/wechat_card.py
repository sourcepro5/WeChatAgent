"""Bounded local parser for WeChat appmsg shared cards (links, articles, mini programs)."""
import re
import xml.etree.ElementTree as ET
from wechat_forwarded import safe_xml

APPMSG_BASE = 49


def packed_appmsg_type(subtype):
    """WeChat 4.x stores an appmsg local type as (appmsg subtype << 32) | 49.

    Verified against the live account: 5 -> 21474836529 (link card),
    33 -> 141733920817 (mini program), 51 -> 219043332145 (channels),
    8 -> 34359738417 (sticker), 19 -> 81604378673 (forwarded record),
    57 -> 244813135921 (quote), 62 -> 266287972401 (pat).
    """
    return (int(subtype) << 32) | APPMSG_BASE


# appmsg <type> -> label.
# 4  公众号文章 / 图文分享
# 5  链接卡片
# 33/36 小程序
# 51 视频号
# 53 群接龙
# 2000 转账
# 6/8/19/57/62 属于文件、表情、合并转发、引用与拍一拍解析器，不在这里处理。
CARD_LABELS = {
    '4': '分享文章',
    '5': '分享链接',
    '33': '分享小程序',
    '36': '分享小程序',
    '51': '分享视频号',
    '53': '分享接龙',
    '2000': '分享转账',
}
CARD_TYPES = frozenset(packed_appmsg_type(subtype) for subtype in CARD_LABELS)
MAX_XML = 512_000
MAX_TITLE = 500
MAX_DES = 1000
MAX_URL = 1000
MAX_SOURCE = 80


def _text(node, tag, limit):
    child = node.find(tag) if node is not None else None
    return (''.join(child.itertext()) if child is not None else '').strip()[:limit]


def _one_line(value, limit):
    return re.sub(r'[\r\n\t]+', ' ', value or '').strip()[:limit]


def _app(value):
    root = safe_xml(value)
    return root if root.tag == 'appmsg' else root.find('appmsg') if root.tag == 'msg' else None


def parse_shared_card(value, kind=None):
    """Parse one appmsg share card.

    `kind` is the packed local type the row carried. When it is supplied it
    must agree with the subtype inside the XML, so a sticker, a file, a
    forwarded record or a quote can never be mistaken for a share card.
    """
    try:
        app = _app(value)
        if app is None:
            return None
        subtype = _text(app, 'type', 16)
        if subtype not in CARD_LABELS:
            return None
        if kind is not None and kind != APPMSG_BASE:
            if kind not in CARD_TYPES or (kind >> 32) != int(subtype):
                return None
        # A card without a title, description and link carries nothing readable.
        title = _one_line(_text(app, 'title', MAX_TITLE), MAX_TITLE)
        des = _one_line(_text(app, 'des', MAX_DES), MAX_DES)
        url = _text(app, 'url', MAX_URL)
        source = _one_line(_text(app, 'appname', MAX_SOURCE) or _text(app, 'source', MAX_SOURCE), MAX_SOURCE)
        if not (title or des or url):
            return None
        return {
            'version': 1,
            'kind': subtype,
            'label': CARD_LABELS[subtype],
            'title': title,
            'des': des,
            'url': url[:MAX_URL],
            'source': source,
        }
    except (ValueError, ET.ParseError, RecursionError):
        return None


def shared_card_text(card):
    """Render one card for the chat transcript."""
    lines = ['[' + card.get('label', '分享卡片') + ']']
    if card.get('title'):
        lines.append(card['title'])
    if card.get('des'):
        lines.append(card['des'])
    if card.get('source'):
        lines.append('来源：' + card['source'])
    if card.get('url'):
        lines.append('链接：' + card['url'])
    return '\n'.join(lines)
