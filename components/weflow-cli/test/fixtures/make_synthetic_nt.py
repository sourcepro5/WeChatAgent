#!/usr/bin/env python3
"""Build a synthetic WeChat NT data directory for end-to-end acceptance tests.

Why a real SQLCipher file rather than plain SQLite: the CLI spawns a real
`nt_decrypt.py` process, which uses the real `sqlcipher3`. A plain SQLite file
fails there with "file is not a database", so the unit-test trick of stubbing
the driver does not carry over to the CLI path. These fixtures are encrypted
with a synthetic key, so no real data or credential is involved.

Two things that bite if you get them wrong, both silent:

  - The `Msg_<md5(talker)>` table must carry **every** column the reader's
    SELECT asks for. A short table raises on read, and the reader treats that
    as "this shard had nothing" - the conversation comes back empty with no
    error unless `--report-shards` is used.
  - The encryption must use `PRAGMA key = "x'<key><salt>'"` with the salt
    spelled out, matching what `connect_nt_db` does. Letting SQLCipher pick a
    random header salt produces a file the reader cannot open.

Outputs a directory containing `db_storage/message/message_*.db` and
`.weflow-cli/config.json` pointing at them, ready for `HOME=<dir>`.
"""
import argparse
import hashlib
import json
import os
import sys

# A fixed synthetic key pair. Importing sqlcipher3 is deferred so this file can
# be read (and its help printed) on a machine without it.
SYNTHETIC_KEY = 'a' * 64
SYNTHETIC_SALT = 'b' * 32

MSG_COLUMNS = (
    'local_id INTEGER, server_id INTEGER, local_type INTEGER, sort_seq INTEGER,'
    ' real_sender_id INTEGER, create_time INTEGER, status INTEGER,'
    ' upload_status INTEGER, download_status INTEGER, server_seq INTEGER,'
    ' origin_source INTEGER, source TEXT, message_content TEXT,'
    ' compress_content BLOB'
)
MSG_COLUMN_COUNT = 14

DEFAULT_SENDER = 'wxid_synthetic_sender'
BASE_TIME = 1_700_000_000


def shard_salt(index):
    """A per-shard salt, deterministic so fixtures are reproducible.

    Real WeChat gives every shard its own header salt; a fixture that reuses
    one salt cannot model the per-shard key derivation at all, which is what
    went wrong the first time this fixture was written.
    """
    return hashlib.sha256(b'weflow-synthetic-salt-%d' % index).digest()[:16]


def derive_shard_key(passphrase_hex, salt16):
    """PBKDF2-HMAC-SHA512(passphrase, shard salt, 256000, 32) - same as the reader."""
    return hashlib.pbkdf2_hmac('sha512', bytes.fromhex(passphrase_hex), salt16,
                               256000, 32).hex()


def connect(path):
    from sqlcipher3 import dbapi2
    return dbapi2.connect(path)


def write_shard(path, talker, rows, sender=DEFAULT_SENDER, salt=None):
    """One encrypted shard holding this conversation's rows.

    Encrypted under the key derived from the passphrase and *this shard's*
    salt, spelled out via `x'<key><salt>'`, which is exactly how the reader
    opens it. Using the passphrase directly as the key would produce a file
    the derivation path cannot verify.
    """
    table = 'Msg_' + hashlib.md5(talker.encode()).hexdigest()
    salt16 = salt if salt is not None else shard_salt(0)
    key_hex = derive_shard_key(SYNTHETIC_KEY, salt16)
    conn = connect(path)
    conn.execute('PRAGMA key = "x\'%s%s\'"' % (key_hex, salt16.hex()))
    try:
        conn.execute('CREATE TABLE "%s" (%s)' % (table, MSG_COLUMNS))
        if rows:
            conn.executemany(
                'INSERT INTO "%s" VALUES (%s)' % (table, ','.join('?' * MSG_COLUMN_COUNT)),
                rows)
        # Name2Id maps the rowid used by real_sender_id to a username.
        conn.execute('CREATE TABLE Name2Id (user_name TEXT, is_session INTEGER)')
        conn.execute('INSERT INTO Name2Id (user_name, is_session) VALUES (?, 1)', (sender,))
        conn.commit()
    finally:
        conn.close()


def text_row(local_id, create_time, content, sender_id=1, server_id=None):
    return (local_id, server_id if server_id is not None else 9000 + local_id,
            1, 0, sender_id, create_time, 0, 0, 0, 0, 0, '', content, b'')


def build(root, talker, per_shard=2, shards=2, with_sender=True):
    msg_dir = os.path.join(root, 'db_storage', 'message')
    os.makedirs(msg_dir, exist_ok=True)

    written = []
    salts = []
    for shard_index in range(shards):
        rows = [
            text_row(shard_index * 100 + i + 1,
                     BASE_TIME + shard_index * 1000 + i * 10,
                     'synthetic message %d/%d' % (shard_index, i))
            for i in range(per_shard)
        ]
        path = os.path.join(msg_dir, 'message_%d.db' % shard_index)
        salt16 = shard_salt(shard_index)
        write_shard(path, talker, rows, DEFAULT_SENDER if with_sender else 'wxid_other',
                    salt=salt16)
        written.append(path)
        salts.append(salt16)

    config_dir = os.path.join(root, '.weflow-cli')
    os.makedirs(config_dir, exist_ok=True)
    with open(os.path.join(config_dir, 'config.json'), 'w', encoding='utf-8') as handle:
        json.dump({
            # `dbPath` is the legacy 4.x root. It is set here because
            # chatService.connect4x() requires it unconditionally, even though
            # its own comment says a complete NT configuration does not need
            # anything else - without it the caller bails before ever reaching
            # the NT branch, and every read comes back empty with no error.
            # `init` always writes it, so a real install is unaffected.
            'dbPath': root,
            'ntDbPath': written[0],
            # `decryptKey` is what the reader uses as the shared passphrase, so
            # setting it here makes the CLI go through per-shard derivation -
            # the same path a real install takes, rather than the fallback.
            'decryptKey': SYNTHETIC_KEY,
            # The fallback pair, which only ever opens shard 0. Derived from
            # that shard's salt so it is consistent with the derived path.
            'ntKey': derive_shard_key(SYNTHETIC_KEY, salts[0]),
            'ntSalt': salts[0].hex(),
            'dataVersion': '4.x',
        }, handle, indent=2)

    return {'root': root, 'talker': talker, 'shards': written,
            'expectedMessages': per_shard * shards}


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--out', required=True, help='directory to build into')
    parser.add_argument('--talker', default='wxid_synthetic_contact')
    parser.add_argument('--per-shard', type=int, default=2)
    parser.add_argument('--shards', type=int, default=2)
    parser.add_argument('--json', action='store_true', help='print the result as JSON')
    args = parser.parse_args()

    result = build(args.out, args.talker, args.per_shard, args.shards)
    print(json.dumps(result, ensure_ascii=False) if args.json
          else 'built %s (%d messages across %d shards)'
               % (result['root'], result['expectedMessages'], args.shards))


if __name__ == '__main__':
    sys.exit(main())
