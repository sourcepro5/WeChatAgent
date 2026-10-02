"""Database-only vendor subset of zhuobichen/weflow-cli (MIT).
Original copyright and permission notice: ../LICENSE.
Retained database function bodies are copied from the attributed local source.
Unused process-memory discovery, key scanning and the original CLI are omitted.
Source revision and modifications: ../README.md and ../docs/DECISIONS.md.
"""
import sys

import os

import json

import html

import re

import hmac

import struct

import hashlib

import ctypes

from ctypes import wintypes, c_void_p, c_size_t, create_string_buffer, byref, sizeof

from pathlib import Path

sqlcipher = None

def require_sqlcipher():
    """Load SQLCipher only for database operations, not path discovery."""
    global sqlcipher
    if sqlcipher is not None:
        return sqlcipher
    try:
        from sqlcipher3 import dbapi2 as sqlcipher_module
    except ImportError as error:
        raise RuntimeError("需要 sqlcipher3: pip install sqlcipher3") from error
    sqlcipher = sqlcipher_module
    return sqlcipher

def load_contact_names(contact_db_path, contact_key_hex, contact_salt_hex):
    """Load wxid -> {remark, nick_name} map from contact.db.

    Returns dict: {wxid: display_name}
    display_name priority: remark > nick_name > alias > wxid

    取不到就返回空表（名字是装饰性的，调用方会退回 wxid）。**连接必须在 finally
    里关**：原先 `conn.close()` 写在 try 末尾，异常路径上泄漏——而在 Windows 上
    一个没关的连接会把文件锁住（同一个坑早先在这个文件的分片读取里踩过一次）。
    读了一半也保留已经拿到的名字，而不是整份丢掉。
    """
    if not contact_db_path or not contact_key_hex or not contact_salt_hex:
        return {}
    if not os.path.isfile(contact_db_path):
        return {}

    name_map = {}
    conn = None
    try:
        raw_key = f"x'{contact_key_hex}{contact_salt_hex}'"
        conn = require_sqlcipher().connect(contact_db_path)
        c = conn.cursor()
        c.execute(f'PRAGMA key = "{raw_key}";')

        # contact.db schema: username, alias, remark, nick_name, ...
        c.execute("SELECT username, COALESCE(NULLIF(remark,''), NULLIF(nick_name,''), NULLIF(alias,''), username) FROM contact")
        for username, display in c.fetchall():
            if username:
                name_map[username] = display
    except Exception:
        pass
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass
    return name_map

def connect_nt_db(db_path, key_hex, salt_hex):
    """Connect to an NT database using sqlcipher3."""
    raw_key = f"x'{key_hex}{salt_hex}'"
    conn = require_sqlcipher().connect(db_path)
    c = conn.cursor()
    c.execute(f'PRAGMA key = "{raw_key}";')
    return conn, c

from nt_common import (discover_message_shards, derive_database_key,
                       table_columns, MESSAGE_ANCHOR_COLUMNS)

def verify_passphrase_native(passphrase_hex, db_path, internal_key_hex=''):
    """Check a passphrase against a database without sqlcipher3.

    Verifies the SQLCipher page-1 HMAC directly with stdlib primitives:

        mac_salt = header_salt XOR 0x3a
        key      = PBKDF2-HMAC-SHA512(passphrase, header_salt, 256000, 32)
        mac_key  = PBKDF2-HMAC-SHA512(key, mac_salt, 2, 32)
        compare HMAC-SHA512(mac_key, page1_body || page_number=1) with the
        digest stored at the end of page 1

    Why this exists: the normal way to check a key is to open the database,
    which needs the native library. When sqlcipher3 is missing or misbehaving,
    that route says nothing about whether the key itself is right - and the
    two failures look identical. This separates them.

    Returns True (correct), False (wrong), or None (cannot tell - bad input,
    file too small, or a passphrase that is not hex).
    """
    try:
        raw_passphrase = bytes.fromhex(passphrase_hex)
    except (TypeError, ValueError):
        return None
    if internal_key_hex:
        # Some WeChat builds XOR the passphrase with a key embedded in
        # Weixin.dll before deriving. Optional: the installs seen so far do
        # not need it, so an empty value must stay the default.
        try:
            internal = bytes.fromhex(internal_key_hex)
        except (TypeError, ValueError):
            return None
        if len(internal) == len(raw_passphrase):
            raw_passphrase = bytes(a ^ b for a, b in zip(raw_passphrase, internal))

    try:
        with open(db_path, 'rb') as handle:
            page = handle.read(4096)
    except OSError:
        return None
    if len(page) < 4096 or page[:16] == b'\x00' * 16:
        return None

    salt = page[:16]
    mac_salt = bytes(byte ^ 0x3a for byte in salt)
    key = hashlib.pbkdf2_hmac('sha512', raw_passphrase, salt, 256000, 32)
    mac_key = hashlib.pbkdf2_hmac('sha512', key, mac_salt, 2, 32)

    reserve = 16 + 64                      # IV + HMAC-SHA512
    reserve = ((reserve + 15) // 16) * 16  # rounded up to the AES block size
    body_end = 4096 - reserve + 16
    mac = hmac.new(mac_key, page[16:body_end], hashlib.sha512)
    mac.update(struct.pack('<I', 1))       # page number
    return hmac.compare_digest(mac.digest(), page[body_end:body_end + 64])

def connect_message_shards_detailed(db_path, key_hex, salt_hex, passphrase=''):
    """Open every shard and report what happened to each one.

    Returns (pairs, failures):
      pairs    [(shard_path, conn)] for the shards that opened
      failures [{"name": basename, "reason": "KEY_REJECTED" | "OPEN_FAILED"}]

    A shard that fails is still skipped rather than fatal - a partially
    readable transcript beats a command that refuses to run at all - but the
    failure stops being invisible. `shardsFailed` is the difference between
    "read everything" and "read what happened to be reachable", which is the
    whole point of the coverage report.

    Only the basename is reported: the caller stores this in a state file, and
    absolute paths must not end up there.
    """
    pairs = []
    failures = []
    for shard in discover_message_shards(db_path):
        derived_key, derived_salt = derive_database_key(
            shard, key_hex, salt_hex, passphrase)
        # Try the derived key first; fall back to the configured pair so
        # installs without a passphrase keep working exactly as before.
        candidates = [(derived_key, derived_salt)]
        if (derived_key, derived_salt) != (key_hex, salt_hex):
            candidates.append((key_hex, salt_hex))
        failure_reason = 'OPEN_FAILED'
        for candidate_key, candidate_salt in candidates:
            conn = None
            try:
                conn, _ = connect_nt_db(shard, candidate_key, candidate_salt)
                # PRAGMA key alone never fails; only a read surfaces a bad key.
                conn.execute('SELECT count(*) FROM sqlite_master').fetchone()
            except Exception:
                # Reached the database but could not decrypt it: the key is
                # wrong, not the file. Close before retrying, or the handle
                # leaks and on Windows the file stays locked.
                if conn is not None:
                    try:
                        conn.close()
                    except Exception:
                        pass
                failure_reason = 'KEY_REJECTED'
                continue
            pairs.append((shard, conn))
            break
        else:
            failures.append({'name': os.path.basename(shard), 'reason': failure_reason})
    return pairs, failures

def msg_tables(conn):
    """Names of the per-conversation Msg_ tables in one shard."""
    try:
        rows = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg\\_%' ESCAPE '\\'"
        ).fetchall()
    except Exception:
        return set()
    return {row[0] for row in rows}

def _strip_group_speaker(content, known_ids):
    """Drop the `wxid_...:` prefix group rows carry in their content.

    Only an id the shard's Name2Id actually knows is accepted, so a message
    that merely starts with `note: ...` is left alone.
    """
    match = re.match(r'^([A-Za-z0-9_@.-]{5,64})\s*[:：]\s', str(content or ''))
    if not match or match.group(1) not in known_ids:
        return content
    return content[match.end():]

MESSAGE_COLUMNS = ('local_id', 'server_id', 'local_type', 'real_sender_id',
                   'create_time', 'message_content')

APPMSG_SUBTYPE = 49

NON_TEXT_LABELS = {
    3: '图片', 34: '语音', 42: '名片', 43: '视频', 47: '表情', 48: '位置',
}

APPMSG_LABELS = {
    4: '链接', 5: '链接', 6: '文件', 19: '聊天记录', 33: '小程序', 57: '引用', 63: '直播',
    2000: '转账', 2001: '红包',
}

APPMSG_UNKNOWN_LABEL = '应用消息'

QUOTE_SEP = ' ｜ 引：'

QUOTE_CLIP = 120

ZSTD_MAGIC = bytes([0x28, 0xB5, 0x2F, 0xFD])

def _decode_content(raw):
    """消息内容 → 文本。BLOB 先按 zstd 解压（公众号消息同一套机制）。解不出回空串。"""
    if isinstance(raw, str):
        return raw
    if not raw:
        return ''
    data = bytes(raw)
    if data[:4] == ZSTD_MAGIC:        # zstd frame header
        try:
            import zstandard
            return zstandard.ZstdDecompressor().decompress(data).decode('utf-8', 'ignore')
        except Exception:
            return ''
    return data.decode('utf-8', 'ignore')

def _xml_block(xml, tag):
    """取一个元素的起始标签到它自己的结束标签之间的整段（含标签）。

    只在区块内找 `title`/`des`：整份 payload 里还有 `<emotionpageshared><title>` 这类
    同名标签，在全文里搜会匹配到那个去（自验时真的把一段 XML 当文本吐出来过）。
    """
    text = xml or ''
    match = re.search(r'<%s(?:\s[^>]*)?>.*?</%s>' % (tag, tag), text, re.S)
    return match.group(0) if match else ''

def _xml_text(xml, tag):
    """取一个标签的文本（含 CDATA）。取不到回空串——`<title />` 这种自闭合就是取不到。

    起始标签里**不许出现 `/`**：否则 `<title />` 会被当成开标签，一路吃到后面某个
    `</title>`，把中间整段 XML 当成文本返回（自验时真的吐出来过）。

    实体在这**解掉**：显示形态是给人（和模型）读的，`a&amp;b` 该显示成 `a&b`。
    TS 侧的 `appMsgFormat.tagText` 同样解，两边一致——否则同一条消息 3.x 与 4.x 读起来
    不一样。
    """
    match = re.search(
        r'<%s(?:\s[^>/]*)?>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</%s>' % (tag, tag), xml or '', re.S)
    return html.unescape(match.group(1).strip()) if match else ''

def _clip(text, limit):
    """超长截断并**留下省略号**。

    不标记的截断读起来像一句说完的话——`title[:60]` 此前就是这样，被引原文最长的
    12733 字，切完看着像"这就是全部"。
    """
    if len(text) <= limit:
        return text
    return text[:limit] + '…'

def non_text_display(local_type, raw):
    """非文本消息 → 给下游看的文本。**绝不返回空串**——这是这次修复的全部要点。

    宁可写 `[未识别的消息类型 81604378673]`，也不要让下游看到空字符串：空串在下游与
    "这条消息不存在"无法区分，而它的真实后果是助手回答"我没解析出内容"。
    """
    lt = int(local_type or 0)
    text = _decode_content(raw)

    if lt & 0xFFFFFFFF == APPMSG_SUBTYPE:
        apptype = lt >> 32
        label = APPMSG_LABELS.get(apptype, APPMSG_UNKNOWN_LABEL)
        block = _xml_block(text, 'appmsg')
        title = _xml_text(block, 'title') or _xml_text(block, 'des')
        # 实测 payload 里 `<emotionpageshared>` 这类**嵌套容器**也带 `<title>`，取到的是
        # 它们自己的占位值（`null`）。这种不是标题，按"没有标题"处理。
        if title.lower() in ('null', 'undefined', '0'):
            title = ''
        # 截断：解析万一走偏，也不许把一段 XML 当成标题交给下游。
        title = _clip(title, 60)
        # 引用消息（apptype 57）：`title` 是**回复正文**，被引用的原文在 `refermsg/content`。
        # 实测 37 条真实引用消息，被引原文中位 36 字。此前只留回复，模型看到的是一句
        # "是呀，够得意个"却不知道在回什么——引用不带原文等于没引用。
        if apptype == 57:
            quoted = _xml_text(_xml_block(text, 'refermsg'), 'content')
            if quoted.lower() in ('null', 'undefined', '0'):
                quoted = ''
            quoted = _clip(quoted, QUOTE_CLIP)
            if quoted:
                body = (title + QUOTE_SEP + quoted) if title else quoted
                return '[%s] %s' % (label, body)
        return '[%s] %s' % (label, title) if title else '[%s]' % label

    label = NON_TEXT_LABELS.get(lt)
    if label:
        return '[%s]' % label
    if lt == 10000:                       # 系统消息：撤回、拍一拍、入群提示
        return _xml_text(text, 'content') or '[系统消息]'
    return '[未识别的消息类型 %d]' % lt

def _message_dict(row, sender_id_map, name_map, own_wxid, is_group=False):
    """One message row -> the CLI's message shape.

    `row` is a column-name keyed dict, not a tuple. Positional access assumes
    every column exists; when a WeChat version drops one, the whole shard read
    fails and the conversation looks empty. Reading by name means a missing
    column costs that one field instead.
    """
    local_type = row.get('local_type') or 0
    create_time = row.get('create_time') or 0
    real_sender_id = row.get('real_sender_id') or 0

    # Resolve sender: real_sender_id -> Name2Id -> user_name
    sender_username = sender_id_map.get(real_sender_id, "")

    # Determine if message is from self
    # own_wxid may have _xxxx suffix (from xwechat_files dir), try both
    is_self = bool(own_wxid and (
        sender_username == own_wxid or
        (own_wxid.endswith('_') is False and sender_username.startswith(own_wxid))
    ))
    if not is_self and own_wxid:
        # Strip _xxxx suffix and retry
        parts = own_wxid.rsplit('_', 1)
        if len(parts) == 2 and len(parts[1]) == 4 and parts[1].isalnum():
            is_self = (sender_username == parts[0])

    # Resolve sender display name from contact map
    if is_self:
        sender_display = ""  # Let the CLI show "我"
    else:
        sender_display = name_map.get(sender_username, sender_username) if sender_username else sender_username

    # Parse message_content - TEXT column
    raw_content = row.get('message_content')
    content = raw_content if isinstance(raw_content, str) else ""

    # `content`/`rawContent` stay exactly as stored; only `parsedContent` - the
    # field every consumer reads first - gets the display-ready form.
    #
    # 非文本消息（图片/表情/文件/引用/撤回/红包…）在过去得到的是**空串**：它们的内容是
    # JSON 里不是 str 的 BLOB，上面那行会把它置空。现在它们走 `non_text_display`，
    # 至少拿到 `[图片]`，多数还能带上文件名、被引用的原文或"谁撤回了一条消息"。
    if content:
        display = _strip_group_speaker(content, set(sender_id_map.values())) if is_group else content
    else:
        display = non_text_display(local_type, raw_content)

    return {
        "localId": row.get('local_id') or 0,
        "serverId": str(row.get('server_id') or ''),
        "localType": local_type,
        "createTime": create_time,
        "isSend": 1 if is_self else 0,  # 1 = I sent this
        "senderUsername": sender_username,
        "senderDisplay": sender_display,
        "content": content,
        "rawContent": content,
        "parsedContent": display[:200] if local_type == 1 else display[:200],
    }

def get_messages(conns, talker, limit=100, offset=0, name_map=None, own_wxid=None,
                 shard_names=None, shard_report=None, from_time=None, to_time=None):
    """Get messages for a specific talker, merged across every shard.

    Args:
        name_map: optional {wxid: display_name} dict for resolving sender names
        own_wxid: account owner wxid for self-message detection
        shard_names: optional basename per connection, parallel to `conns`
        shard_report: optional list to append one outcome dict per shard to.
            Purely additive: the returned messages are identical with or
            without it, which is asserted by test/nt_decrypt_shards_test.py.
        from_time: optional inclusive lower bound on `create_time` (unix
            seconds), pushed into SQL so a bounded read does not have to fetch
            and discard the whole conversation.
        to_time: optional inclusive upper bound, same units.

    A requested window is only ever honoured or refused, never approximated: a
    shard whose table has no `create_time` is skipped and reported as
    WINDOW_UNAVAILABLE rather than returning out-of-range rows that a caller
    tracking coverage would count as covered. Every in-tree caller that passes
    a window also passes `shard_report`, so that refusal is always visible.
    """
    if name_map is None:
        name_map = {}

    window_requested = from_time is not None or to_time is not None

    msg_table = f"Msg_{hashlib.md5(talker.encode()).hexdigest()}"
    is_group = '@chatroom' in talker

    def record(index, opened, has_table, rows_for_talker, reason, missing=None):
        if shard_report is None:
            return
        name = shard_names[index] if shard_names and index < len(shard_names) else ''
        shard_report.append({
            'name': name,
            'opened': opened,
            'hasTalkerTable': has_table,
            'rowsForTalker': rows_for_talker,
            'reason': reason,
            # Columns this shard does not have. A non-empty list together with
            # a null `reason` means the read succeeded but lost fields, which is
            # a different thing from a failed read and has to stay visible.
            'missingColumns': list(missing or ()),
        })

    # Each shard only needs to yield its newest window: once every shard's rows
    # are merged and re-sorted, nothing older than that can reach this page.
    window = 0 if limit <= 0 else limit + offset
    collected = []
    found = False

    for index, conn in enumerate(conns):
        c = conn.cursor()
        try:
            c.execute("SELECT COUNT(*) FROM sqlite_master WHERE name=?", (msg_table,))
            if c.fetchone()[0] == 0:
                # The shard is readable and simply holds nothing for this
                # conversation - distinct from not being readable at all.
                record(index, True, False, None, None)
                continue
            found = True
            rows_for_talker = c.execute(
                'SELECT COUNT(*) FROM "%s"' % msg_table).fetchone()[0]

            available = table_columns(c, msg_table)
            selected = [col for col in MESSAGE_COLUMNS if col in available]
            missing = [col for col in MESSAGE_COLUMNS if col not in available]
            if not [col for col in MESSAGE_ANCHOR_COLUMNS if col in available]:
                # The row shape no longer matches anything the reader can name.
                record(index, True, True, rows_for_talker, 'SCHEMA_MISMATCH',
                       missing=missing)
                continue
            if window_requested and 'create_time' not in available:
                record(index, True, True, rows_for_talker, 'WINDOW_UNAVAILABLE',
                       missing=missing)
                continue

            order = [col for col in MESSAGE_ANCHOR_COLUMNS
                     if col in available]
            sql = 'SELECT %s FROM "%s"' % (
                ', '.join('"%s"' % col for col in selected), msg_table)
            params = []
            clauses = []
            if from_time is not None:
                clauses.append('"create_time" >= ?')
                params.append(from_time)
            if to_time is not None:
                clauses.append('"create_time" <= ?')
                params.append(to_time)
            if clauses:
                sql += ' WHERE ' + ' AND '.join(clauses)
            sql += ' ORDER BY ' + ', '.join('"%s" DESC' % col for col in order)
            if window:
                sql += ' LIMIT ?'
                params.append(window)
            c.execute(sql, params)
            # Dicts rather than driver rows: the SELECT list varies per shard,
            # so position no longer identifies a column. Built here rather than
            # via row_factory, which every other reader sharing these
            # connections would inherit.
            rows = [dict(zip(selected, values)) for values in c.fetchall()]

            # Sender ids are rowids, so the map has to come from the same
            # shard. Absent, it costs sender names and nothing else, so it is
            # probed rather than left to raise and lose the whole shard.
            has_name_table = c.execute(
                "SELECT COUNT(*) FROM sqlite_master WHERE name='Name2Id'").fetchone()[0] > 0
            sender_id_map = {}
            if has_name_table:
                c.execute("SELECT rowid, user_name FROM Name2Id")
                sender_id_map = {rowid: uname for rowid, uname in c.fetchall()}
        except Exception:
            # This shard had the conversation's table but could not be read.
            # Previously this was indistinguishable from "no rows here".
            record(index, True, None, None, 'READ_FAILED')
            continue
        record(index, True, True, rows_for_talker, None, missing=missing)

        for row in rows:
            collected.append(_message_dict(row, sender_id_map, name_map, own_wxid, is_group))

    if not found:
        return {"error": f"未找到会话: {talker}"}

    collected.sort(key=lambda m: (m["createTime"], m["localId"]), reverse=True)
    if limit > 0:
        collected = collected[offset:offset + limit]
    return {"messages": collected}
