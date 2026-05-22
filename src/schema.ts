import { readFileSync } from "node:fs";
import { z } from "zod";
import { expandTilde } from "./paths.js";

const tildePath = z.string().min(1).transform((p) => expandTilde(p));

/**
 * Resolve a secret at config-load time. Accepts:
 *  - a literal string (legacy / dev convenience)
 *  - `{ env: "VAR" }` — read process.env.VAR (errors if unset/empty)
 *  - `{ file: "/path" }` — read file contents (tilde-expanded, trimmed)
 *
 * Resolved into a plain string so downstream code (mysql2, ssh2) doesn't
 * need to know about indirection. Errors during resolution bubble up
 * with the schema path so operators see exactly which field failed.
 */
const secretSchema = z
  .union([
    z.string(),
    z.object({ env: z.string().min(1) }).strict(),
    z.object({ file: z.string().min(1) }).strict(),
  ])
  .transform((val, ctx) => {
    if (typeof val === "string") return val;
    if ("env" in val) {
      const v = process.env[val.env];
      if (v == null || v === "") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `env var "${val.env}" is unset or empty`,
        });
        return z.NEVER;
      }
      return v;
    }
    try {
      return readFileSync(expandTilde(val.file), "utf-8").trim();
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `cannot read secret file "${val.file}": ${err instanceof Error ? err.message : String(err)}`,
      });
      return z.NEVER;
    }
  });

export const SSHConfigSchema = z.object({
  host: z.string().min(1, "ssh.host is required"),
  port: z.number().int().positive().max(65535).default(22),
  username: z.string().min(1, "ssh.username is required"),
  password: secretSchema.optional(),
  privateKeyPath: tildePath.optional(),
  passphrase: secretSchema.optional(),
  /**
   * Optional SHA256 host key fingerprint for MITM prevention.
   * Format: "SHA256:abc123..." (the output of `ssh-keygen -lf <pubkey>`).
   * When omitted, the connection proceeds without verification and a
   * warning is logged.
   */
  hostFingerprint: z.string().optional(),
  /**
   * SSH-level keepalive interval in ms. Prevents bastions and cloud SSH
   * endpoints from dropping idle tunnels between tool calls. Set to 0 to
   * disable. Default: 30000.
   */
  keepaliveInterval: z.number().int().nonnegative().optional(),
  /** Consecutive unanswered keepalives before ssh2 disconnects. Default: 3. */
  keepaliveCountMax: z.number().int().nonnegative().optional(),
});

export const SSLObjectSchema = z.object({
  ca: tildePath.optional(),
  cert: tildePath.optional(),
  key: tildePath.optional(),
  rejectUnauthorized: z.boolean().default(true),
});

export const SSLConfigSchema = z.union([z.literal(true), SSLObjectSchema]);

export const DatabaseConfigSchema = z.object({
  name: z.string().min(1),
  host: z.string().min(1, "host is required"),
  port: z.number().int().positive().max(65535).default(3306),
  user: z.string().min(1, "user is required"),
  password: secretSchema.optional(),
  database: z.string().optional(),
  ssh: SSHConfigSchema.optional(),
  ssl: SSLConfigSchema.optional(),
  readonly: z.boolean().default(true),
  queryTimeout: z.number().int().positive().optional(),
  /**
   * mysql2 pool `connectionLimit`. Tune up for connections that get
   * fan-out queries from an agent (parallel describe_table on many tables);
   * tune down for shared production databases where you want to bound
   * concurrency. Default: 5.
   */
  poolSize: z.number().int().positive().max(50).default(5),
});

/**
 * Auto-name unnamed connections by their array index so downstream code
 * never sees a missing name. Accepts both the canonical `{ connections: [] }`
 * shape and a bare array.
 */
export const AppConfigSchema = z.preprocess(
  (raw) => {
    const arr = Array.isArray(raw)
      ? raw
      : raw && typeof raw === "object" && Array.isArray((raw as { connections?: unknown }).connections)
        ? (raw as { connections: unknown[] }).connections
        : null;
    if (!arr) return raw;
    const named = arr.map((c, i) =>
      c && typeof c === "object" && !(c as { name?: unknown }).name
        ? { ...(c as object), name: `connection-${i}` }
        : c,
    );
    return { connections: named };
  },
  z.object({
    connections: z.array(DatabaseConfigSchema).default([]),
  }),
);

export type SSHConfig = z.infer<typeof SSHConfigSchema>;
export type SSLConfig = z.infer<typeof SSLObjectSchema>;
export type DatabaseConfig = z.infer<typeof DatabaseConfigSchema>;
export type AppConfig = z.infer<typeof AppConfigSchema>;

/**
 * Format a ZodError into a single human-readable message. We avoid the
 * default JSON dump because it's noisy and the path information is the
 * thing operators actually need.
 */
export function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((issue) => {
      const path = issue.path.length ? issue.path.join(".") : "(root)";
      return `  - ${path}: ${issue.message}`;
    })
    .join("\n");
}
