---
"querybridge-mcp": minor
---

**`streaming_query` gains `format` argument — NDJSON (default), JSON-array, or CSV.**

The original `streaming_query` shipped NDJSON-only (one JSON object per line). The agent and operator pair both wanted CSV for spreadsheet workflows and JSON-array for jq-style downstream tooling. Adding both as a single `format` parameter, defaulting to `ndjson` so every existing call site keeps working unchanged.

### Formats

| `format`           | Output                                                     | Best for                                                                                                                                                                                                 |
| ------------------ | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ndjson` (default) | One JSON object per line, no header, no footer             | Stream consumers; large exports — line-by-line consumption with no buffering                                                                                                                             |
| `json`             | A single JSON array document — `[\n  {...},\n  {...}\n]\n` | jq pipelines, JSON.parse-once consumers; zero-row case is `[]\n` (valid empty array)                                                                                                                     |
| `csv`              | RFC 4180 with a header row built from the first row's keys | Spreadsheets, CSV-ingesting tools. Objects/arrays in a cell are JSON-stringified; nulls render as empty cells; commas / newlines / embedded quotes trigger RFC-4180 quoting with internal-quote doubling |

### Implementation

New `Serializer` abstraction inside `streaming-tools.ts` with three lifecycle hooks per format:

- `start(firstRow)` — called once with the first row; lets CSV emit a header line and JSON-array emit `[`
- `row(row, index)` — called for each row; emits the row bytes (and the separator between rows for JSON-array)
- `end(rowCount)` — called once after the last row; lets JSON-array close `]`. NDJSON / CSV use empty `end()`

When truncated (row/byte cap hit), `end()` is **skipped** for JSON-array — emitting `]` would imply a valid JSON document when the content is actually truncated. NDJSON / CSV behave identically when truncated.

### Recommended file extensions

The tool description now recommends extension-format pairs: `.ndjson` (default), `.json` for JSON-array, `.csv` for CSV. The tool doesn't auto-suggest based on the path — the operator controls naming.

### Structured response

`structuredContent.format` now records the format used so the agent can branch on it without re-derivation: `"ndjson" | "json" | "csv"`.

### Tests

6 new unit tests driving `pumpStream` with a synthetic `Readable` and each serializer:

- NDJSON: one JSON object per line, no header, no footer; round-trips through `JSON.parse` per line
- JSON: single valid JSON array document; round-trips through `JSON.parse(out)` and produces a 3-element array
- JSON: zero-row edge case → `[]\n` (valid empty array)
- CSV: header row from the first row's keys
- CSV: RFC-4180 quoting on values with commas, newlines, embedded quotes; internal quotes doubled; objects/arrays JSON-stringified
- CSV: null renders as an empty cell (no quotes)

Existing 463 tests pass unchanged — the `Serializer` parameter on `pumpStream` is optional with NDJSON as the default, preserving every pre-existing call site.

**Total: 469 unit / 41 integration.** Lint clean (91 modules, 312 deps).
