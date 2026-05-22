/**
 * Split a multi-statement SQL string into individual statements,
 * respecting comments and quoted regions so that `;` characters
 * inside them don't get treated as separators.
 *
 * Handled:
 *   - `-- line comments`
 *   - `# line comments` (MySQL extension)
 *   - `/* block comments * /` (no nesting — MySQL doesn't support it)
 *   - `'single-quoted strings'` with `\'` escapes
 *   - `"double-quoted strings"` with `\"` escapes
 *   - `` `backtick-quoted identifiers` `` (no escaping inside backticks)
 *
 * NOT handled (intentionally — V1 limitation):
 *   - `DELIMITER` directives. mysql-client-style DELIMITER blocks that
 *     contain `;` inside a trigger/routine body are NOT correctly split
 *     here; each inner `;` becomes its own (broken) statement. Files
 *     that include triggers or stored routines should be loaded via
 *     a different tool, or pre-processed to inline the bodies.
 *
 *   - Dollar-quoted strings (Postgres). MySQL doesn't have them.
 *
 * Empty statements (only whitespace and/or comments) are dropped.
 */
export function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = "";
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const c = sql[i];
    const next = i + 1 < n ? sql[i + 1] : "";

    // Block comment /* ... */
    if (c === "/" && next === "*") {
      buf += "/*";
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) {
        buf += sql[i];
        i += 1;
      }
      if (i < n) {
        buf += "*/";
        i += 2;
      }
      continue;
    }

    // Line comment -- ... \n
    if (c === "-" && next === "-") {
      while (i < n && sql[i] !== "\n") {
        buf += sql[i];
        i += 1;
      }
      continue;
    }

    // MySQL hash line comment # ... \n
    if (c === "#") {
      while (i < n && sql[i] !== "\n") {
        buf += sql[i];
        i += 1;
      }
      continue;
    }

    // Quoted regions — copy through; the quote escapes its own kind
    // via doubling or backslash. We don't need to interpret content,
    // we just need to know when the region ends so a `;` inside it
    // doesn't terminate the statement.
    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      buf += quote;
      i += 1;
      while (i < n) {
        const ch = sql[i];
        if (ch === "\\" && quote !== "`") {
          // Backslash escape — copy the backslash AND the next char so
          // a `\'` doesn't close the string.
          buf += ch;
          if (i + 1 < n) {
            buf += sql[i + 1];
            i += 2;
          } else {
            i += 1;
          }
          continue;
        }
        if (ch === quote) {
          // MySQL also accepts doubled-quote-as-literal (e.g. 'it''s'),
          // so peek ahead — if the next char is the same quote, that's
          // an escape, not the close.
          if (i + 1 < n && sql[i + 1] === quote) {
            buf += quote;
            buf += quote;
            i += 2;
            continue;
          }
          buf += quote;
          i += 1;
          break;
        }
        buf += ch;
        i += 1;
      }
      continue;
    }

    // Statement terminator
    if (c === ";") {
      const trimmed = buf.trim();
      if (trimmed.length > 0 && !isCommentOnly(trimmed)) {
        out.push(trimmed);
      }
      buf = "";
      i += 1;
      continue;
    }

    buf += c;
    i += 1;
  }

  // Trailing statement without a closing `;` is still a valid statement.
  const tail = buf.trim();
  if (tail.length > 0 && !isCommentOnly(tail)) {
    out.push(tail);
  }
  return out;
}

/**
 * Is the trimmed statement just comments and whitespace? If so we
 * drop it — sending it to the server would cause an `ERROR 1065
 * (42000): Query was empty` error.
 *
 * The check is cheap because by the time we reach here, the splitter
 * already preserved every comment verbatim; we just need to verify
 * nothing non-comment survives.
 */
function isCommentOnly(stmt: string): boolean {
  // Strip block comments
  const noBlock = stmt.replace(/\/\*[\s\S]*?\*\//g, "");
  // Strip line comments (both -- and # forms)
  const noLine = noBlock.replace(/--[^\n]*/g, "").replace(/#[^\n]*/g, "");
  return noLine.trim().length === 0;
}
