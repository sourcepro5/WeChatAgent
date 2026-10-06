# Vendor subset state

This directory is the database-only source subset used by WeChatAgent.
Retained APIs accept caller-provided credentials and query SQLCipher databases.
The maintainer previously verified the subset with synthetic encrypted shards.
Development tests, generators, binaries and user data are not shipped.
Runtime database function bodies remain unchanged; review source integrity and privacy before publishing.
