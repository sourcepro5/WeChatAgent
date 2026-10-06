"""Bounded local parser for WeChat appmsg/19 merged chat records."""
import html
import re
import xml.etree.ElementTree as ET

FORWARD_TYPE = (19 << 32) | 49
MAX_XML = 512_000
MAX_ITEMS = 50
MAX_TEXT = 6000
MAX_DEPTH = 3


def safe_xml(value):
    if not isinstance(value, str) or not value.strip() or len(value) > MAX_XML:
        raise ValueError('INVALID_RECORD_XML')
    if re.search(r'<!\s*(?:DOCTYPE|ENTITY)\b', value, re.I):
        raise ValueError('UNSAFE_RECORD_XML')
    return ET.fromstring(value)


def child_text(node, tag, limit=800):
    child = node.find(tag)
    return (''.join(child.itertext()) if child is not None else '').strip()[:limit]


def record_root(node):
    """recorditem/recordxml may contain a tree, CDATA, or escaped XML."""
    if list(node):
        return node
    text = (node.text or '').strip()
    for _ in range(3):
        if text.startswith('<'):
            return safe_xml(text)
        decoded = html.unescape(text)
        if decoded == text:
            break
        text = decoded
    return safe_xml(text)


def parse_forwarded_record(value):
    try:
        root = safe_xml(value)
        app = root if root.tag == 'appmsg' else root.find('appmsg') if root.tag == 'msg' else None
        if app is None or child_text(app, 'type') != '19':
            return None
        title = child_text(app, 'title', 200) or '聊天记录'
        record = app.find('recorditem')
        if record is None:
            return {'version': 1, 'title': title, 'items': [], 'truncated': False, 'unavailable': True}
        container = record_root(record)
        items, truncated = [], False
        remaining = MAX_TEXT

        def collect(current, depth):
            nonlocal truncated, remaining
            data_list = current if current.tag == 'datalist' else current.find('datalist')
            if data_list is None:
                info = current.find('recordinfo')
                data_list = info.find('datalist') if info is not None else None
            if data_list is None:
                return
            for item in data_list.findall('dataitem'):
                if len(items) >= MAX_ITEMS or remaining < 100:
                    truncated = True
                    break
                kind = str(item.get('datatype') or child_text(item, 'datatype', 8))
                name = re.sub(r'[\r\n\t]+', ' ', child_text(item, 'sourcename', 80)) or '未知发言人'
                clock = re.sub(r'[\r\n\t]+', ' ', child_text(item, 'sourcetime', 64))
                full_desc = child_text(item, 'datadesc', MAX_XML) or child_text(item, 'content', MAX_XML)
                desc = full_desc[:800]
                if len(full_desc)>800:
                    truncated = True
                    desc += '…'
                heading = child_text(item, 'datatitle', 200)
                if kind == '1':
                    text = desc or heading or '[空文字消息]'
                elif kind == '14':
                    text = '[嵌套聊天记录]' + (' ' + heading if heading else '')
                else:
                    label = {'2': '图片，未提供图片内容', '3': '语音，未转写', '4': '视频，未提供视频内容',
                             '5': '链接', '6': '位置', '8': '文件，未读取文件内容', '7': '音乐'}.get(kind, '未支持的消息')
                    text = '[' + label + ']' + (' ' + (heading or desc) if heading or desc else '')
                cost = len(name) + len(clock) + len(text) + 12
                if cost > remaining:
                    text = text[:max(0, remaining-len(name)-len(clock)-12)] + '…'
                    truncated = True
                items.append({'sender': name, 'time': clock, 'kind': kind, 'text': text, 'depth': depth})
                remaining -= len(name)+len(clock)+len(text)+12
                if kind == '14':
                    nested = item.find('recordxml')
                    if nested is None:
                        nested = item.find('recorditem')
                    if nested is not None:
                        if depth >= MAX_DEPTH:
                            truncated = True
                        else:
                            collect(record_root(nested), depth+1)

        collect(container, 0)
        return {'version': 1, 'title': title, 'items': items, 'truncated': truncated, 'unavailable': not items}
    except (ValueError, ET.ParseError, RecursionError):
        return None
