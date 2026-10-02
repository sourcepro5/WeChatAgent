"""Verify the packaged query API with synthetic encrypted shards only."""
import pathlib
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'components/weflow-cli/scripts'))
sys.path.insert(0, str(ROOT / 'components/weflow-cli/test/fixtures'))
import nt_decrypt as nt
import make_synthetic_nt as fixture


class PackagedReaderChecks(unittest.TestCase):
    def test_query_all_synthetic_shards_and_decode_messages(self):
        with tempfile.TemporaryDirectory(prefix='wechatagent-public-reader-') as directory:
            talker = 'wxid_synthetic_contact'
            built = fixture.build(directory, talker, per_shard=2, shards=2)
            connections, failures = nt.connect_message_shards_detailed(
                built['shards'][0], '', '', fixture.SYNTHETIC_KEY)
            self.assertFalse(failures)
            try:
                for _, connection in connections:
                    connection.execute('PRAGMA query_only=ON')
                result = nt.get_messages([connection for _, connection in connections],
                    talker, limit=100, own_wxid='wxid_synthetic_self')
                self.assertEqual(len(result['messages']), built['expectedMessages'])
                self.assertTrue(all(row['localType'] == 1 for row in result['messages']))
            finally:
                for _, connection in connections:
                    connection.close()

    def test_unused_memory_scanning_is_not_packaged(self):
        self.assertFalse(hasattr(nt, 'scan_memory_keys'))
        self.assertFalse(hasattr(nt, 'scan_memory_keys_linux'))
        self.assertFalse(hasattr(nt, 'find_weixin_pid'))


if __name__ == '__main__':
    unittest.main()
