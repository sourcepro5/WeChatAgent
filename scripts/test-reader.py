"""Focused boundary checks for the outer adapter; no local data fixtures."""
import importlib.util
import pathlib
import queue
import threading
import hashlib
import sqlite3
from collections import OrderedDict
import unittest

spec = importlib.util.spec_from_file_location('reader_api', pathlib.Path(__file__).with_name('reader-api.py'))
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)


class ReaderBoundaries(unittest.TestCase):
    def setUp(self):
        self.message = {'senderUsername': 'contact-A', 'isSend': 0, 'localType': 1,
            'localId': 1, 'serverId': '99', 'createTime': 12345,
            'fullText': 'A long message ' * 50, 'parsedContent': 'truncated'}

    def test_outgoing_and_unresolved_senders_are_not_forwarded(self):
        for changed in [{'isSend': 1}, {'senderUsername': ''}, {'senderUsername': 'self-A'}]:
            self.assertIsNone(api.push_payload('contact-A', self.message | changed, {}, 'self-A'))

    def test_image_is_typed_and_other_media_is_not_misrepresented_as_text(self):
        image = api.push_payload('contact-A', self.message | {'localType': 3}, {}, 'self-A')
        self.assertEqual(image['type'], 3)
        self.assertEqual(image['content'], '[图片]')
        self.assertEqual(image['image']['localId'], 1)
        self.assertNotIn('fullText', image)
        sticker = api.push_payload('contact-A', self.message | {'localType': 47}, {}, 'self-A')
        self.assertEqual(sticker['image']['localType'], 47)
        for kind in [34, 43, 49, 10000]:
            self.assertIsNone(api.push_payload('contact-A', self.message | {'localType': kind}, {}, 'self-A'))

    def test_pat_only_accepts_the_real_actor_and_our_target(self):
        xml = '<msg><appmsg><type>62</type><patinfo><fromusername>contact-A</fromusername><pattedusername>self-A</pattedusername></patinfo></appmsg></msg>'
        row = self.message | {'localType': api.PAT_TYPE, 'fullText': xml}
        payload = api.push_payload('room-A@chatroom', row, {}, 'self-A_ab12')
        self.assertEqual(payload['pat'], {'actor': 'contact-A', 'target': 'self-A'})
        self.assertNotIn('<msg>', payload['content'])
        for changed in [xml.replace('self-A', 'contact-B'), xml.replace('contact-A', 'contact-B'), xml.replace('<type>62', '<type>6'), '<msg>拍了拍我</msg>', '<!DOCTYPE msg [<!ENTITY x "test">]>' + xml]:
            self.assertIsNone(api.push_payload('room-A@chatroom', row | {'fullText': changed}, {}, 'self-A_ab12'))
        self.assertIsNone(api.push_payload('contact-A', row | {'isSend': True}, {}, 'self-A'))

    def test_message_identity_includes_the_conversation(self):
        a = api.push_payload('contact-A', self.message, {}, 'self-A')
        b = api.push_payload('contact-B', self.message, {}, 'self-A')
        self.assertNotEqual(a['rawid'], b['rawid'])
        self.assertEqual(a['rawid'], api.push_payload('contact-A', self.message, {}, 'self-A')['rawid'])

    def test_group_sender_and_conversation_are_separate_and_text_is_preserved(self):
        names = {'contact-A': '联系人A', 'room-A@chatroom': '示例群'}
        payload = api.push_payload('room-A@chatroom', self.message, names, 'self-A')
        self.assertEqual(payload['sourceName'], '联系人A')
        self.assertEqual(payload['groupName'], '示例群')
        self.assertEqual(payload['sessionType'], 'group')
        self.assertEqual(payload['content'], self.message['fullText'])

    def test_existing_group_ids_survive_the_reader_change(self):
        self.assertEqual(api.conversation_id('room-A@chatroom', {'room-A@chatroom': '示例群 (12)'}), api.onebot_id('示例群'))
        self.assertEqual(api.conversation_id('contact-A', {'contact-A': '联系人A'}), api.onebot_id('contact-A'))

    def test_explicit_pat_retry_keeps_whitelist_identity_and_deduplication(self):
        reader = api.Reader.__new__(api.Reader)
        reader.names = {}; reader.own_wxid = 'self-A'; reader.lock = threading.Lock()
        receiver = queue.Queue(); reader.clients = {receiver}; reader.seen = OrderedDict()
        reader.selected_talkers = lambda: ['contact-A']
        reader.image_talker_allowed = lambda talker: True
        xml = '<msg><appmsg><type>62</type><patinfo><fromusername>contact-A</fromusername><pattedusername>self-A</pattedusername></patinfo></appmsg></msg>'
        reader.messages = lambda *args, **kwargs: [self.message | {'localType':api.PAT_TYPE,'fullText':xml}]
        descriptor = {'conversationId':api.onebot_id('contact-A'),'localId':1,'createTime':12345,'serverId':'99'}
        self.assertTrue(reader.replay_event(descriptor))
        self.assertFalse(reader.replay_event(descriptor))
        self.assertEqual(receiver.qsize(),1)
        with self.assertRaisesRegex(RuntimeError,'IDENTITY_NOT_FOUND'):
            reader.replay_event(descriptor | {'serverId':'100'})
        with self.assertRaises(PermissionError):
            reader.replay_event(descriptor | {'conversationId':'999'})

    def test_group_sticker_xml_removes_the_verified_sender_prefix(self):
        talker='room-A@chatroom'; reader=api.Reader.__new__(api.Reader)
        reader.names={'contact-A':'联系人A'}; reader.own_wxid='self-A'
        reader.image_talker_allowed=lambda _:True
        xml='<msg><emoji md5="'+'a'*32+'" /></msg>'
        for prefix,expected in [('contact-A: '+chr(10),xml),('unknown-ID: '+chr(10),'unknown-ID: '+chr(10)+xml)]:
            connection=sqlite3.connect(':memory:'); table='Msg_'+hashlib.md5(talker.encode()).hexdigest()
            connection.execute('CREATE TABLE "'+table+'" (local_id INTEGER,create_time INTEGER,server_id INTEGER,local_type INTEGER,message_content TEXT)')
            connection.execute('INSERT INTO "'+table+'" VALUES (1,12345,99,47,?)',(prefix+xml,))
            reader.open_messages=lambda:[connection]
            row=reader.image_row(talker,{'localId':1,'serverId':'99','createTime':12345,'localType':47})
            self.assertEqual(row['imageXml'],expected)


if __name__ == '__main__':
    unittest.main()
