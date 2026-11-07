"""Synthetic voice DBs only; never reads real accounts or makes network calls."""
import base64
import hashlib
import importlib.util
import json
import pathlib
import sqlite3
import sys
import tempfile
import threading
import types
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from wechat_voice_input import VoiceCatalog, voice_info, audio_policy, load_voice_blob

spec = importlib.util.spec_from_file_location('voice_reader_test', pathlib.Path(__file__).with_name('reader-api.py'))
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)

KEY = 'wechat:private:123'
SILK = b'\x02#!SILK_V3\nsynthetic'


class VoiceBoundaries(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.account = self.root/'account'
        (self.account/'db_storage/message').mkdir(parents=True)
        (self.root/'config').mkdir()
        (self.root/'config/wechatagent.json').write_text(json.dumps({'wechat': {'whitelist': {'private': ['123'], 'groups': []}}}))
        self.policy = {'version': 1, 'plugins': {'speech-recognition': {'enabled': True, 'permissions': ['audio_read'], 'chats': [KEY]}}}
        self.save_policy()
        self.active = True
        self.catalog = VoiceCatalog(self.root, self.account, lambda: self.active)
        self.message = {'localType': 34, 'senderUsername': 'contact-alpha', 'localId': 7, 'serverId': '123456789012345678', 'createTime': 100, 'fullText': '<msg><voicemsg voicelength="2500"/></msg>'}
        self.payload = api.push_payload('contact-alpha', self.message, {}, 'owner-account')
        self.ref = self.catalog.remember('contact-alpha', self.payload, KEY)

    def save_policy(self):
        (self.root/'config/plugins.json').write_text(json.dumps(self.policy))

    def shard(self, name='media_0.db', blob=SILK, talker='contact-alpha', local_id=7):
        file = self.account/'db_storage/message'/name
        connection = sqlite3.connect(file)
        connection.executescript('CREATE TABLE Name2Id(user_name TEXT); CREATE TABLE VoiceInfo(chat_name_id INTEGER,local_id INTEGER,voice_data BLOB);')
        connection.execute('INSERT INTO Name2Id(rowid,user_name) VALUES(1,?)', (talker,))
        connection.execute('INSERT INTO VoiceInfo VALUES(1,?,?)', (local_id, blob))
        connection.commit()
        connection.close()
        return file

    def nt(self):
        def connect(file, *_):
            connection = sqlite3.connect(file)
            return connection, connection.cursor()
        return types.SimpleNamespace(derive_database_key=lambda *_: ('', ''), connect_nt_db=connect)

    def test_voice_payload_is_bounded_metadata_and_excludes_xml_and_self_messages(self):
        self.assertEqual(self.payload['content'], '[语音，尚未转写]')
        self.assertEqual(self.payload['voice']['durationSeconds'], 2.5)
        self.assertNotIn('voicemsg', json.dumps(self.payload))
        self.assertIsNone(api.push_payload('contact-alpha', {**self.message, 'isSend': True}, {}, 'owner-account'))
        self.assertIsNone(voice_info('<!DOCTYPE msg><msg><voicemsg voicelength="1"/></msg>'))
        self.assertIsNone(voice_info('<msg><voicemsg voicelength="60001"/></msg>'))

    def test_disabled_plugin_wrong_chat_account_or_missing_grant_never_returns_audio(self):
        self.assertTrue(audio_policy(self.root, KEY))
        self.assertTrue(audio_policy(self.root, KEY, 'speech-recognition'))
        self.assertFalse(audio_policy(self.root, KEY, ''))
        self.assertFalse(audio_policy(self.root, KEY, 'other-plugin'))
        with self.assertRaises(PermissionError): self.catalog.record(self.ref['id'], 'wechat:private:456', 'speech-recognition')
        self.policy['plugins']['speech-recognition']['permissions'] = []
        self.save_policy()
        with self.assertRaises(PermissionError): self.catalog.record(self.ref['id'], KEY, 'speech-recognition')
        self.assertIsNone(self.catalog.remember('contact-alpha', self.payload, KEY))
        self.active = False
        with self.assertRaises(PermissionError): self.catalog.record(self.ref['id'], KEY, 'speech-recognition')

    def test_same_local_id_in_another_chat_is_never_selected(self):
        self.shard(talker='another-chat')
        item = {**self.catalog.record(self.ref['id'], KEY, 'speech-recognition'), 'passphrase': 'fixture'}
        with self.assertRaisesRegex(RuntimeError, 'VOICE_AUDIO_NOT_AVAILABLE'): load_voice_blob(self.account, item, self.nt())

    def test_exact_chat_local_id_and_conflicting_shards_are_checked(self):
        self.shard()
        item = {**self.catalog.record(self.ref['id'], KEY, 'speech-recognition'), 'passphrase': 'fixture'}
        self.assertEqual(load_voice_blob(self.account, item, self.nt()), SILK)
        self.shard('media_1.db', SILK+b'different')
        with self.assertRaisesRegex(RuntimeError, 'VOICE_AUDIO_AMBIGUOUS'): load_voice_blob(self.account, item, self.nt())

    def reader(self, sender='contact-alpha', server_id=123456789012345678):
        reader = api.Reader.__new__(api.Reader)
        reader.root, reader.account, reader.voices = self.root, self.account, self.catalog
        reader.voice_slots, reader.passphrase = threading.BoundedSemaphore(2), 'fixture'
        def connections():
            c = sqlite3.connect(':memory:')
            table = 'Msg_'+hashlib.md5(b'contact-alpha').hexdigest()
            c.execute('CREATE TABLE "'+table+'"(local_type INTEGER,real_sender_id INTEGER,local_id INTEGER,create_time INTEGER,server_id INTEGER)')
            c.execute('INSERT INTO "'+table+'" VALUES(34,1,7,100,?)', (server_id,))
            c.execute('CREATE TABLE Name2Id(user_name TEXT)')
            c.execute('INSERT INTO Name2Id(rowid,user_name) VALUES(1,?)', (sender,))
            return [c]
        reader.open_messages = connections
        return reader

    def test_complete_message_identity_and_real_sender_are_verified_before_media_read(self):
        for reader in (self.reader(sender='wxid_other'), self.reader(server_id=999)):
            with self.assertRaisesRegex(RuntimeError, 'VOICE_MESSAGE_IDENTITY_NOT_FOUND'):
                reader.resolve_voice(self.ref['id'], KEY, 'speech-recognition', 'silk')

    def test_silk_response_has_only_bound_audio_and_digest_and_rechecks_revocation(self):
        from unittest.mock import patch
        self.shard()
        with patch.object(api.nt, 'derive_database_key', self.nt().derive_database_key), patch.object(api.nt, 'connect_nt_db', self.nt().connect_nt_db):
            result = self.reader().resolve_voice(self.ref['id'], KEY, 'speech-recognition', 'silk')
            self.assertEqual(base64.b64decode(result['b64']), SILK)
            self.assertEqual(result['conversationKey'], KEY)
            self.assertEqual(result['sha256'], hashlib.sha256(SILK).hexdigest())
            self.assertNotIn('account', result)
            self.assertNotIn('passphrase', result)
        def revoke(*_):
            self.active = False
            return SILK
        with patch.object(api, 'load_voice_blob', revoke):
            with self.assertRaises(PermissionError): self.reader().resolve_voice(self.ref['id'], KEY, 'speech-recognition', 'silk')

    def test_decoder_is_optional_and_requires_no_model(self):
        decoder_spec = importlib.util.spec_from_file_location('voice_decoder_test', pathlib.Path(__file__).with_name('decode-wechat-voice.py'))
        decoder = importlib.util.module_from_spec(decoder_spec)
        decoder_spec.loader.exec_module(decoder)
        from unittest.mock import patch
        with patch.dict(sys.modules, {'pilk': None}), patch.object(decoder, 'wasm_command', return_value=None):
            with self.assertRaisesRegex(RuntimeError, 'VOICE_DECODER_MISSING'): decoder.decode(SILK)


if __name__ == '__main__':
    unittest.main()
