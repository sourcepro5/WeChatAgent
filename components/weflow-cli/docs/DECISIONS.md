# Vendor decisions

## Database-only source dependency

Keep the original MIT notice and source revision. Retain only the database functions used by the
outer API. Omit unused process discovery, scanning, CLI features, native libraries and media assets.
Retained function bodies stay unchanged and are verified with synthetic encrypted shards.
This defines release scope; it is not a platform-authorization or legal-safety guarantee.
