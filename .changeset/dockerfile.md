---
"querybridge-mcp": minor
---

**Docker support.** A multi-arch (amd64 + arm64) image is now published to `ghcr.io/mahmoudhassanmustafa/querybridge-mcp` on every release. Register with Claude Code without installing Node or pnpm:

```bash
claude mcp add querybridge-mcp -- \
  docker run --rm -i \
  -v /path/to/config.json:/config/config.json:ro \
  -e QUERYBRIDGE_MCP_CONFIG=/config/config.json \
  ghcr.io/mahmoudhassanmustafa/querybridge-mcp:latest
```

The image is multi-stage (build + slim runtime), runs as non-root, ships with SBOM + Sigstore provenance, and is ~250MB. README has the full setup including SSH key mounts. See the new "Register with Claude Code via Docker" section.
