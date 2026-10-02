"""NT 读取的两个入口共用的东西：分片发现、密钥派生、列探测。

为什么要单独一个模块：`nt_decrypt.py`（messages / sessions / CLI 那条路）和
`export_chat_html.py`（导出那条路）**各自实现过同名函数，而它们并不相同**。
差异不会报错，只在边界处让两条路给出不同结果：

* `discover_message_shards` 的**契约**不同——`nt_decrypt` 版在 glob 不到分片时返回
  `[配置的那个库]`（永不返回空），导出器版返回空表、由调用点
  `if not shards: shards = [db_path]` 自己补。补偿写在调用点意味着**任何新调用方
  忘了它就会静默拿到零个分片**。
* `derive_database_key` 两份的代码逐字相同，只有 docstring 不同——纯重复。
* `table_columns` 也逐字相同（两份都是我加的）。

所以这里只留一份实现，**契约取更安全的那一版**（下面的 docstring 各自写明）。
导入本模块不需要 sqlcipher3：这几个函数都不连数据库。
"""
from pathlib import Path

# 与 message_*.db 同目录、但不是消息分片的派生库。
SHARD_EXCLUDED = {'message_fts.db', 'message_resource.db'}

# 消息行的"锚点"列：任意一列在场，一行才谈得上身份与顺序。
#
# **两处语义，顺序只对其中一处有意义**：
#   * 身份/模式检查——`nt_decrypt` 用它判断"这个分片是不是根本没有消息表该有的列"，
#     这一处是集合语义，顺序无关。
#   * `ORDER BY`——两个读取入口都按这个顺序排：`create_time` 优先。这一处顺序**就是
#     行为**：把 `local_id` 排到前面会让会话顺序变成另一回事，而且没有任何报错。
#
# 收在这里是因为它原本有三份：`nt_decrypt` 一份具名、同文件里 `ORDER BY` 又写了一份
# 字面量、`export_chat_html` 再写一份。三份一致时看不出问题，谁改了一处的顺序，
# 另一处就静默按别的顺序排消息——正是 `nt_common` 存在的理由那类分叉。
MESSAGE_ANCHOR_COLUMNS = ('create_time', 'local_id', 'server_id')


def discover_message_shards(db_path):
    """配置库旁边的每一个 NT 消息分片。

    **永不返回空表**：glob 不到任何分片时返回 `[db_path]` 本身。调用方不必自己
    兜底——两份实现里原本只有一份保证这一点，而导出器是在调用点补的。
    """
    path = Path(db_path)
    if not path.parent.is_dir():
        return [str(path)]
    shards = sorted(str(p) for p in path.parent.glob('message_*.db')
                    if p.name.lower() not in SHARD_EXCLUDED)
    return shards or [str(path)]


def derive_database_key(path, fallback_key, fallback_salt, passphrase=''):
    """每分片的 SQLCipher 密钥（微信 4.1.12.26+）。

    共享的 passphrase 会跟**每个分片自己的** 16 字节文件头 salt 做一次
    PBKDF2-HMAC-SHA512。没有 passphrase 时原样返回配置里那一对——老安装的
    分片 0 就是用那个开的。
    """
    import hashlib
    if not passphrase:
        return fallback_key, fallback_salt
    try:
        with open(path, 'rb') as fh:
            salt = fh.read(16)
        if len(salt) != 16:
            return fallback_key, fallback_salt
        raw_passphrase = bytes.fromhex(passphrase)
        key = hashlib.pbkdf2_hmac('sha512', raw_passphrase, salt, 256000, 32).hex()
        return key, salt.hex()
    except (OSError, ValueError):
        return fallback_key, fallback_salt


def table_columns(cursor, table):
    """`table` 的列名，取不到就返回空集合。

    消息表的列在不同微信版本之间会增删，所以读之前要问一句——直接按位置取字段的话，
    少一列会让后面每个字段都错位，而且不报错。
    """
    try:
        rows = cursor.execute('PRAGMA table_info("%s")' % table).fetchall()
    except Exception:
        return set()
    return {row[1] for row in rows}
