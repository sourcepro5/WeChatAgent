"""Outer API adapter for the unchanged weflow-cli NT reader.

Database credentials remain in the existing private configuration. Only the
selected account and explicitly selected conversations are read for pushes.
"""
import base64
import ctypes
import ctypes.wintypes as wintypes
import hashlib
import hmac
import json
import pathlib
import queue
import re
import sys
import threading
import time
import uuid
import subprocess
import concurrent.futures
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit
import xml.etree.ElementTree as ET

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from wechat_media import clean_account_wxid
from wechat_forwarded import FORWARD_TYPE, parse_forwarded_record
from wechat_quote import QUOTE_TYPE, parse_quote_reply
from wechat_sticker_send import sticker_send_fields, sticker_receipt_md5, APPMSG_STICKER_TYPE, native_gif_bytes
from wechat_sticker import emoji_attributes, resolve_sticker_bytes
from wechat_sticker_labels import StickerLabels, clean_label

PAT_TYPE = (62 << 32) | 49


def parse_pat(content, sender, own_wxid):
    """System pats may omit the DB sender; validate their XML actor/target."""
    if not content or len(content) > 100_000 or '<!DOCTYPE' in content.upper() or '<!ENTITY' in content.upper():
        return None
    try:
        root = ET.fromstring(content)
        app = root.find('appmsg') if root.tag == 'msg' else None
        info = app.find('patinfo') if app is not None else None
        if app is None or app.findtext('type') != '62' or info is None:
            return None
        actor, target = info.findtext('fromusername', ''), info.findtext('pattedusername', '')
        own = clean_account_wxid(own_wxid)
        if not actor or (sender and actor != sender) or clean_account_wxid(actor) == own or target != own:
            return None
        return {'actor': actor, 'target': target}
    except ET.ParseError:
        return None

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'components' / 'weflow-cli' / 'scripts'))
import nt_decrypt as nt


def read_json(file):
    return json.loads(pathlib.Path(file).read_text(encoding='utf-8-sig'))


def local_secret(value):
    if not value.startswith('userdpapi:'):
        if value.startswith('safe:'):
            raise RuntimeError('Legacy secret requires its original WeFlow process')
        return value
    class Blob(ctypes.Structure):
        _fields_ = [('cbData', wintypes.DWORD), ('pbData', ctypes.POINTER(ctypes.c_ubyte))]
    crypt = ctypes.WinDLL('crypt32', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    crypt.CryptUnprotectData.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p,
        ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    crypt.CryptUnprotectData.restype = wintypes.BOOL
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    data = base64.b64decode(value.split(':', 1)[1])
    buffer = (ctypes.c_ubyte * len(data)).from_buffer_copy(data)
    source, output = Blob(len(data), buffer), Blob()
    if not crypt.CryptUnprotectData(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(output)):
        raise RuntimeError('Windows current-user credential decryption failed')
    try:
        return ctypes.string_at(output.pbData, output.cbData).decode('utf-8')
    finally:
        kernel.LocalFree(output.pbData)


def onebot_id(identifier):
    return str(int.from_bytes(hashlib.sha256(identifier.encode()).digest()[:8], 'big') % 2147483647 + 1)


def conversation_id(talker, names):
    # Group IDs use the existing displayed, normalized group name.
    # Keeping that contract preserves the existing whitelist and DSH sessions.
    identity = re.sub(r'\s*\(\d+\)\s*$', '', names.get(talker, talker)).strip() if '@chatroom' in talker else talker
    return onebot_id(identity)


def push_payload(talker, message, names, own_wxid):
    sender = message.get('senderUsername', '')
    if message.get('isSend'):
        return None
    kind = message.get('localType')
    if kind not in (1, 3, 47, PAT_TYPE, 49, FORWARD_TYPE, QUOTE_TYPE):
        return None
    pat = parse_pat(message.get('fullText', ''), sender, own_wxid) if kind == PAT_TYPE else None
    if kind == PAT_TYPE and not pat:
        return None
    if pat:
        sender = pat['actor']
    if not sender or clean_account_wxid(sender) == clean_account_wxid(own_wxid):
        return None
    forwarded = parse_forwarded_record(message.get('fullText', '')) if kind in (49, FORWARD_TYPE) else None
    quote_reply = parse_quote_reply(message.get('fullText', '')) if kind in (49, QUOTE_TYPE) else None
    if kind in (49, FORWARD_TYPE, QUOTE_TYPE) and forwarded is None and quote_reply is None:
        return None
    content = '[图片]' if kind == 3 else '[表情包：附件为静态画面或动画采样画面]' if kind == 47 else '[拍一拍] 对方刚刚拍了拍你。' if pat else '[合并转发聊天记录] ' + forwarded['title'] if forwarded else (quote_reply['reply'] or '[引用回复，正文为空]') if quote_reply else message.get('fullText', message.get('content') or message.get('parsedContent', ''))
    if not content.strip():
        return None
    group = '@chatroom' in talker
    rawid = hashlib.sha256(json.dumps([talker, message.get('serverId'),
        message.get('localId'), message.get('createTime')], separators=(',', ':')).encode()).hexdigest()
    return {'event': 'message.new', 'sessionId': talker,
        'sessionType': 'group' if group else 'private', 'rawid': rawid,
        'groupName': names.get(talker, talker) if group else '',
        'sourceName': names.get(sender, sender) if group else names.get(talker, talker),
        'senderName': names.get(sender, sender), 'talkerId': sender,
        'content': content[:4000], 'type': kind, 'timestamp': message.get('createTime', 0),
        **({'pat': pat} if pat else {}),
        **({'forwardedRecord': forwarded} if forwarded else {}),
        **({'quoteReply': quote_reply} if quote_reply else {}),
        **({'image': {'localId': message.get('localId'), 'serverId': message.get('serverId'),
            'createTime': message.get('createTime'), 'localType': kind}} if kind in (3, 47) else {})}


class Reader:
    def __init__(self, root=ROOT):
        self.root = pathlib.Path(root)
        self.settings_file = self.root / 'state' / 'weflow' / 'WeFlow-config.json'
        settings = read_json(self.settings_file)
        selected = local_secret(settings['myWxid'])
        database_root = pathlib.Path(local_secret(settings['dbPath']))
        self.account = database_root if (database_root / 'db_storage').is_dir() else database_root / selected
        if not (self.account / 'db_storage').is_dir():
            raise RuntimeError('Selected account database directory is unavailable')
        self.message_db = self.account / 'db_storage' / 'message' / 'message_0.db'
        self.contact_db = self.account / 'db_storage' / 'contact' / 'contact.db'
        self.passphrase = local_secret(settings['decryptKey'])
        if nt.verify_passphrase_native(self.passphrase, str(self.message_db)) is not True:
            raise RuntimeError('Selected account database credential verification failed')
        self.own_wxid = read_json(self.root / 'state' / 'wechat-io-config.json').get('self_wxid') or clean_account_wxid(selected)
        self.names = {}
        self.names_lock = threading.Lock()
        self.names_refreshed_at = 0
        self.refresh_names()
        self.clients = set()
        self.lock = threading.Lock()
        self.seen = OrderedDict()
        self.started_at = int(time.time())
        self.last_poll = 0
        self.last_error = ''
        self.pushed = 0
        self.image_dir = self.root / 'state' / 'media'
        self.image_dir.mkdir(parents=True, exist_ok=True)
        self.image_index_file = self.image_dir / 'index.json'
        self.image_index = read_json(self.image_index_file) if self.image_index_file.exists() else {}
        self.image_jobs = {}
        self.image_executor = concurrent.futures.ThreadPoolExecutor(max_workers=2)
        self.sticker_jobs = {}
        self.sticker_retry_at = {}
        self.sticker_executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
        self.sticker_labels = StickerLabels(self.root/'state/stickers/labels.json')
        self.image_error = ''
        self.stop = threading.Event()
        # Probe actual message shards now; listening on a port is not readiness.
        connections = self.open_messages()
        for connection in connections:
            connection.close()

    def refresh_names(self, max_age=0):
        with self.names_lock:
            if max_age and time.monotonic() - self.names_refreshed_at < max_age:
                return
            key, salt = nt.derive_database_key(str(self.contact_db), '', '', self.passphrase)
            names = nt.load_contact_names(str(self.contact_db), key, salt)
            if not names:
                raise RuntimeError('Contact database could not be read')
            self.names = names
            self.names_refreshed_at = time.monotonic()

    def contacts(self, keyword='', kind='', limit=100):
        # Metadata discovery includes unselected chats without opening message shards.
        self.refresh_names(max_age=30)
        names = self.names
        keyword = keyword.strip().casefold()
        counts = {}
        for talker in names:
            if '@chatroom' in talker:
                identity = conversation_id(talker, names)
                counts[identity] = counts.get(identity, 0) + 1
        contacts = []
        for talker, name in names.items():
            group = '@chatroom' in talker
            if kind in ('groups', 'private') and group != (kind == 'groups'):
                continue
            if keyword not in (talker + name).casefold():
                continue
            contacts.append({'username': talker, 'displayName': name,
                'ambiguous': group and counts[conversation_id(talker, names)] > 1})
            if len(contacts) >= limit:
                break
        return contacts

    def open_messages(self):
        pairs, failures = nt.connect_message_shards_detailed(str(self.message_db), '', '', self.passphrase)
        if failures or not pairs:
            for _, connection in pairs:
                connection.close()
            raise RuntimeError('One or more message shards could not be read')
        connections = [connection for _, connection in pairs]
        for connection in connections:
            connection.execute('PRAGMA query_only=ON')
        return connections

    def selected_talkers(self):
        settings = read_json(self.settings_file)
        project = read_json(self.root / 'config' / 'wechatagent.json')
        ids = set(map(str, project['wechat']['whitelist']['groups'] + project['wechat']['whitelist']['private']))
        # The upstream selector is also used to discover numeric friend IDs.
        return list(dict.fromkeys(list(settings.get('messagePushFilterList', [])) +
            [talker for talker in self.names if conversation_id(talker, self.names) in ids]))

    def messages(self, talker, limit=100, from_time=None):
        if talker not in self.selected_talkers():
            raise PermissionError('Conversation is not selected')
        connections = self.open_messages()
        try:
            reports = []
            data = nt.get_messages(connections, talker, limit=limit, name_map=self.names,
                own_wxid=self.own_wxid, from_time=from_time, shard_report=reports)
            if any(report.get('reason') for report in reports):
                raise RuntimeError('Message query did not cover every readable shard')
            # Preserve complete text: the upstream CLI display truncates to 200.
            table = 'Msg_' + hashlib.md5(talker.encode()).hexdigest()
            for message in data.get('messages', []):
                if message.get('localType') not in (1, PAT_TYPE, 49, FORWARD_TYPE, QUOTE_TYPE, 47, APPMSG_STICKER_TYPE):
                    continue
                for connection in connections:
                    if table not in nt.msg_tables(connection):
                        continue
                    row = connection.execute('SELECT message_content FROM "' + table +
                        '" WHERE local_id=? AND create_time=? AND server_id=? LIMIT 1',
                        (message['localId'], message['createTime'], message['serverId'] or 0)).fetchone()
                    if row:
                        text = nt._decode_content(row[0])
                        message['fullText'] = nt._strip_group_speaker(text, set(self.names) | {message['senderUsername']}) if '@chatroom' in talker else text
                        md5=sticker_receipt_md5(message.get('localType'),message['fullText'])
                        if md5:
                            message['stickerMd5']=md5
                            message['stickerKind']='emoji-47' if message.get('localType')==47 else 'appmsg-8'
                        break
            return data.get('messages', [])
        finally:
            for connection in connections:
                connection.close()

    def sessions(self, limit=100):
        # Avoid scanning unrelated message histories merely to list sessions.
        return [{'username': talker, 'displayName': self.names.get(talker, talker),
            'type': 1 if '@chatroom' in talker else 0} for talker in self.selected_talkers()][:limit]

    def image_talker_allowed(self, talker):
        config = read_json(self.root / 'config' / 'wechatagent.json')
        kind = 'groups' if '@chatroom' in talker else 'private'
        return conversation_id(talker, self.names) in map(str, config['wechat']['whitelist'][kind])

    def image_row(self, talker, descriptor):
        if not self.image_talker_allowed(talker):
            raise PermissionError('Image conversation is not allowed')
        connections = self.open_messages()
        try:
            table = 'Msg_' + hashlib.md5(talker.encode()).hexdigest()
            for connection in connections:
                if table not in nt.msg_tables(connection):
                    continue
                row = connection.execute('SELECT local_type,message_content FROM "' + table + '" WHERE local_id=? AND create_time=? AND server_id=? LIMIT 1',
                    (descriptor['localId'], descriptor['createTime'], int(descriptor['serverId'] or 0))).fetchone()
                if row and row[0] in (3, 47) and row[0] == descriptor.get('localType', 3):
                    content = nt._decode_content(row[1])
                    if '@chatroom' in talker:
                        content = nt._strip_group_speaker(content, set(self.names) | {self.own_wxid, descriptor.get('sender', '')})
                    return {'imageXml': content.lstrip(), 'localType': row[0]}
        finally:
            for connection in connections:
                connection.close()
        raise RuntimeError('IMAGE_MESSAGE_IDENTITY_NOT_FOUND')

    def register_image(self, talker, payload):
        if not self.image_talker_allowed(talker):
            return None
        image_id = hashlib.sha256(json.dumps([self.own_wxid, talker, payload['rawid']]).encode()).hexdigest()
        descriptor = {'talker': talker, **payload['image'], 'account': self.account.name, 'sender': payload['talkerId']}
        with self.lock:
            self.image_index[image_id] = descriptor
            for expired in list(self.image_index)[:-1000]:
                self.image_index.pop(expired, None)
                cache = self.image_dir / (expired + '.json')
                if re.fullmatch(r'[a-f0-9]{64}', expired) and cache.is_file():
                    cache.unlink()
            temp = self.image_index_file.with_suffix('.tmp')
            temp.write_text(json.dumps(self.image_index), encoding='utf-8')
            temp.replace(self.image_index_file)
        return image_id

    def resolve_image(self, image_id):
        descriptor = self.image_index.get(image_id)
        if not descriptor or descriptor.get('account') != self.account.name or not self.image_talker_allowed(descriptor['talker']):
            raise PermissionError('Image is unavailable or not authorized')
        cache = self.image_dir / (image_id + '.json')
        if cache.is_file():
            return read_json(cache)
        def run():
            process = subprocess.run([sys.executable, '-B', str(self.root / 'scripts' / 'resolve-wechat-image.py')],
                input=json.dumps(descriptor), capture_output=True, text=True, encoding='utf-8', timeout=65,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            if process.returncode:
                self.image_error = 'IMAGE_RESOLUTION_FAILED'
                try:
                    error = json.loads(process.stderr.strip().splitlines()[-1]).get('error', '')
                    if re.fullmatch(r'IMAGE_[A-Z_]{3,80}', error):
                        self.image_error = error
                except (ValueError, IndexError):
                    pass
                raise RuntimeError(self.image_error)
            result = json.loads(process.stdout.strip().splitlines()[-1])
            if not result.get('b64'):
                raise RuntimeError('IMAGE_RESOLUTION_EMPTY')
            result['imageId'] = image_id
            result['conversationKey'] = 'wechat:' + ('group:' if '@chatroom' in descriptor['talker'] else 'private:') + conversation_id(descriptor['talker'], self.names)
            temp = cache.with_suffix('.tmp')
            temp.write_text(json.dumps(result), encoding='utf-8')
            temp.replace(cache)
            self.image_error = ''
            return result
        with self.lock:
            future = self.image_jobs.get(image_id)
            if future is None or future.done() and future.exception() is not None:
                future = self.image_executor.submit(run)
                self.image_jobs[image_id] = future
        try:
            return future.result(timeout=70)
        finally:
            with self.lock:
                if future.done() and self.image_jobs.get(image_id) is future:
                    self.image_jobs.pop(image_id, None)

    def sticker_candidates(self, key):
        candidates=[]
        for image_id, descriptor in self.image_index.items():
            if descriptor.get('localType')!=47 or descriptor.get('account')!=self.account.name:
                continue
            talker=descriptor['talker']
            current='wechat:'+('group:' if '@chatroom' in talker else 'private:')+conversation_id(talker,self.names)
            if current==key and self.image_talker_allowed(talker):
                candidates.append({'id':image_id,'receivedAt':descriptor['createTime']})
        candidates=sorted(candidates,key=lambda item:item['receivedAt'],reverse=True)[:8]
        available=[]
        # Preparing a missing local/CDN resource must not hold up ordinary
        # replies. Offer only prepared native GIFs; a future batch sees them.
        for candidate in candidates:
            with self.lock:
                future=self.sticker_jobs.get(candidate['id'])
                retry=future is not None and future.done() and not future.cancelled() and isinstance(future.exception(),RuntimeError) and str(future.exception()).startswith('IMAGE_') and time.monotonic()>=self.sticker_retry_at.get(candidate['id'],0)
                if future is None or future.cancelled() or retry:
                    future=self.sticker_executor.submit(self.resolve_sticker,candidate['id'],key)
                    self.sticker_jobs[candidate['id']]=future
                    self.sticker_retry_at[candidate['id']]=time.monotonic()+30
            if future.done() and not future.cancelled() and future.exception() is None:
                label=None
                if hasattr(self,'sticker_labels') and self.label_cache_enabled():
                    label=self.sticker_labels.get(self.account.name,future.result()['sourceMd5'])
                available.append({**candidate,**(label or {})})
        return available

    def label_cache_enabled(self):
        return read_json(self.root/'config/wechatagent.json').get('wechat',{}).get('stickers',{}).get('labelCache',True) is True

    def sticker_source(self,image_id,key):
        descriptor=self.image_index.get(image_id)
        if not descriptor or descriptor.get('localType')!=47 or descriptor.get('account')!=self.account.name:raise PermissionError('Sticker is unavailable')
        talker=descriptor['talker']
        current='wechat:'+('group:' if '@chatroom' in talker else 'private:')+conversation_id(talker,self.names)
        if current!=key or not self.image_talker_allowed(talker):raise PermissionError('Sticker conversation mismatch')
        return sticker_send_fields(self.image_row(talker,descriptor)['imageXml'])['md5']

    def labels_for(self,ids,key):
        if not isinstance(ids,list) or len(ids)>4 or any(not isinstance(item,str) or not re.fullmatch('[a-f0-9]{64}',item) for item in ids):raise ValueError('Invalid sticker references')
        result=[]
        for image_id in ids:
            md5=self.sticker_source(image_id,key)
            label=self.sticker_labels.get(self.account.name,md5) if self.label_cache_enabled() else None
            if label:result.append({'id':image_id,**label})
        return result

    def save_labels(self,items,key):
        if not isinstance(items,list) or len(items)>4:raise ValueError('Invalid label batch')
        updates=[]
        for item in items:
            if not isinstance(item,dict) or not isinstance(item.get('id'),str) or not re.fullmatch('[a-f0-9]{64}',item['id']):raise ValueError('Invalid label reference')
            updates.append((self.sticker_source(item['id'],key),clean_label(item)))
        if not self.label_cache_enabled():return {'saved':0}
        with self.lock:self.sticker_labels.save(self.account.name,updates)
        return {'saved':len(updates)}

    def resolve_sticker(self, image_id, key):
        descriptor=self.image_index.get(image_id)
        if not descriptor or descriptor.get('localType')!=47 or descriptor.get('account')!=self.account.name:
            raise PermissionError('Sticker reference is unavailable')
        talker=descriptor['talker']
        current='wechat:'+('group:' if '@chatroom' in talker else 'private:')+conversation_id(talker,self.names)
        if current!=key or not self.image_talker_allowed(talker):
            raise PermissionError('Sticker conversation mismatch')
        row=self.image_row(talker,descriptor)
        fields=sticker_send_fields(row['imageXml'])
        project=read_json(self.root/'config/wechatagent.json');media=project.get('wechat',{}).get('media',{})
        raw=resolve_sticker_bytes(self.account,row['imageXml'],allow_cdn=media.get('allowStickerCdn') is True,allow_cdn_alias=media.get('allowStickerCdnAlias') is True)
        source_md5=fields['md5']
        raw=native_gif_bytes(raw)
        fields={**fields,'md5':hashlib.md5(raw).hexdigest(),'len':len(raw)}
        extension='.gif'
        folder=self.root/'state/stickers/outgoing';folder.mkdir(parents=True,exist_ok=True)
        file=folder/(fields['md5']+extension)
        if file.exists() and hashlib.md5(file.read_bytes()).hexdigest()!=fields['md5']:raise RuntimeError('STICKER_CACHE_INTEGRITY_FAILED')
        if not file.exists():
            temp=file.with_suffix(extension+'.'+uuid.uuid4().hex+'.tmp');temp.write_bytes(raw);temp.replace(file)
        return {'id':image_id,'conversationKey':current,'sourceMd5':source_md5,'format':'gif','fields':fields,'path':str(file.resolve())}

    def poll(self):
        since = self.started_at
        while not self.stop.is_set():
            try:
                newest = since
                for talker in self.selected_talkers():
                    # No historical replay on startup; retain a small overlap.
                    messages = self.messages(talker, limit=0, from_time=max(self.started_at, since - 3))
                    for message in reversed(messages):
                        newest = max(newest, message.get('createTime', 0))
                        payload = push_payload(talker, message, self.names, self.own_wxid)
                        if not payload or payload['rawid'] in self.seen:
                            continue
                        if payload['type'] in (3, 47):
                            image_id = self.register_image(talker, payload)
                            if not image_id:
                                continue
                            payload['image'] = {'id': image_id}
                        self.seen[payload['rawid']] = True
                        while len(self.seen) > 5000:
                            self.seen.popitem(last=False)
                        with self.lock:
                            for client in list(self.clients):
                                try:
                                    client.put_nowait(payload)
                                except queue.Full:
                                    self.clients.discard(client)
                        self.pushed += 1
                        print('Reader incoming ' + ('sticker' if payload['type'] == 47 else 'image' if payload['type'] == 3 else 'pat' if payload['type'] == PAT_TYPE else 'text') + '; OneBot conversation=' + conversation_id(talker, self.names), flush=True)
                since = newest
                self.last_poll = time.time()
                self.last_error = ''
            except Exception as error:
                self.last_error = type(error).__name__
                print('Reader polling failed: ' + self.last_error, flush=True)
            self.stop.wait(1)

    def replay_image(self, image_id):
        # Explicit authenticated retry only; startup never replays history.
        descriptor = self.image_index.get(image_id)
        self.resolve_image(image_id)  # Account, whitelist and file validation.
        messages = self.messages(descriptor['talker'], limit=0, from_time=descriptor['createTime'])
        message = next((row for row in messages if row['localId'] == descriptor['localId']
            and row['createTime'] == descriptor['createTime']
            and str(row['serverId']) == str(descriptor['serverId'])), None)
        payload = push_payload(descriptor['talker'], message or {}, self.names, self.own_wxid)
        if not payload or payload['type'] not in (3, 47):
            raise RuntimeError('IMAGE_MESSAGE_IDENTITY_NOT_FOUND')
        payload['image'] = {'id': image_id}
        with self.lock:
            if not self.clients:
                raise RuntimeError('IMAGE_RECEIVER_NOT_CONNECTED')
            replayed = getattr(self, 'replayed_images', set())
            if image_id in replayed:
                return False
            for client in self.clients:
                client.put_nowait(payload)
            replayed.add(image_id)
            self.replayed_images = replayed
        print('Reader explicitly retried incoming image.', flush=True)
        return True

    def replay_event(self, descriptor):
        """Explicit diagnostic retry of one exact inbound media/pat message."""
        target = str(descriptor.get('conversationId', ''))
        talkers = [talker for talker in self.selected_talkers()
            if conversation_id(talker, self.names) == target and self.image_talker_allowed(talker)]
        if len(talkers) != 1:
            raise PermissionError('Conversation is not allowed or ambiguous')
        talker = talkers[0]
        messages = self.messages(talker, limit=0, from_time=int(descriptor['createTime']))
        row = next((message for message in messages
            if message['localId'] == int(descriptor['localId'])
            and message['createTime'] == int(descriptor['createTime'])
            and str(message['serverId']) == str(descriptor['serverId'])), None)
        payload = push_payload(talker, row or {}, self.names, self.own_wxid)
        if not payload or payload['type'] not in (3, 47, PAT_TYPE):
            raise RuntimeError('IMAGE_EVENT_IDENTITY_NOT_FOUND')
        if payload['type'] in (3, 47):
            image_id = self.register_image(talker, payload)
            return self.replay_image(image_id)
        with self.lock:
            if payload['rawid'] in self.seen:
                return False
            if not self.clients or any(client.full() for client in self.clients):
                raise RuntimeError('IMAGE_RECEIVER_NOT_CONNECTED')
            for client in self.clients:
                client.put_nowait(payload)
            self.seen[payload['rawid']] = True
        print('Reader explicitly retried incoming pat.', flush=True)
        return True


def serve(reader, port, token):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def log_message(self, *_):
            pass  # URL query parameters can contain the authentication token.

        def respond(self, body, status=200):
            raw = json.dumps(body, ensure_ascii=False).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self):
            url = urlsplit(self.path)
            query = parse_qs(url.query)
            supplied = self.headers.get('Authorization', '').removeprefix('Bearer ') or query.get('access_token', [''])[0]
            if not token or not hmac.compare_digest(supplied, token):
                self.respond({'success': False, 'error': 'Unauthorized'}, 401)
                return
            try:
                limit = min(500, max(1, int(query.get('limit', ['100'])[0])))
                if url.path == '/api/v1/push/messages':
                    self.send_response(200)
                    self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
                    self.send_header('Cache-Control', 'no-cache')
                    self.send_header('Connection', 'close')
                    self.send_header('Transfer-Encoding', 'chunked')
                    self.end_headers()
                    client = queue.Queue(maxsize=500)
                    with reader.lock:
                        reader.clients.add(client)
                    try:
                        while not reader.stop.is_set():
                            try:
                                payload = client.get(timeout=2)
                                line = 'data: ' + json.dumps(payload, ensure_ascii=False) + '\n\n'
                            except queue.Empty:
                                line = ': heartbeat\n\n'
                            raw = line.encode('utf-8')
                            self.wfile.write(('%x\r\n' % len(raw)).encode() + raw + b'\r\n')
                            self.wfile.flush()
                    finally:
                        with reader.lock:
                            reader.clients.discard(client)
                    self.close_connection = True
                elif url.path == '/api/v1/sessions':
                    connections = reader.open_messages()
                    for connection in connections:
                        connection.close()
                    self.respond({'success': True, 'sessions': reader.sessions(limit)})
                elif url.path == '/api/v1/contacts':
                    contacts = reader.contacts(query.get('keyword', [''])[0], query.get('kind', [''])[0], limit)
                    self.respond({'success': True, 'contacts': contacts})
                elif url.path == '/api/v1/messages':
                    talker = query.get('talker', [''])[0]
                    self.respond({'success': True, 'messages': reader.messages(talker, limit) if talker else []})
                elif url.path == '/api/v1/reader/status':
                    self.respond({'success': True, 'backend': 'weflow-cli-nt', 'lastPoll': reader.last_poll,
                        'lastError': reader.last_error, 'subscribers': len(reader.clients), 'pushed': reader.pushed,
                        'ownWxid': reader.own_wxid, 'accountDirectory': reader.account.name,
                        'imagesRegistered': len(reader.image_index), 'lastImageError': reader.image_error})
                elif re.fullmatch(r'/api/v1/images/[a-f0-9]{64}', url.path):
                    self.respond(reader.resolve_image(url.path.rsplit('/', 1)[1]))
                elif url.path == '/api/v1/stickers':
                    self.respond({'stickers':reader.sticker_candidates(query.get('conversationKey',[''])[0])})
                elif re.fullmatch(r'/api/v1/stickers/[a-f0-9]{64}',url.path):
                    self.respond(reader.resolve_sticker(url.path.rsplit('/',1)[1],query.get('conversationKey',[''])[0]))
                else:
                    self.respond({'success': False, 'error': 'Not found'}, 404)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass
            except PermissionError:
                self.respond({'success': False, 'error': 'Conversation is not selected'}, 403)
            except Exception as error:
                self.respond({'success': False, 'error': 'Reader query failed: ' + type(error).__name__}, 503)

        def do_POST(self):
            supplied = self.headers.get('Authorization', '').removeprefix('Bearer ')
            if not token or not hmac.compare_digest(supplied, token):
                self.respond({'success': False, 'error': 'Unauthorized'}, 401)
                return
            if self.path == '/api/v1/stickers/labels':
                try:
                    size=int(self.headers.get('Content-Length','0'))
                    if not 0<size<=8192:raise ValueError()
                    body=json.loads(self.rfile.read(size))
                    key=body.get('conversationKey','')
                    result=reader.labels_for(body.get('ids'),key) if body.get('operation')=='read' else reader.save_labels(body.get('labels'),key) if body.get('operation')=='save' else None
                    if result is None:raise ValueError()
                    self.respond({'labels':result} if isinstance(result,list) else result)
                except PermissionError:self.respond({'error':'Sticker conversation mismatch'},403)
                except ValueError:self.respond({'error':'Invalid sticker labels'},400)
                except Exception:self.respond({'error':'Sticker labels unavailable'},503)
                return
            if self.path == '/api/v1/events/retry':
                try:
                    size = int(self.headers.get('Content-Length', '0'))
                    if not 0 < size <= 1024:
                        raise ValueError()
                    descriptor = json.loads(self.rfile.read(size))
                    pushed = reader.replay_event(descriptor)
                    self.respond({'success': True, 'pushed': pushed})
                except PermissionError:
                    self.respond({'success': False, 'error': 'Conversation is not authorized'}, 403)
                except Exception:
                    self.respond({'success': False, 'error': 'EVENT_RETRY_FAILED'}, 503)
                return
            if not re.fullmatch(r'/api/v1/images/[a-f0-9]{64}/retry', self.path) or int(self.headers.get('Content-Length', '0')) != 0:
                self.respond({'success': False, 'error': 'Invalid image retry'}, 400)
                return
            try:
                pushed = reader.replay_image(self.path.split('/')[-2])
                self.respond({'success': True, 'pushed': pushed})
            except PermissionError:
                self.respond({'success': False, 'error': 'Image is not authorized'}, 403)
            except Exception as error:
                code = str(error) if isinstance(error, RuntimeError) and re.fullmatch(r'IMAGE_[A-Z_]{3,80}', str(error)) else 'IMAGE_RETRY_FAILED'
                self.respond({'success': False, 'error': code}, 503)

    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    threading.Thread(target=reader.poll, daemon=True).start()
    print('Independent reader ready; database and contacts verified.', flush=True)
    try:
        server.serve_forever()
    finally:
        reader.stop.set()
        reader.sticker_executor.shutdown(wait=False,cancel_futures=True)
        server.server_close()


if __name__ == '__main__':
    try:
        reader = Reader()
        if '--check' in sys.argv:
            print(json.dumps({'databaseReady': True, 'contactNamesLoaded': bool(reader.names),
                'selectedConversations': len(reader.selected_talkers())}))
        else:
            config = read_json(ROOT / 'config' / 'wechatagent.json')
            token = read_json(ROOT / 'state' / 'wechat-io-config.json')['reader_token']
            serve(reader, config['ports']['weflow'], token)
    except Exception as error:
        print('Reader initialization failed: ' + str(error) if isinstance(error, RuntimeError) else 'Reader initialization failed: ' + type(error).__name__, file=sys.stderr)
        sys.exit(1)
