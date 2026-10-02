# Security scope of the vendored database subset

This directory contains only the database API needed by WeChatAgent and synthetic verification data.
Users must independently supply authorized data and valid credentials. This subset does not obtain
credentials, discover client processes, scan process memory, or ship a native access library.

The outer reader is responsible for account selection, query-only connections, authenticated loopback
access, current conversation permissions and image identity checks. A source license does not grant
rights to access another account, disclose private conversations, or use a platform interface.

Never publish real databases, credentials, account identifiers, screenshots or personal exports in
issues or fixtures. Use synthetic data and redacted error descriptions when reporting a problem.
Local processing is not a guarantee of legal authorization, privacy or account safety. Cloud model
requests may send selected chat content and images to the configured provider.
