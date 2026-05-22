/**
 * Architecture enforcement — encodes the layering rules from
 * CONVENTIONS.md §1 so a violation fails the build instead of waiting
 * for a reviewer to spot it.
 *
 *  Transport      (src/server/{index,cli}.ts, src/resources.ts, src/prompts.ts)
 *      ↓
 *  Tools          (src/tools/**)
 *      ↓
 *  Infrastructure (every other file under src/)
 *
 * Each layer may only import from itself and the layers below.
 */

// Layer membership lives in one place so adding a new infra file
// doesn't require editing every rule that mentions it. The previous
// shape duplicated the infra regex across two rules; if you forgot
// either site, layering would silently drift.
const TRANSPORT =
  "^src/server/(index|cli|http)\\.ts$|^src/(resources|prompts)\\.ts$";
const TOOLS = "^src/tools/";
const INFRA =
  "^src/(connection|ssh-tunnel|log|tool-runtime|paths|format|limits|schema|config|errors|types)\\.ts$|^src/(sql|db|types)/";

module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment:
        "Circular dependencies make initialization order non-obvious and " +
        "broke earlier between helpers.ts ↔ connection.ts. Don't reintroduce.",
      from: {},
      to: { circular: true },
    },
    {
      name: "infra-may-not-import-tools",
      severity: "error",
      comment:
        "Infrastructure modules must not depend on a specific tool — " +
        "tools depend on infrastructure, never the other way around.",
      from: { path: INFRA },
      to: { path: TOOLS },
    },
    {
      name: "infra-may-not-import-transport",
      severity: "error",
      comment:
        "Transport (index/cli/resources/prompts) sits above infrastructure. " +
        "Infrastructure modules must not reach upward into the transport layer.",
      from: { path: INFRA },
      to: { path: TRANSPORT },
    },
    {
      name: "tools-may-not-import-transport",
      severity: "error",
      comment:
        "Tools must not reach into transport — the transport file registers " +
        "the tool, not the other way around.",
      from: { path: TOOLS },
      to: { path: "^src/server/" },
    },
    {
      name: "tools-index-is-barrel-only",
      severity: "error",
      comment:
        "src/tools/index.ts must stay a pure re-export barrel — it is " +
        "ONLY allowed to depend on individual tool family entry points " +
        "and on MCP SDK types. If you find yourself importing connection, " +
        "errors, or anything else into the barrel, you are putting logic " +
        "in the wrong file.",
      from: { path: "^src/tools/index\\.ts$" },
      to: {
        pathNot: [
          "^src/tools/[^/]+\\.ts$",
          "^src/tools/[^/]+/index\\.ts$",
          // The MCP SDK lives at @modelcontextprotocol/sdk on disk but
          // pnpm resolves it through `node_modules/.pnpm/...` — match
          // both the bare specifier and the resolved path.
          "@modelcontextprotocol[+/]sdk",
        ],
      },
    },
    {
      name: "mysql2-only-from-connection",
      severity: "error",
      comment:
        "Pool creation belongs in connection.ts (or its query-tools client). " +
        "Anywhere else risks divergent SSL/SSH/LOCAL_FILES hardening — the " +
        "cli.ts test path previously rebuilt this and missed the LOCAL_FILES " +
        "lockdown until pingConnection was extracted.",
      from: {
        pathNot:
          "^src/connection\\.ts$|^src/tools/query-tools\\.ts$|^src/db/cancel\\.ts$",
      },
      to: { path: "^mysql2(/|$)" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
      mainFields: ["main", "types"],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
