import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { loadConfig } from "../config.js";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Save and restore env vars between tests
const savedEnv: Record<string, string | undefined> = {};
const envKeys = [
  "QUERYBRIDGE_MCP_CONFIG",
  "QUERYBRIDGE_MCP_CONFIG_JSON",
  "MYSQL_MCP_CONFIG",
  "MYSQL_MCP_CONFIG_JSON",
  "MYSQL_HOST",
  "MYSQL_PORT",
  "MYSQL_USER",
  "MYSQL_PASSWORD",
  "MYSQL_DATABASE",
  "MYSQL_CONNECTION_NAME",
  "MYSQL_READONLY",
  "MYSQL_QUERY_TIMEOUT",
  "SSH_HOST",
  "SSH_PORT",
  "SSH_USER",
  "SSH_USERNAME",
  "SSH_PASSWORD",
  "SSH_PRIVATE_KEY_PATH",
  "SSH_PASSPHRASE",
  "SSH_HOST_FINGERPRINT",
];

beforeEach(() => {
  for (const key of envKeys) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of envKeys) {
    if (savedEnv[key] !== undefined) {
      process.env[key] = savedEnv[key];
    } else {
      delete process.env[key];
    }
  }
});

// ── loadConfig from env vars ────────────────────────────────────────

describe("loadConfig — env vars", () => {
  it("throws when no config is provided", () => {
    expect(() => loadConfig()).toThrow("No configuration found");
  });

  it("loads single connection from MYSQL_HOST", () => {
    process.env.MYSQL_HOST = "127.0.0.1";
    process.env.MYSQL_USER = "testuser";
    process.env.MYSQL_PASSWORD = "secret";
    process.env.MYSQL_DATABASE = "testdb";

    const config = loadConfig();
    expect(config.connections).toHaveLength(1);
    expect(config.connections[0].host).toBe("127.0.0.1");
    expect(config.connections[0].user).toBe("testuser");
    expect(config.connections[0].password).toBe("secret");
    expect(config.connections[0].database).toBe("testdb");
  });

  it("uses default connection name when not specified", () => {
    process.env.MYSQL_HOST = "localhost";

    const config = loadConfig();
    expect(config.connections[0].name).toBe("default");
  });

  it("uses custom connection name", () => {
    process.env.MYSQL_HOST = "localhost";
    process.env.MYSQL_CONNECTION_NAME = "production";

    const config = loadConfig();
    expect(config.connections[0].name).toBe("production");
  });

  it("defaults to port 3306", () => {
    process.env.MYSQL_HOST = "localhost";

    const config = loadConfig();
    expect(config.connections[0].port).toBe(3306);
  });

  it("parses custom port", () => {
    process.env.MYSQL_HOST = "localhost";
    process.env.MYSQL_PORT = "3307";

    const config = loadConfig();
    expect(config.connections[0].port).toBe(3307);
  });

  it("defaults to readonly true", () => {
    process.env.MYSQL_HOST = "localhost";

    const config = loadConfig();
    expect(config.connections[0].readonly).toBe(true);
  });

  it("sets readonly false when explicitly specified", () => {
    process.env.MYSQL_HOST = "localhost";
    process.env.MYSQL_READONLY = "false";

    const config = loadConfig();
    expect(config.connections[0].readonly).toBe(false);
  });

  it("parses query timeout", () => {
    process.env.MYSQL_HOST = "localhost";
    process.env.MYSQL_QUERY_TIMEOUT = "5000";

    const config = loadConfig();
    expect(config.connections[0].queryTimeout).toBe(5000);
  });

  it("includes SSH config when SSH_HOST is set", () => {
    process.env.MYSQL_HOST = "rds.internal";
    process.env.SSH_HOST = "bastion.example.com";
    process.env.SSH_USER = "deploy";

    const config = loadConfig();
    expect(config.connections[0].ssh).toBeDefined();
    expect(config.connections[0].ssh!.host).toBe("bastion.example.com");
    expect(config.connections[0].ssh!.username).toBe("deploy");
    expect(config.connections[0].ssh!.port).toBe(22);
  });

  it("does not include SSH config when SSH_HOST is not set", () => {
    process.env.MYSQL_HOST = "localhost";

    const config = loadConfig();
    expect(config.connections[0].ssh).toBeUndefined();
  });
});

// ── loadConfig from inline JSON ─────────────────────────────────────

describe("loadConfig — inline JSON", () => {
  it("loads from QUERYBRIDGE_MCP_CONFIG_JSON", () => {
    process.env.QUERYBRIDGE_MCP_CONFIG_JSON = JSON.stringify({
      connections: [
        { name: "test", host: "db.local", user: "admin", port: 3306 },
      ],
    });

    const config = loadConfig();
    expect(config.connections).toHaveLength(1);
    expect(config.connections[0].name).toBe("test");
    expect(config.connections[0].host).toBe("db.local");
  });

  it("accepts bare array format", () => {
    process.env.QUERYBRIDGE_MCP_CONFIG_JSON = JSON.stringify([
      { name: "a", host: "h1", user: "u1" },
      { name: "b", host: "h2", user: "u2" },
    ]);

    const config = loadConfig();
    expect(config.connections).toHaveLength(2);
  });

  it("defaults readonly to true", () => {
    process.env.QUERYBRIDGE_MCP_CONFIG_JSON = JSON.stringify({
      connections: [{ name: "t", host: "h", user: "u" }],
    });

    const config = loadConfig();
    expect(config.connections[0].readonly).toBe(true);
  });

  it("allows readonly false", () => {
    process.env.QUERYBRIDGE_MCP_CONFIG_JSON = JSON.stringify({
      connections: [{ name: "t", host: "h", user: "u", readonly: false }],
    });

    const config = loadConfig();
    expect(config.connections[0].readonly).toBe(false);
  });

  it("rejects missing host", () => {
    process.env.QUERYBRIDGE_MCP_CONFIG_JSON = JSON.stringify({
      connections: [{ name: "t", user: "u" }],
    });

    expect(() => loadConfig()).toThrow(/connections\.0\.host/);
  });

  it("rejects missing user", () => {
    process.env.QUERYBRIDGE_MCP_CONFIG_JSON = JSON.stringify({
      connections: [{ name: "t", host: "h" }],
    });

    expect(() => loadConfig()).toThrow(/connections\.0\.user/);
  });

  it("rejects invalid root type", () => {
    process.env.QUERYBRIDGE_MCP_CONFIG_JSON = '"not an object"';

    expect(() => loadConfig()).toThrow("Invalid config");
  });

  it("parses SSH config with tilde expansion", () => {
    process.env.QUERYBRIDGE_MCP_CONFIG_JSON = JSON.stringify({
      connections: [
        {
          name: "t",
          host: "h",
          user: "u",
          ssh: {
            host: "bastion",
            username: "deploy",
            privateKeyPath: "~/.ssh/id_rsa",
          },
        },
      ],
    });

    const config = loadConfig();
    expect(config.connections[0].ssh!.privateKeyPath).not.toContain("~");
    expect(config.connections[0].ssh!.privateKeyPath).toContain(".ssh/id_rsa");
  });

  it("preserves ssh.hostFingerprint through parseSSH", () => {
    const fp = "SHA256:AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKK";
    process.env.QUERYBRIDGE_MCP_CONFIG_JSON = JSON.stringify({
      connections: [
        {
          name: "t",
          host: "h",
          user: "u",
          ssh: {
            host: "bastion",
            username: "deploy",
            hostFingerprint: fp,
          },
        },
      ],
    });

    const config = loadConfig();
    expect(config.connections[0].ssh!.hostFingerprint).toBe(fp);
  });

  it("reads ssh.hostFingerprint from SSH_HOST_FINGERPRINT env var", () => {
    const fp = "SHA256:ZZZZYYYYXXXXWWWWVVVVUUUUTTTTSSSSRRRRQQQQPPP";
    process.env.MYSQL_HOST = "localhost";
    process.env.MYSQL_USER = "root";
    process.env.SSH_HOST = "bastion.example.com";
    process.env.SSH_USER = "deploy";
    process.env.SSH_HOST_FINGERPRINT = fp;

    const config = loadConfig();
    expect(config.connections[0].ssh!.hostFingerprint).toBe(fp);
  });

  it("parses SSL boolean shorthand", () => {
    process.env.QUERYBRIDGE_MCP_CONFIG_JSON = JSON.stringify({
      connections: [{ name: "t", host: "h", user: "u", ssl: true }],
    });

    const config = loadConfig();
    expect(config.connections[0].ssl).toBe(true);
  });

  it("parses SSL object config", () => {
    process.env.QUERYBRIDGE_MCP_CONFIG_JSON = JSON.stringify({
      connections: [
        {
          name: "t",
          host: "h",
          user: "u",
          ssl: { ca: "/path/to/ca.pem", rejectUnauthorized: false },
        },
      ],
    });

    const config = loadConfig();
    const ssl = config.connections[0].ssl as {
      ca: string;
      rejectUnauthorized: boolean;
    };
    expect(ssl.ca).toBe("/path/to/ca.pem");
    expect(ssl.rejectUnauthorized).toBe(false);
  });

  it("rejects SSH config without host", () => {
    process.env.QUERYBRIDGE_MCP_CONFIG_JSON = JSON.stringify({
      connections: [
        {
          name: "t",
          host: "h",
          user: "u",
          ssh: { username: "deploy" },
        },
      ],
    });

    expect(() => loadConfig()).toThrow(/connections\.0\.ssh\.host/);
  });

  it("auto-generates connection names", () => {
    process.env.QUERYBRIDGE_MCP_CONFIG_JSON = JSON.stringify({
      connections: [
        { host: "h1", user: "u" },
        { host: "h2", user: "u" },
      ],
    });

    const config = loadConfig();
    expect(config.connections[0].name).toBe("connection-0");
    expect(config.connections[1].name).toBe("connection-1");
  });
});

// ── loadConfig from file ────────────────────────────────────────────

describe("loadConfig — config file", () => {
  const tmpFile = join(tmpdir(), `querybridge-mcp-test-${Date.now()}.json`);

  afterEach(() => {
    try {
      unlinkSync(tmpFile);
    } catch {
      // ignore
    }
  });

  it("loads from QUERYBRIDGE_MCP_CONFIG file path", () => {
    writeFileSync(
      tmpFile,
      JSON.stringify({
        connections: [{ name: "file-test", host: "db.local", user: "admin" }],
      }),
    );
    process.env.QUERYBRIDGE_MCP_CONFIG = tmpFile;

    const config = loadConfig();
    expect(config.connections[0].name).toBe("file-test");
  });

  it("QUERYBRIDGE_MCP_CONFIG takes priority over MYSQL_HOST", () => {
    writeFileSync(
      tmpFile,
      JSON.stringify({
        connections: [{ name: "from-file", host: "file-host", user: "u" }],
      }),
    );
    process.env.QUERYBRIDGE_MCP_CONFIG = tmpFile;
    process.env.MYSQL_HOST = "env-host";

    const config = loadConfig();
    expect(config.connections[0].host).toBe("file-host");
  });
});

// ── Secret indirection ──────────────────────────────────────────────

describe("loadConfig — secret indirection", () => {
  const tmpSecretFile = join(tmpdir(), `qb-secret-${Date.now()}.txt`);

  afterEach(() => {
    try {
      unlinkSync(tmpSecretFile);
    } catch {
      // ignore
    }
  });

  it("resolves password from { env: 'VAR' }", () => {
    process.env.MY_DB_PWD = "secret-from-env";
    process.env.QUERYBRIDGE_MCP_CONFIG_JSON = JSON.stringify({
      connections: [
        { name: "t", host: "h", user: "u", password: { env: "MY_DB_PWD" } },
      ],
    });

    const config = loadConfig();
    expect(config.connections[0].password).toBe("secret-from-env");
    delete process.env.MY_DB_PWD;
  });

  it("rejects { env: 'VAR' } when the env var is unset", () => {
    delete process.env.MISSING_PWD;
    process.env.QUERYBRIDGE_MCP_CONFIG_JSON = JSON.stringify({
      connections: [
        { name: "t", host: "h", user: "u", password: { env: "MISSING_PWD" } },
      ],
    });

    expect(() => loadConfig()).toThrow(/MISSING_PWD.*unset or empty/);
  });

  it("rejects { env: 'VAR' } when the env var is empty string", () => {
    process.env.EMPTY_PWD = "";
    process.env.QUERYBRIDGE_MCP_CONFIG_JSON = JSON.stringify({
      connections: [
        { name: "t", host: "h", user: "u", password: { env: "EMPTY_PWD" } },
      ],
    });

    expect(() => loadConfig()).toThrow(/EMPTY_PWD.*unset or empty/);
    delete process.env.EMPTY_PWD;
  });

  it("resolves password from { file: '...' } and trims trailing whitespace", () => {
    writeFileSync(tmpSecretFile, "secret-from-file\n");
    process.env.QUERYBRIDGE_MCP_CONFIG_JSON = JSON.stringify({
      connections: [
        {
          name: "t",
          host: "h",
          user: "u",
          password: { file: tmpSecretFile },
        },
      ],
    });

    const config = loadConfig();
    expect(config.connections[0].password).toBe("secret-from-file");
  });

  it("rejects { file: '...' } when the file is missing", () => {
    process.env.QUERYBRIDGE_MCP_CONFIG_JSON = JSON.stringify({
      connections: [
        {
          name: "t",
          host: "h",
          user: "u",
          password: { file: "/nonexistent/path/to/secret" },
        },
      ],
    });

    expect(() => loadConfig()).toThrow(/cannot read secret file/);
  });

  it("resolves ssh.password from { env: 'VAR' }", () => {
    process.env.SSH_PWD_VAR = "ssh-secret";
    process.env.QUERYBRIDGE_MCP_CONFIG_JSON = JSON.stringify({
      connections: [
        {
          name: "t",
          host: "h",
          user: "u",
          ssh: {
            host: "bastion",
            username: "deploy",
            password: { env: "SSH_PWD_VAR" },
          },
        },
      ],
    });

    const config = loadConfig();
    expect(config.connections[0].ssh!.password).toBe("ssh-secret");
    delete process.env.SSH_PWD_VAR;
  });

  it("still accepts plain string password (back-compat)", () => {
    process.env.QUERYBRIDGE_MCP_CONFIG_JSON = JSON.stringify({
      connections: [{ name: "t", host: "h", user: "u", password: "plain" }],
    });

    const config = loadConfig();
    expect(config.connections[0].password).toBe("plain");
  });
});

// ── Legacy env var fallback ─────────────────────────────────────────

describe("loadConfig — legacy env var fallback", () => {
  const tmpFile = join(tmpdir(), `querybridge-mcp-legacy-${Date.now()}.json`);
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    try {
      unlinkSync(tmpFile);
    } catch {
      // ignore
    }
  });

  it("falls back to MYSQL_MCP_CONFIG and warns", () => {
    writeFileSync(
      tmpFile,
      JSON.stringify({
        connections: [{ name: "legacy", host: "db.local", user: "admin" }],
      }),
    );
    process.env.MYSQL_MCP_CONFIG = tmpFile;

    const config = loadConfig();
    expect(config.connections[0].name).toBe("legacy");
    const warnings = (stderrSpy.mock.calls as unknown[][])
      .map((c) => c[0] as string)
      .filter((m) => m.includes("MYSQL_MCP_CONFIG is deprecated"));
    expect(warnings).toHaveLength(1);
  });

  it("falls back to MYSQL_MCP_CONFIG_JSON and warns", () => {
    process.env.MYSQL_MCP_CONFIG_JSON = JSON.stringify({
      connections: [{ name: "legacy-inline", host: "h", user: "u" }],
    });

    const config = loadConfig();
    expect(config.connections[0].name).toBe("legacy-inline");
    const warnings = (stderrSpy.mock.calls as unknown[][])
      .map((c) => c[0] as string)
      .filter((m) => m.includes("MYSQL_MCP_CONFIG_JSON is deprecated"));
    expect(warnings).toHaveLength(1);
  });

  it("prefers QUERYBRIDGE_MCP_CONFIG over MYSQL_MCP_CONFIG without warning", () => {
    writeFileSync(
      tmpFile,
      JSON.stringify({
        connections: [{ name: "new", host: "h", user: "u" }],
      }),
    );
    process.env.QUERYBRIDGE_MCP_CONFIG = tmpFile;
    process.env.MYSQL_MCP_CONFIG = "/nonexistent";

    const config = loadConfig();
    expect(config.connections[0].name).toBe("new");
    const warnings = (stderrSpy.mock.calls as unknown[][])
      .map((c) => c[0] as string)
      .filter((m) => m.includes("deprecated"));
    expect(warnings).toHaveLength(0);
  });
});
