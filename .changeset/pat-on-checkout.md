---
"querybridge-mcp": patch
---

**Release plumbing fix.** Pass `CHANGESETS_PAT` to `actions/checkout` so git operations (the version-bump commit and the release tag push) are attributed to the PAT owner instead of `github-actions[bot]`. Without this, GitHub's anti-loop protection swallows downstream workflow triggers — CI on the version PR and `release.yml` on the release tag both fail to fire. The env-var `GITHUB_TOKEN` override on `changesets/action@v1` only affected its API calls, not the underlying git operations.
