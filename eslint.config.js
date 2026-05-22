// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
import prettierConfig from "eslint-config-prettier/flat";
import localPlugin from "./eslint-plugins/local.js";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      local: localPlugin,
    },
    rules: {
      // In-project rules — CONVENTIONS.md §4.2 and §5.1. Implementations
      // are in ./eslint-plugins/local.js; the rationale lives there.
      "local/no-record-unknown-query-result": "error",
      "local/log-message-no-interpolation": "error",

      // Project conventions: stderr-only logging, MCP transport on stdout.
      // Business code uses log(), never console.*. Overrides below allow
      // it in the two files that legitimately need it: log.ts (the logger
      // itself) and src/server/cli.ts (operator-facing CLI prints).
      "no-console": "error",

      // Catches things like `const v = obj.maybe!.thing` slipping in
      "@typescript-eslint/no-non-null-assertion": "warn",

      // We use `_arg` to mark intentionally-unused parameters
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],

      // `as` is fine for the mysql2 row → typed-record bridge, but new
      // `any` requires an explicit eslint-disable so the reviewer sees
      // and approves it (e.g. ToolExtra.sendNotification).
      "@typescript-eslint/no-explicit-any": "error",

      // // @ts-ignore is a sledgehammer; require @ts-expect-error which
      // turns into a lint error once the issue is fixed.
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          "ts-ignore": true,
          "ts-expect-error": "allow-with-description",
          "ts-nocheck": true,
          minimumDescriptionLength: 10,
        },
      ],

      "no-restricted-syntax": [
        "error",

        // ── Rule: tool handlers must be wrapped in toolHandler() ───────
        //
        // Without toolHandler the audit-log + sanitized-error envelope is
        // bypassed and a thrown MySQL error leaks raw 'user'@'host'
        // diagnostics to the LLM. CONVENTIONS.md §2.1 calls this a
        // security boundary, not a convenience. The legal pattern is:
        //
        //   server.registerTool("name", config, toolHandler("name", async (args) => …))
        //
        // Bare arrow/function expressions passed directly as the handler
        // are blocked here.
        {
          selector:
            "CallExpression[callee.property.name='registerTool'] > ArrowFunctionExpression",
          message:
            "Wrap registerTool handlers in toolHandler(name, fn) — bypassing the wrapper skips audit logging and leaks raw MySQL errors to the LLM. See CONVENTIONS.md §2.1.",
        },
        {
          selector:
            "CallExpression[callee.property.name='registerTool'] > FunctionExpression",
          message:
            "Wrap registerTool handlers in toolHandler(name, fn) — bypassing the wrapper skips audit logging and leaks raw MySQL errors to the LLM. See CONVENTIONS.md §2.1.",
        },

        // ── Rule: no value interpolation into SQL template literals ────
        //
        // CONVENTIONS.md §6.2: "Values go through `?` placeholders."
        // The narrow exception is `KILL QUERY <id>` where MySQL refuses
        // placeholders — that path uses Number.isInteger guards and an
        // explicit eslint-disable at the call site.
        //
        // This catches the most common SQL-injection bug shape: a bare
        // identifier or member access spliced into a template literal
        // whose first quasi looks like SQL. It does NOT catch
        // CallExpression interpolations — those might be safe like
        // escapeId(name) / qualifiedTable(db, table) or unsafe like
        // fmtRow(userInput). Reviewers eyeball CallExpression cases;
        // unsafe ones earn an eslint-disable with a justification.
        {
          selector:
            "TemplateLiteral[quasis.0.value.cooked=/^\\s*(KILL|SELECT|INSERT|UPDATE|DELETE|JOIN|SHOW|EXPLAIN|CREATE|ALTER|DROP|TRUNCATE|REPLACE|RENAME|USE|GRANT|REVOKE)\\b/] > Identifier",
          message:
            "Interpolating a bare identifier into a SQL template literal. Use a `?` placeholder for values, or escapeId/qualifiedTable for identifiers. See CONVENTIONS.md §6.",
        },
        {
          selector:
            "TemplateLiteral[quasis.0.value.cooked=/^\\s*(KILL|SELECT|INSERT|UPDATE|DELETE|JOIN|SHOW|EXPLAIN|CREATE|ALTER|DROP|TRUNCATE|REPLACE|RENAME|USE|GRANT|REVOKE)\\b/] > MemberExpression",
          message:
            "Interpolating a member access into a SQL template literal. Use a `?` placeholder for values, or escapeId/qualifiedTable for identifiers. See CONVENTIONS.md §6.",
        },
      ],

      // Async hygiene: missing await is almost always a bug
      "require-await": "off", // disabled in favor of the TS-aware version
      "@typescript-eslint/require-await": "off",
      "no-async-promise-executor": "error",
    },
  },
  // log.ts IS the logger — console.error is the implementation, not a
  // violation. The rule's job is to keep console.* out of *callers* of
  // log().
  {
    files: ["src/log.ts"],
    rules: {
      "no-console": "off",
    },
  },
  // CLI prints to stdout/stderr directly; that's its job.
  {
    files: ["src/server/cli.ts"],
    rules: {
      "no-console": "off",
    },
  },
  // Tests use vitest + may legitimately use `any`/non-null assertions
  // for fixture construction, and exercise dynamic KILL via direct
  // queries against the testcontainer.
  {
    files: ["src/__tests__/**/*.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "no-console": "off",
      "no-restricted-syntax": "off",
    },
  },
  // Disables any ESLint rules that conflict with Prettier's output.
  // Must come LAST so it overrides the rules above. Avoids the
  // "ESLint says one thing, Prettier says another" infinite-fix loop
  // when the editor runs both on save.
  prettierConfig,
);
