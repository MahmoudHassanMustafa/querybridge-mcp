import { homedir } from "node:os";

/**
 * Expand a leading `~` to the user's home directory. Accepts `~`,
 * `~/`, and `~/foo` shapes. Anything that does not start with `~` is
 * returned unchanged.
 *
 * Used in config-loading to make paths like `~/.ssh/id_rsa` portable.
 */
export function expandTilde(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return p.replace("~", homedir());
  }
  return p;
}
