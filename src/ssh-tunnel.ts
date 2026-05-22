import { readFileSync } from "node:fs";
import net from "node:net";
import { createHash, timingSafeEqual } from "node:crypto";
import { Client as SSHClient } from "ssh2";
import type { ConnectConfig } from "ssh2";
import type { DatabaseConfig } from "./schema.js";
import { log } from "./log.js";

/**
 * Build an ssh2 hostVerifier callback that enforces the given SHA256
 * fingerprint. Returns undefined when no fingerprint is configured —
 * callers treat undefined as "no verification, warn the operator".
 *
 * Expected input format is what `ssh-keygen -lf <pubkey>` produces:
 *   "SHA256:abc123...base64..."
 * The "SHA256:" prefix is optional; trailing "=" padding is tolerated
 * on either side.
 *
 * Comparison uses `timingSafeEqual` so a network-observable timing
 * channel can't be used to recover the fingerprint byte-by-byte.
 */
export function buildHostVerifier(
  expected: string | undefined,
): ((key: Buffer) => boolean) | undefined {
  if (!expected) return undefined;
  const normalized = expected
    .replace(/^SHA256:/i, "")
    .replace(/=+$/, "")
    .trim();
  return (key: Buffer) => {
    const actual = createHash("sha256")
      .update(key)
      .digest("base64")
      .replace(/=+$/, "");
    const a = Buffer.from(actual);
    const b = Buffer.from(normalized);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  };
}

export interface SSHTunnel {
  host: string;
  port: number;
  sshClient: SSHClient;
  localServer: net.Server;
}

/**
 * Open an SSH tunnel from a local ephemeral port to `config.host:config.port`
 * via `config.ssh.*`. Shared by the long-lived MCP server connection pool and
 * the one-shot CLI `test` command, so both paths get the same fingerprint
 * verification, keepalives, and error handling.
 *
 * On success: returns the bound 127.0.0.1 port plus the underlying ssh2
 * client and listener so the caller can tear them down.
 *
 * Behavior notes:
 *  - Persistent `error` listeners on both the ssh2 client and the local
 *    server are installed. Without them, a late error event after the
 *    initial connect resolved would crash the Node process.
 *  - When the ssh client emits `close`, the local listener is closed too
 *    so the next caller gets ECONNREFUSED rather than hanging on TCP to
 *    a port whose upstream channel is dead.
 *  - `hostFingerprint` is enforced via timingSafeEqual SHA256 comparison
 *    when set; when unset, a warning is logged.
 */
export function createSSHTunnel(config: DatabaseConfig): Promise<SSHTunnel> {
  return new Promise((resolvePromise, rejectPromise) => {
    const ssh = config.ssh;
    if (!ssh) {
      rejectPromise(new Error("createSSHTunnel called without ssh config"));
      return;
    }

    const client = new SSHClient();
    const hostVerifier = buildHostVerifier(ssh.hostFingerprint);
    let settled = false;
    let localServerRef: net.Server | undefined;

    if (hostVerifier) {
      log("info", "SSH host fingerprint verification enabled", {
        connection: config.name,
        sshHost: ssh.host,
      });
    } else {
      log(
        "warn",
        "SSH host key verification not enforced; set ssh.hostFingerprint to prevent MITM",
        { connection: config.name, sshHost: ssh.host },
      );
    }

    const sshConfig: ConnectConfig = {
      host: ssh.host,
      port: ssh.port,
      username: ssh.username,
      readyTimeout: 10000,
      // Defaults picked to survive 60-120s bastion idle timeouts during
      // schema scans. Users can opt out with keepaliveInterval: 0.
      keepaliveInterval: ssh.keepaliveInterval ?? 30000,
      keepaliveCountMax: ssh.keepaliveCountMax ?? 3,
      ...(hostVerifier ? { hostVerifier } : {}),
    };

    if (ssh.privateKeyPath) {
      sshConfig.privateKey = readFileSync(ssh.privateKeyPath);
      if (ssh.passphrase) {
        sshConfig.passphrase = ssh.passphrase;
      }
    } else if (ssh.password) {
      sshConfig.password = ssh.password;
    }

    client.on("error", (err) => {
      log("warn", "SSH client error", {
        connection: config.name,
        error: err.message,
      });
      if (!settled) {
        settled = true;
        rejectPromise(err);
      }
    });
    client.on("end", () => {
      log("info", "SSH client disconnected (end)", {
        connection: config.name,
      });
    });
    client.on("close", () => {
      log("info", "SSH client closed", { connection: config.name });
      if (localServerRef?.listening) {
        localServerRef.close();
      }
    });

    client.on("ready", () => {
      const localServer = net.createServer((sock) => {
        client.forwardOut(
          "127.0.0.1",
          0,
          config.host,
          config.port,
          (err, stream) => {
            if (err) {
              log("warn", "SSH forwardOut failed", {
                connection: config.name,
                error: err.message,
              });
              sock.destroy();
              return;
            }
            sock.pipe(stream).pipe(sock);
            sock.on("error", (e: Error) => {
              log("warn", "SSH tunnel local socket error", {
                connection: config.name,
                error: e.message,
              });
              stream.destroy();
            });
            stream.on("error", (e: Error) => {
              log("warn", "SSH tunnel remote stream error", {
                connection: config.name,
                error: e.message,
              });
              sock.destroy();
            });
          },
        );
      });

      localServerRef = localServer;

      localServer.on("error", (err) => {
        log("warn", "SSH tunnel localServer error", {
          connection: config.name,
          error: err.message,
        });
        if (!settled) {
          settled = true;
          rejectPromise(err);
        }
      });

      localServer.listen(0, "127.0.0.1", () => {
        const addr = localServer.address() as net.AddressInfo;
        settled = true;
        resolvePromise({
          host: "127.0.0.1",
          port: addr.port,
          sshClient: client,
          localServer,
        });
      });
    });

    client.connect(sshConfig);
  });
}

/**
 * Best-effort tunnel teardown. Both calls swallow errors because the
 * tunnel might already be half-closed.
 */
export function closeSSHTunnel(tunnel: Pick<SSHTunnel, "sshClient" | "localServer">): void {
  try {
    tunnel.localServer.close();
  } catch {
    // ignore
  }
  try {
    tunnel.sshClient.end();
  } catch {
    // ignore
  }
}
