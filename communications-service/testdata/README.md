# API v1 / Node 0.1.0 compatibility fixtures

These fixtures were produced by the original Node service after its 23 tests passed, before replacing its runtime with Go. They contain fabricated project conversations and public test credentials only. Tests copy the database and vault into temporary directories; never open this database for normal service operation.

- `protocol-v1.json`: shared requests, validity and fully defaulted outputs, checked by both Go and the TypeScript/Zod client SDK.
- `node-v1/golden.json`: normalized messages, JSON.stringify byte sequences and SHA256 hashes, candidate/requirement identities and a fixed material delivery.
- `node-v1/home`: original SQLite/FTS database, immutable requirement version, interrupted task/delivery, unknown metadata, original attachment, registry, API token and AES-256-GCM vault.

The SQLite fixture is intentionally included despite the repository's general SQLite ignore rule. Keys and tokens in this directory must only be used with temporary fixture copies. Real DWS authorization and real enterprise conversations are not part of these fixtures.

The Go tests also launch Node's built-in SQLite implementation when available to verify the shared lease protocol in both directions. Node is an optional test tool, not a dependency of the service executable.
