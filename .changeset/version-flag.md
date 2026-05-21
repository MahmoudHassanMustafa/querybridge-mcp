---
"querybridge-mcp": patch
---

- **`--version` / `-v`** now works on both binaries (`querybridge-mcp-server` and `querybridge-mcp`) and short-circuits before config loading — handy for sanity-checking the installed version without setting up a database.
- The reported version is read from `package.json` at runtime, so it stays in sync with Changesets bumps automatically (the previous hardcoded `"0.1.3"` string in `src/index.ts` was already stale on 0.4.0).
- `release.yml`'s `workflow_dispatch` now takes a required `tag` input. Stuck releases replay with `gh workflow run release.yml --ref main -f tag=vX.Y.Z` instead of needing the operator to push the tag from a non-`GITHUB_TOKEN` session.
