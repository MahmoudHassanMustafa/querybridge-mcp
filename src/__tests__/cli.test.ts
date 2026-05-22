/**
 * Subprocess tests for the CLI. We spawn `node dist/server/cli.js <args>` with a
 * scratch config in a temp dir and assert stdout/stderr/exit-code.
 *
 * Why subprocess instead of unit tests?
 *   - cli.ts's command handlers wire readline + fs + mysql2 + ssh2 — mocking
 *     all of those is more code than the CLI itself
 *   - subprocess tests exercise the actual published binary path
 *   - the env-var injection (QUERYBRIDGE_MCP_CONFIG) gives us full control
 *     over config without touching the user's real one
 *
 * What's NOT covered here: `cmdAdd` interactive flow. Would need scripted
 * stdin (readline -> prompts -> answers). That's left as integration TODO;
 * the saveConfig logic it calls is exercised by other commands here.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI_PATH = resolve(__dirname, "..", "..", "dist", "server", "cli.js");

interface CliResult {
  stdout: string;
  stderr: string;
  status: number;
}

let tmp: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "qb-cli-"));
  configPath = join(tmp, "config.json");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function cli(args: string[], opts: { config?: string } = {}): CliResult {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Always point at our temp config so tests never touch the user's real one.
  env.QUERYBRIDGE_MCP_CONFIG = opts.config ?? configPath;
  const res = spawnSync("node", [CLI_PATH, ...args], {
    encoding: "utf8",
    env,
    // Generous timeout: most commands return in <500ms, but `test` does
    // a real MySQL connect attempt that fails after the connect timeout.
    timeout: 12_000,
  });
  return {
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    status: res.status ?? -1,
  };
}

function writeConfig(connections: unknown[]): void {
  writeFileSync(configPath, JSON.stringify({ connections }, null, 2));
  // saveConfig sets 0600 on real writes; mirror it so we don't get
  // permission warnings from the CLI.
  chmodSync(configPath, 0o600);
}

// ── --version / -v / version ────────────────────────────────────────

describe("CLI --version", () => {
  it("--version prints the version and exits 0", () => {
    const r = cli(["--version"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("-v prints the version and exits 0", () => {
    const r = cli(["-v"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("`version` subcommand prints the version and exits 0", () => {
    const r = cli(["version"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("reported version matches package.json", () => {
    const pkg = JSON.parse(
      readFileSync(resolve(__dirname, "..", "..", "package.json"), "utf8"),
    ) as { version: string };
    const r = cli(["--version"]);
    expect(r.stdout.trim()).toBe(pkg.version);
  });
});

// ── --help / -h / help ──────────────────────────────────────────────

describe("CLI --help", () => {
  it("--help prints usage and exits 0", () => {
    const r = cli(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("querybridge-mcp");
    expect(r.stdout).toContain("Usage:");
    expect(r.stdout).toContain("Commands:");
  });

  it("lists all known commands in usage", () => {
    const r = cli(["--help"]);
    for (const cmd of ["list", "add", "remove", "test", "init", "version"]) {
      expect(r.stdout).toContain(cmd);
    }
  });

  it("no-argument invocation prints usage (does not error)", () => {
    const r = cli([]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Usage:");
  });
});

// ── init ────────────────────────────────────────────────────────────

describe("CLI init", () => {
  it("creates an empty config file at the configured path", () => {
    expect(existsSync(configPath)).toBe(false);
    const r = cli(["init"]);
    expect(r.status).toBe(0);
    expect(existsSync(configPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    expect(parsed).toEqual({ connections: [] });
  });

  it("refuses to overwrite an existing config", () => {
    writeConfig([{ name: "existing", host: "h", user: "u" }]);
    const r = cli(["init"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/already exists/i);
    // Existing content untouched
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    expect(parsed.connections).toHaveLength(1);
    expect(parsed.connections[0].name).toBe("existing");
  });
});

// ── list / ls ───────────────────────────────────────────────────────

describe("CLI list", () => {
  it("reports 'No connections configured' on an empty config", () => {
    writeConfig([]);
    const r = cli(["list"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/no connections configured/i);
  });

  it("reports 'No connections configured' when the file doesn't exist", () => {
    const r = cli(["list"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/no connections configured/i);
  });

  it("prints each connection with host/port and read-only marker", () => {
    writeConfig([
      { name: "local", host: "127.0.0.1", port: 3306, user: "root", readonly: true },
      { name: "prod", host: "db.example.com", port: 3307, user: "app", readonly: false },
    ]);
    const r = cli(["list"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("local");
    expect(r.stdout).toContain("127.0.0.1:3306");
    expect(r.stdout).toContain("(read-only)");
    expect(r.stdout).toContain("prod");
    expect(r.stdout).toContain("db.example.com:3307");
    expect(r.stdout).toContain("(read-write)");
  });

  it("flags SSH and SSL connections", () => {
    writeConfig([
      {
        name: "tunnel",
        host: "internal-db",
        user: "u",
        ssh: { host: "bastion.example.com", username: "deploy" },
      },
      {
        name: "encrypted",
        host: "secure-db",
        user: "u",
        ssl: true,
      },
    ]);
    const r = cli(["list"]);
    expect(r.stdout).toMatch(/SSH:.*bastion\.example\.com/);
    expect(r.stdout).toContain("[SSL]");
  });

  it("`ls` is an alias for `list`", () => {
    writeConfig([]);
    const r = cli(["ls"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/no connections configured/i);
  });
});

// ── remove / rm ─────────────────────────────────────────────────────

describe("CLI remove", () => {
  it("requires a connection name", () => {
    writeConfig([{ name: "a", host: "h", user: "u" }]);
    const r = cli(["remove"]);
    expect(r.stdout).toMatch(/usage:.*remove/i);
    // Config untouched
    expect(JSON.parse(readFileSync(configPath, "utf8")).connections).toHaveLength(1);
  });

  it("reports when the connection doesn't exist", () => {
    writeConfig([{ name: "a", host: "h", user: "u" }]);
    const r = cli(["remove", "nonexistent"]);
    expect(r.stdout).toMatch(/not found/i);
    expect(JSON.parse(readFileSync(configPath, "utf8")).connections).toHaveLength(1);
  });

  it("removes the named connection and persists the change", () => {
    writeConfig([
      { name: "keep", host: "h1", user: "u" },
      { name: "drop", host: "h2", user: "u" },
    ]);
    const r = cli(["remove", "drop"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/removed.*drop/i);
    const remaining = JSON.parse(readFileSync(configPath, "utf8")).connections;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].name).toBe("keep");
  });

  it("`rm` is an alias for `remove`", () => {
    writeConfig([{ name: "a", host: "h", user: "u" }]);
    const r = cli(["rm", "a"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(readFileSync(configPath, "utf8")).connections).toEqual([]);
  });
});

// ── test ────────────────────────────────────────────────────────────

describe("CLI test", () => {
  it("reports 'No connections configured' on empty config", () => {
    writeConfig([]);
    const r = cli(["test"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/no connections configured/i);
  });

  it("reports 'not found' when targeting an unknown connection name", () => {
    writeConfig([{ name: "real", host: "h", user: "u" }]);
    const r = cli(["test", "ghost"]);
    expect(r.stdout).toMatch(/not found/i);
  });

  it("FAILs against an unreachable host (validates the test path runs)", () => {
    // 127.0.0.1:1 is the canonical "nothing listens here" address.
    // Connect attempt errors out fast and we want to see FAIL in the output.
    writeConfig([
      { name: "deadhost", host: "127.0.0.1", port: 1, user: "u", password: "p" },
    ]);
    const r = cli(["test", "deadhost"]);
    // Process always exits 0 (testConnection swallows the error and prints)
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/FAIL/);
  });
});

// ── unknown command ─────────────────────────────────────────────────

describe("CLI unknown command", () => {
  it("exits non-zero on unknown commands", () => {
    const r = cli(["wat"]);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/unknown command/i);
  });
});
