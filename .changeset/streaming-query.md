---
"querybridge-mcp": minor
---

**New tool: `streaming_query`.** Stream a SELECT to a NDJSON file on disk — for exports that would blow `execute_query`'s 1k-row in-memory cap.

Designed for the "dump this large table so the agent can grep/aggregate it without spending its response budget on the data" workflow. Uses mysql2's row-streaming API so the rows never sit in memory all at once; writes to a temp file + atomic rename so a mid-stream failure leaves no half-written file at the destination.

**Inputs:**

- `connection` (string, required)
- `query` (string, required) — SELECT or read-only WITH … SELECT
- `output_path` (string, required) — relative paths resolve against the server's cwd
- `max_rows` (number, optional) — default 1,000,000; ceiling 100,000,000
- `max_bytes` (number, optional) — default 1 GiB; ceiling 10 GiB
- `overwrite` (boolean, optional) — default false; refuses to clobber otherwise

**Safety:**

- SELECT-only at the tool boundary, regardless of the connection's `readonly` flag — writing to disk is the side-effect; running write SQL while also serializing rows to a file would be confusing.
- Refuses paths under `/proc/`, `/dev/`, `/sys/`, `/boot/`.
- Refuses to clobber existing files unless `overwrite: true`.
- Row and byte caps both apply — hitting either marks the result `truncated: true` and issues `KILL QUERY` against the worker so MySQL stops sending. Default caps bound the disk-DoS blast radius for HTTP-mode (authenticated remote) callers.
- Atomic rename: writes to `${output_path}.tmp` and renames on success; on failure the temp file is unlinked.

**Progress:** emits a `notifications/progress` event every 1000 rows when the client opts in via `_meta.progressToken`.

**Tests:** 15 new unit tests (path validation + pre-stream gates) and 4 new integration tests against MySQL 8.4 (full export, row-cap truncation, byte-cap truncation, write-SQL rejection on writable connection).
