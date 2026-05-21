---
"querybridge-mcp": patch
---

**Release plumbing fixes** (no user-facing code change):

- `release.yml` accepts `workflow_dispatch` so failed/missed releases can be replayed with `gh workflow run release.yml --ref vX.Y.Z`.
- `changeset.yml` now prefers a `CHANGESETS_PAT` secret (fine-grained PAT) over `GITHUB_TOKEN`, so tags it creates fire `release.yml` automatically instead of being silently swallowed by GitHub's anti-loop protection. Falls back to `GITHUB_TOKEN` when the secret is absent (no hard break).
- CONTRIBUTING.md documents the required `NPM_TOKEN` and `CHANGESETS_PAT` secrets and the manual-replay command.
