# Contributing to querybridge-mcp

Thanks for your interest. This is a small focused project — a single MCP
server bridging Claude (and other MCP clients) to MySQL.

## Setup

```bash
pnpm install
pnpm build
pnpm test
```

Node ≥ 20 and pnpm 10 (pinned via `packageManager` — Corepack will pick
it up automatically). See SECURITY.md for the security model.

## Workflow

1. Fork + branch.
2. Make your change.
3. Run the local pipeline:

   ```bash
   pnpm lint        # ESLint
   pnpm build       # tsc strict
   pnpm test        # vitest (currently 182 tests)
   pnpm format      # optional — Prettier reformats
   ```

4. **Add a changeset** describing the user-visible effect of your change:

   ```bash
   pnpm changeset
   ```

   Pick the bump level (`patch` / `minor` / `major`) and write 1–3
   sentences. The bot opens a "Version Packages" PR that merges your
   changeset into `CHANGELOG.md` on release. Internal-only changes
   (refactors, CI tweaks, docs) can skip this.

5. Open the PR. CI runs lint + build + test on Node 20, 22, 24 and
   verifies the npm tarball doesn't ship test files.

## What to add changesets for

| Change | Changeset? | Bump |
|--------|------------|------|
| New tool, prompt, or resource | Yes | minor |
| New config field | Yes | minor |
| Breaking config / tool-arg change | Yes | major |
| Bug fix | Yes | patch |
| Security fix | Yes | patch (and credit reporter) |
| Refactor with no user-visible change | No | — |
| Docs, README, comments | No | — |
| CI / lint / Dependabot | No | — |

## Tests

Two suites:

- **Unit** (`src/__tests__/*.test.ts`) — fast, no external dependencies.
  Covers config parsing, SQL whitelist, helpers, host-key verification,
  log forwarding. `pnpm test` runs these.

- **Integration** (`src/__tests__/integration/*.integration.test.ts`) —
  spins up a real MySQL container via Testcontainers. Verifies the
  behaviors unit tests cannot reach: read-only session enforcement,
  LOAD DATA LOCAL INFILE block, KILL QUERY cancellation,
  information_schema queries. Requires Docker. `pnpm test:integration`.

`pnpm test:all` runs both. CI runs both on Node 22 (integration only
runs once — the SDK behavior is identical across Node 20/22/24).

## Releases

Maintainers don't bump versions manually. The Changesets bot opens a
PR that bumps `package.json` and writes `CHANGELOG.md`; merging that PR
creates a tag, which triggers `.github/workflows/release.yml` to publish
to npm with Sigstore provenance.

### Required repository secrets

| Secret | Used by | Purpose |
|---|---|---|
| `NPM_TOKEN` | `release.yml` | npm automation token (Automation type, scoped to `querybridge-mcp`, `Read and write`). |
| `CHANGESETS_PAT` | `changeset.yml` | Fine-grained PAT with **Contents: read/write** and **Pull requests: read/write** on this repo. Required so tags pushed by Changesets fire `release.yml`. Without it the workflow falls back to `GITHUB_TOKEN`, which works for the PR but cannot trigger downstream workflows (GitHub anti-loop). |

To create `CHANGESETS_PAT`: Settings → Developer settings → Personal
access tokens → Fine-grained tokens → Generate new token → repository
access: `querybridge-mcp` only → permissions as above.

### Manual release (escape hatch)

`release.yml` also accepts `workflow_dispatch`. If a tag exists but
the release didn't fire (e.g. Changesets pushed it under
`GITHUB_TOKEN`), trigger manually:

```bash
gh workflow run release.yml --ref vX.Y.Z
```
