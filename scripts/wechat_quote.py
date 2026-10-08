"""Bounded parser for WeChat appmsg/57 replies, without exposing raw media XML."""
import html
import re
import xml.etree.ElementTree as ET
from wechat_forwarded import safe_xml

QUOTE_TYPE = (57 << 32) | 49
MAX_XML = 100_000
MAX_REPLY = 4000
MAX_REFERENCE = 1600
MAX_DEPTH = 2


def _text(node, tag):
    child = node.find(tag) if node is not None else None
    return ''.join(child.itertext()).strip() if child is not None else ''


def _metadata(value, limit):
    return re.sub(r'[\r\n\t]+', ' ', value)[:limit]


def _app(value):
    if len(value) > MAX_XML:
        raise ValueError('QUOTE_XML_TOO_LARGE')
    root = safe_xml(value)
    return root if root.tag == 'appmsg' else root.find('appmsg') if root.tag == 'msg' else None


def _reference_text(kind, value, depth):
    if kind == '1':
        if not value or value.lower() in ('null', '(null)'):
            return '[被引用文字不可用]', True, False
        return value[:MAX_REFERENCE], False, len(value) > MAX_REFERENCE
    labels = {'3': '图片，未提供图片内容', '34': '语音，未转写', '43': '视频，未提供视频内容',
              '47': '表情包，未提供表情内容', '48': '位置，未解析位置内容', '10000': '系统消息'}
    if kind in labels:
        return '[' + labels[kind] + ']', True, False
    if kind == '49' or (kind.isdigit() and int(kind) & 0xffffffff == 49):
        # References may contain an XML tree, CDATA, or doubly escaped XML.
        for _ in range(3):
            if value.startswith('<'):
                break
            decoded = html.unescape(value)
            if decoded == value:
                break
            value = decoded
        try:
            app = _app(value)
            if app is not None:
                subtype = _text(app, 'type')
                if subtype == '57':
                    if depth >= MAX_DEPTH:
                        return '[嵌套引用过深，未展开]', True, True
                    nested = parse_quote_reply(value, depth + 1)
                    if nested:
                        ref = nested['reference']
                        text = '回复：' + nested['reply'] + '\n引用 ' + ref['senderName'] + '：' + ref['text']
                        return text[:MAX_REFERENCE], ref['unavailable'], nested['truncated'] or ref['truncated'] or len(text) > MAX_REFERENCE
                label = {'5': '链接', '6': '文件，未读取文件内容', '8': '表情包，未提供表情内容',
                         '19': '合并聊天记录，未展开'}.get(subtype, '应用消息，未解析附件')
                full_title = _text(app, 'title') if subtype in ('5', '6', '19') else ''
                title = full_title[:500]
                return '[' + label + ']' + (' ' + title if title else ''), True, len(full_title) > 500
        except (ValueError, ET.ParseError, RecursionError):
            pass
    return '[被引用消息类型未支持或正文不可用]', True, False


def parse_quote_reply(value, depth=0):
    try:
        if not isinstance(value, str):
            return None
        app = _app(value)
        if app is None or _text(app, 'type') != '57':
            return None
        reply = _text(app, 'title')
        ref = app.find('refermsg')
        source = _metadata(_text(ref, 'fromusr'), 128)
        member = _metadata(_text(ref, 'chatusr'), 128)
        # In a group fromusr is the room; chatusr is the quoted speaker.
        group = source.endswith('@chatroom')
        sender = member if group else source or member
        kind = _text(ref, 'type')
        kind = kind if re.fullmatch(r'[0-9]{1,16}', kind) else ''
        content = ref.find('content') if ref is not None else None
        raw = ET.tostring(content[0], encoding='unicode') if content is not None and len(content) else _text(ref, 'content')
        text, unavailable, truncated = _reference_text(kind, raw, depth)
        return {'version': 1, 'reply': reply[:MAX_REPLY], 'truncated': len(reply) > MAX_REPLY,
                'reference': {'senderId': sender, 'senderName': _metadata(_text(ref, 'displayname'), 80) or '未知发言人',
                              'conversationId': source if group else '',
                              'messageId': _metadata(_text(ref, 'svrid'), 32),
                              'time': _metadata(_text(ref, 'createtime'), 64), 'kind': kind,
                              'text': text, 'unavailable': unavailable, 'truncated': truncated}}
    except (ValueError, ET.ParseError, RecursionError):
        return None
