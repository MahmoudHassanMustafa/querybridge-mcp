import { describe, it, expect } from "vitest";
import { isReadOnlyQuery, isExplainSafe } from "../sql/readonly.js";

// ── isReadOnlyQuery: allowed queries ────────────────────────────────

describe("isReadOnlyQuery — allowed", () => {
  const allowed = [
    "SELECT * FROM users",
    "select count(*) from orders",
    "SELECT u.id, u.name FROM users u JOIN orders o ON u.id = o.user_id",
    "SHOW DATABASES",
    "SHOW TABLES",
    "SHOW CREATE TABLE users",
    "SHOW INDEX FROM users",
    "DESCRIBE users",
    "DESC users",
    "EXPLAIN SELECT * FROM users",
    "USE mydb",
    "WITH cte AS (SELECT 1) SELECT * FROM cte",
    "WITH RECURSIVE tree AS (SELECT id, parent_id FROM nodes WHERE parent_id IS NULL UNION ALL SELECT n.id, n.parent_id FROM nodes n JOIN tree t ON n.parent_id = t.id) SELECT * FROM tree",
    "  SELECT * FROM users", // leading whitespace
    "SELECT 1", // simple literal
  ];

  for (const sql of allowed) {
    it(`allows: ${sql.substring(0, 60)}`, () => {
      expect(isReadOnlyQuery(sql)).toBe(true);
    });
  }
});

// ── isReadOnlyQuery: blocked write operations ───────────────────────

describe("isReadOnlyQuery — blocked writes", () => {
  const blocked = [
    "INSERT INTO users VALUES (1, 'x')",
    "UPDATE users SET name = 'x'",
    "DELETE FROM users",
    "DROP TABLE users",
    "ALTER TABLE users ADD col INT",
    "CREATE TABLE t (id INT)",
    "TRUNCATE TABLE users",
    "REPLACE INTO users VALUES (1, 'x')",
    "RENAME TABLE a TO b",
    "GRANT ALL ON *.* TO root",
    "REVOKE ALL ON *.* FROM root",
    "LOCK TABLES users READ",
    "UNLOCK TABLES",
    "CALL destructive_proc()",
    "SET GLOBAL max_connections = 1",
    "SET @@global.read_only = 0",
    "LOAD DATA INFILE '/etc/passwd' INTO TABLE t",
    "DO SLEEP(99999)",
    "HANDLER users OPEN",
    "PREPARE stmt FROM 'DELETE FROM users'",
    "EXECUTE stmt",
    "DEALLOCATE PREPARE stmt",
    "RESET MASTER",
    "PURGE BINARY LOGS BEFORE '2025-01-01'",
    "BEGIN",
    "COMMIT",
    "ROLLBACK",
    "START TRANSACTION",
  ];

  for (const sql of blocked) {
    it(`blocks: ${sql.substring(0, 60)}`, () => {
      expect(isReadOnlyQuery(sql)).toBe(false);
    });
  }
});

// ── isReadOnlyQuery: comment bypass attempts ────────────────────────

describe("isReadOnlyQuery — comment bypass resistance", () => {
  const bypasses = [
    "/* safe */ DROP TABLE users",
    "/* comment */ INSERT INTO users VALUES (1)",
    "-- bypass\nDELETE FROM users",
    "# bypass\nUPDATE users SET id = 1",
    "/* nested /* still */ works */ DROP TABLE users",
    "/**/DELETE FROM users",
  ];

  for (const sql of bypasses) {
    it(`blocks comment bypass: ${sql.substring(0, 50)}`, () => {
      expect(isReadOnlyQuery(sql)).toBe(false);
    });
  }
});

// ── isReadOnlyQuery: WITH + write bypass attempts ───────────────────

describe("isReadOnlyQuery — WITH + write keyword resistance", () => {
  const blocked = [
    "WITH cte AS (SELECT 1) INSERT INTO users SELECT * FROM cte",
    "WITH cte AS (SELECT 1) UPDATE users SET id = 1",
    "WITH cte AS (SELECT 1) DELETE FROM users",
    "WITH cte AS (SELECT 1) DROP TABLE users",
    "WITH x AS (SELECT 1) CALL proc()",
    "WITH x AS (SELECT 1) TRUNCATE TABLE users",
  ];

  for (const sql of blocked) {
    it(`blocks WITH + write: ${sql.substring(0, 55)}`, () => {
      expect(isReadOnlyQuery(sql)).toBe(false);
    });
  }
});

// ── isReadOnlyQuery: SELECT INTO OUTFILE/DUMPFILE ───────────────────

describe("isReadOnlyQuery — SELECT INTO file write resistance", () => {
  const blocked = [
    "SELECT * FROM users INTO OUTFILE '/tmp/data.csv'",
    "SELECT '<?php ?>' INTO DUMPFILE '/var/www/shell.php'",
    "select * from t into outfile '/tmp/x'",
    "SELECT 1 INTO   OUTFILE '/tmp/x'", // extra spaces
    "WITH cte AS (SELECT 1) SELECT * FROM cte INTO OUTFILE '/tmp/x'",
  ];

  for (const sql of blocked) {
    it(`blocks INTO file: ${sql.substring(0, 55)}`, () => {
      expect(isReadOnlyQuery(sql)).toBe(false);
    });
  }
});

// ── isReadOnlyQuery: misc blocked patterns ──────────────────────────

describe("isReadOnlyQuery — miscellaneous blocked patterns", () => {
  it("blocks parenthesized writes", () => {
    expect(isReadOnlyQuery("(DELETE FROM users)")).toBe(false);
  });

  it("blocks empty query", () => {
    expect(isReadOnlyQuery("")).toBe(false);
  });

  it("blocks whitespace-only query", () => {
    expect(isReadOnlyQuery("   ")).toBe(false);
  });

  it("blocks unknown statements", () => {
    expect(isReadOnlyQuery("OPTIMIZE TABLE users")).toBe(false);
  });

  it("blocks CHECK TABLE", () => {
    expect(isReadOnlyQuery("CHECK TABLE users")).toBe(false);
  });

  it("blocks ANALYZE TABLE", () => {
    expect(isReadOnlyQuery("ANALYZE TABLE users")).toBe(false);
  });

  it("blocks REPAIR TABLE", () => {
    expect(isReadOnlyQuery("REPAIR TABLE users")).toBe(false);
  });

  it("blocks XA transactions", () => {
    expect(isReadOnlyQuery("XA START 'txn1'")).toBe(false);
  });
});

// ── isExplainSafe ───────────────────────────────────────────────────

describe("isExplainSafe", () => {
  it("allows plain SELECT", () => {
    expect(isExplainSafe("SELECT * FROM users")).toBe(true);
  });

  it("allows WITH...SELECT", () => {
    expect(isExplainSafe("WITH cte AS (SELECT 1) SELECT * FROM cte")).toBe(true);
  });

  it("blocks INSERT", () => {
    expect(isExplainSafe("INSERT INTO users VALUES (1)")).toBe(false);
  });

  it("blocks UPDATE", () => {
    expect(isExplainSafe("UPDATE users SET x = 1")).toBe(false);
  });

  it("blocks DELETE", () => {
    expect(isExplainSafe("DELETE FROM users")).toBe(false);
  });

  it("blocks SHOW (not needed for EXPLAIN)", () => {
    expect(isExplainSafe("SHOW TABLES")).toBe(false);
  });

  it("blocks USE (not needed for EXPLAIN)", () => {
    expect(isExplainSafe("USE mydb")).toBe(false);
  });

  it("blocks WITH + INSERT", () => {
    expect(isExplainSafe("WITH cte AS (SELECT 1) INSERT INTO t SELECT * FROM cte")).toBe(false);
  });

  it("blocks SELECT INTO OUTFILE", () => {
    expect(isExplainSafe("SELECT * FROM users INTO OUTFILE '/tmp/x'")).toBe(false);
  });

  it("blocks comment-hidden writes", () => {
    expect(isExplainSafe("/* safe */ DELETE FROM users")).toBe(false);
  });
});
