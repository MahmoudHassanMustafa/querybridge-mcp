// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

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
    rules: {
      // Project conventions: stderr-only logging, MCP transport on stdout
      "no-console": ["error", { allow: ["error"] }],

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

      // Forbid string-interpolating user values into KILL/EXPLAIN/USE-style
      // dynamic statements. The legitimate sites use Number.isInteger guards
      // (kill_query) or escapeId (USE statements). Any new dynamic SQL needs
      // a reviewer-justified eslint-disable.
      "no-restricted-syntax": [
        "warn",
        {
          selector:
            "TemplateLiteral[quasis.0.value.cooked=/\\bKILL\\s+/i][expressions.length>0]",
          message:
            "Dynamic KILL: ensure the value is a verified positive integer (Number.isInteger), then justify with eslint-disable.",
        },
      ],

      // Async hygiene: missing await is almost always a bug
      "require-await": "off", // disabled in favor of the TS-aware version
      "@typescript-eslint/require-await": "off",
      "no-async-promise-executor": "error",
    },
  },
  // CLI exits via console.log; allow it there.
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
);
