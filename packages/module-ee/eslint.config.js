import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  // `.oss-image` is the OSS image's /app tree, extracted so `@appstrate/core`
  // resolves with bun's store intact (see the `test` job in check.yml). ESLint
  // lints nothing in it either way — `files` below is scoped to src/, drizzle/
  // and scripts/ — but without this it still WALKS 613 MB, taking `eslint .`
  // from 0.8s to 10.5s. Prettier needs no equivalent: it honours .gitignore by
  // default.
  { ignores: ["dist", "node_modules", ".oss-image", "drizzle/migrations"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["src/**/*.ts", "drizzle/**/*.ts", "scripts/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.node,
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  eslintConfigPrettier,
);
