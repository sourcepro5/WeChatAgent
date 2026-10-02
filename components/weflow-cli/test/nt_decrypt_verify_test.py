"""Stdlib-only passphrase verification against a real encrypted database.

Patching sqlcipher3 away would defeat the point - the whole reason this
function exists is to answer "is the key right?" when the native library is
missing or broken. So these fixtures are encrypted for real, and the verifier
is exercised without it.

The fixtures come from the same builder the end-to-end acceptance suite uses,
so there is one definition of what a synthetic NT store looks like.
"""
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
FIXTURES = Path(__file__).resolve().parent / 'fixtures'
sys.path.insert(0, str(SCRIPTS))
sys.path.insert(0, str(FIXTURES))

spec = importlib.util.spec_from_file_location('nt_decrypt_verify', SCRIPTS / 'nt_decrypt.py')
nt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(nt)

import make_synthetic_nt as fixture  # noqa: E402  (needs fixtures/ on sys.path)


class PassphraseVerificationTests(unittest.TestCase):
    def setUp(self):
        try:
            import sqlcipher3  # noqa: F401
        except ImportError:
            self.skipTest('sqlcipher3 unavailable, so an encrypted fixture cannot be built')
        self._tmp = tempfile.TemporaryDirectory(prefix='weflow-verify-')
        self.root = self._tmp.name
        fixture.build(self.root, 'wxid_synthetic_contact', per_shard=1, shards=1)
        self.db = os.path.join(self.root, 'db_storage', 'message', 'message_0.db')

    def tearDown(self):
        self._tmp.cleanup()

    def test_the_right_passphrase_verifies(self):
        self.assertIs(nt.verify_passphrase_native(fixture.SYNTHETIC_KEY, self.db), True)

    def test_a_wrong_passphrase_fails_rather_than_erroring(self):
        # A wrong key and a broken library must not look the same; this
        # returns False, it does not raise.
        self.assertIs(nt.verify_passphrase_native('f' * 64, self.db), False)

    def test_an_unusable_input_returns_none_not_false(self):
        # "cannot tell" is a different answer from "wrong", and callers must
        # be able to distinguish them.
        self.assertIsNone(nt.verify_passphrase_native('not-hex', self.db))
        self.assertIsNone(nt.verify_passphrase_native(fixture.SYNTHETIC_KEY,
                                                      os.path.join(self.root, 'nope.db')))

    def test_a_file_too_short_to_hold_a_page_returns_none(self):
        stub = os.path.join(self.root, 'tiny.db')
        Path(stub).write_bytes(b'short')
        self.assertIsNone(nt.verify_passphrase_native(fixture.SYNTHETIC_KEY, stub))

    def test_the_internal_xor_key_is_applied_before_derivation(self):
        """Some WeChat builds XOR the passphrase with a key from Weixin.dll.

        Building the fixture with P^K and verifying with P plus K must succeed,
        which is what proves the option is wired in rather than ignored.
        """
        xor_key = bytes(range(32))
        xor_hex = xor_key.hex()
        original = fixture.SYNTHETIC_KEY
        fixture.SYNTHETIC_KEY = bytes(
            a ^ b for a, b in zip(bytes.fromhex(original), xor_key)).hex()
        try:
            root = tempfile.mkdtemp(prefix='weflow-xor-')
            fixture.build(root, 'wxid_synthetic_contact', per_shard=1, shards=1)
            db = os.path.join(root, 'db_storage', 'message', 'message_0.db')
            # With the XOR key supplied the original passphrase verifies...
            self.assertIs(nt.verify_passphrase_native(original, db, xor_hex), True)
            # ...and without it, it does not.
            self.assertIs(nt.verify_passphrase_native(original, db), False)
        finally:
            fixture.SYNTHETIC_KEY = original

    def test_every_shard_verifies_with_the_same_passphrase(self):
        """The shard keys differ but the passphrase does not.

        Each shard derives its own key from its own header salt, so a single
        passphrase has to verify against all of them - that is the property
        the shard-key derivation depends on.
        """
        # A fresh root: setUp already built one shard here.
        root = tempfile.mkdtemp(prefix='weflow-multi-')
        fixture.build(root, 'wxid_synthetic_contact', per_shard=1, shards=3)
        message_dir = os.path.join(root, 'db_storage', 'message')
        shards = sorted(name for name in os.listdir(message_dir)
                        if name.startswith('message_') and name.endswith('.db'))
        self.assertGreater(len(shards), 1)
        for name in shards:
            with self.subTest(shard=name):
                self.assertIs(
                    nt.verify_passphrase_native(fixture.SYNTHETIC_KEY,
                                                os.path.join(message_dir, name)), True)


if __name__ == '__main__':
    unittest.main()
