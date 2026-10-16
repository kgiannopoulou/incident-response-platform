// ESLint for the Node workspaces (API, worker, simulator, packages).
// apps/web has its own config (Next.js rules) and is linted from there:
// `npm run lint` runs both.
import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores(["**/node_modules/**", "**/dist/**", "**/coverage/**", "apps/web/**", "**/*.d.ts"]),
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,mts,js,mjs}"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: globals.node,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      // Tests and fixtures cast freely; production code mostly uses zod-parsed types.
      "@typescript-eslint/no-explicit-any": "off",
      // Security-relevant: never build code from strings.
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      eqeqeq: ["error", "smart"],
    },
  },
]);
