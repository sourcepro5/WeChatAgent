# Vendor subset state

This directory is the database-only source subset used by WeChatAgent.
Retained APIs accept caller-provided credentials and query SQLCipher databases.
Verification uses synthetic encrypted shards only; binaries and user data are not shipped.
Run the root project tests and the vendored verification test for this packaged subset.
