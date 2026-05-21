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

      // `as` is fine for the mysql2 row → typed-record bridge, but we
      // want it called out at review time
      "@typescript-eslint/no-explicit-any": "warn",

      // Async hygiene: missing await is almost always a bug
      "require-await": "off", // disabled in favor of the TS-aware version
      "@typescript-eslint/require-await": "off",
      "no-async-promise-executor": "error",
    },
  },
  // CLI exits via console.log; allow it there.
  {
    files: ["src/cli.ts"],
    rules: {
      "no-console": "off",
    },
  },
  // Tests use vitest + may legitimately use `any`/non-null assertions
  // for fixture construction.
  {
    files: ["src/__tests__/**/*.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "no-console": "off",
    },
  },
);
