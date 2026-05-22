import { describe, it, expect, vi } from "vitest";
import { withTransientRetry } from "../db/retry.js";

// `code` is what mysql2 / Node emit on real socket errors.
function transient(code: string): Error {
  const err = new Error(`Mock ${code}`);
  (err as { code?: string }).code = code;
  return err;
}

describe("withTransientRetry", () => {
  it("returns the result on first success without retrying", async () => {
    const fn = vi.fn().mockResolvedValueOnce("ok");
    const result = await withTransientRetry(fn, {
      connection: "c",
      operation: "test",
    });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries exactly once on a transient code, then returns the second result", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(transient("ECONNRESET"))
      .mockResolvedValueOnce("recovered");

    const result = await withTransientRetry(fn, {
      connection: "c",
      operation: "test",
      delayMs: 1,
    });

    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-transient errors", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("ER_PARSE_ERROR: syntax"));

    await expect(
      withTransientRetry(fn, { connection: "c", operation: "test" }),
    ).rejects.toThrow(/ER_PARSE_ERROR/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("rethrows when the retry attempt also fails", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(transient("ECONNRESET"))
      .mockRejectedValueOnce(transient("ECONNRESET"));

    await expect(
      withTransientRetry(fn, {
        connection: "c",
        operation: "test",
        delayMs: 1,
      }),
    ).rejects.toThrow(/ECONNRESET/);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it.each([
    "ECONNRESET",
    "ETIMEDOUT",
    "ECONNREFUSED",
    "PROTOCOL_CONNECTION_LOST",
    "EPIPE",
    "ENOTCONN",
  ])("retries on transient code %s", async (code) => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(transient(code))
      .mockResolvedValueOnce("ok");

    await withTransientRetry(fn, {
      connection: "c",
      operation: "test",
      delayMs: 1,
    });

    expect(fn).toHaveBeenCalledTimes(2);
  });
});
