import { describe, expect, it } from "vitest";
import { splitSqlStatements } from "../sql/split.js";

describe("splitSqlStatements", () => {
  it("splits a simple two-statement script", () => {
    const out = splitSqlStatements("SELECT 1; SELECT 2;");
    expect(out).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("returns the trailing statement even without a closing semicolon", () => {
    const out = splitSqlStatements("SELECT 1;\nSELECT 2");
    expect(out).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("ignores a single empty trailing semicolon", () => {
    expect(splitSqlStatements("SELECT 1;;")).toEqual(["SELECT 1"]);
  });

  it("drops a comment-only statement", () => {
    // -- header at the top of a file shouldn't become a statement.
    expect(
      splitSqlStatements("-- author: someone\nSELECT 1;"),
    ).toEqual(["-- author: someone\nSELECT 1"]);
    // Comment-only between statements is dropped entirely.
    expect(splitSqlStatements("SELECT 1; -- aside\n;SELECT 2;")).toEqual([
      "SELECT 1",
      "SELECT 2",
    ]);
  });

  it("preserves semicolons inside single-quoted strings", () => {
    const out = splitSqlStatements(
      `INSERT INTO logs (msg) VALUES ('a;b;c'); SELECT 1;`,
    );
    expect(out).toEqual([
      `INSERT INTO logs (msg) VALUES ('a;b;c')`,
      "SELECT 1",
    ]);
  });

  it("handles backslash-escaped quotes in strings", () => {
    const out = splitSqlStatements(
      `INSERT INTO t VALUES ('he said \\'hi;\\' loudly'); SELECT 1;`,
    );
    expect(out[0]).toContain("hi;");
    expect(out).toHaveLength(2);
  });

  it("handles doubled-quote-as-literal escape", () => {
    // 'it''s' is the SQL-standard way to embed a quote
    const out = splitSqlStatements(`INSERT INTO t VALUES ('it''s; ok'); SELECT 1;`);
    expect(out[0]).toContain("it''s; ok");
    expect(out).toHaveLength(2);
  });

  it("preserves semicolons inside double-quoted strings", () => {
    const out = splitSqlStatements(
      `SELECT "x;y" AS v; SELECT 2;`,
    );
    expect(out).toEqual([`SELECT "x;y" AS v`, "SELECT 2"]);
  });

  it("preserves semicolons inside backtick identifiers", () => {
    // Pathological but legal — identifier with a semicolon.
    const out = splitSqlStatements("SELECT 1 AS `a;b`; SELECT 2;");
    expect(out).toEqual(["SELECT 1 AS `a;b`", "SELECT 2"]);
  });

  it("preserves semicolons inside block comments", () => {
    const out = splitSqlStatements(
      "SELECT 1 /* note: a; b; c */ ; SELECT 2;",
    );
    expect(out).toEqual(["SELECT 1 /* note: a; b; c */", "SELECT 2"]);
  });

  it("preserves semicolons inside line comments", () => {
    const out = splitSqlStatements(
      "SELECT 1; -- a; b; c\nSELECT 2;",
    );
    expect(out).toEqual(["SELECT 1", "-- a; b; c\nSELECT 2"]);
  });

  it("handles MySQL # line comments", () => {
    const out = splitSqlStatements(
      "SELECT 1; # a; b; c\nSELECT 2;",
    );
    expect(out).toEqual(["SELECT 1", "# a; b; c\nSELECT 2"]);
  });

  it("handles realistic CREATE TABLE block (multi-line, comments, defaults)", () => {
    const sql = [
      "-- schema for users",
      "CREATE TABLE users (",
      "  id INT PRIMARY KEY AUTO_INCREMENT,",
      "  email VARCHAR(255) NOT NULL,",
      "  status ENUM('active', 'inactive', 'banned;deleted') DEFAULT 'active',",
      "  created_at DATETIME DEFAULT CURRENT_TIMESTAMP",
      ") ENGINE=InnoDB;",
      "",
      "CREATE INDEX idx_email ON users (email);",
    ].join("\n");

    const out = splitSqlStatements(sql);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("CREATE TABLE users");
    expect(out[0]).toContain("banned;deleted"); // semicolon in enum literal preserved
    expect(out[1]).toContain("CREATE INDEX idx_email");
  });

  it("returns an empty array for empty / whitespace-only input", () => {
    expect(splitSqlStatements("")).toEqual([]);
    expect(splitSqlStatements("   \n\t  ")).toEqual([]);
    expect(splitSqlStatements("/* just a comment */")).toEqual([]);
  });
});
