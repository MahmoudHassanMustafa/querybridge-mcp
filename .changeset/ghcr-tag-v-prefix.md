---
"querybridge-mcp": patch
---

**Docker image tag fix.** The release workflow now publishes images under **three** tags: the bare semver (`:0.5.0`), the git-tag form (`:v0.5.0`), and `:latest`. Previously only the bare semver and `:latest` were tagged, which mismatched the README's documented `:vX.Y.Z` form and caused 0.5.0 pulls using `:v0.5.0` to fail. Both naming conventions are common in the ecosystem; shipping both means either form works.
