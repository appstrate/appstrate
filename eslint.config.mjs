import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  { ignores: ["**/dist", "**/node_modules", ".claude/", "apps/web/src/components/ui"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/src/**/*.{ts,tsx}", "**/test/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.node,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "preserve-caught-error": "off",
    },
  },
  {
    files: ["**/test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-extra-non-null-assertion": "warn",
      "@typescript-eslint/no-unused-vars": "warn",
      "prefer-const": "warn",
    },
  },
  {
    files: ["packages/core/src/**/*.ts", "packages/core/test/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@appstrate/db*",
                "@appstrate/env*",
                "@appstrate/connect*",
                "@appstrate/shared-types*",
                "@appstrate/emails*",
                "@appstrate/api*",
                "@appstrate/web*",
              ],
              message:
                "core must remain independent — no imports from other workspace packages",
            },
          ],
        },
      ],
    },
  },
  {
    // Supply-chain guard: the single-vendor Pi SDK
    // (@mariozechner/pi-ai, @mariozechner/pi-coding-agent) may only be
    // imported through each package's `pi-sdk.ts` barrel, so swapping or
    // forking it is a one-file change. Barrels are exempt via `ignores`.
    // Rationale: docs/architecture/SUPPLY_CHAIN.md
    files: [
      "packages/runner-pi/src/**/*.ts",
      "apps/cli/src/**/*.ts",
      "runtime-pi/**/*.ts",
    ],
    ignores: [
      "packages/runner-pi/src/pi-sdk.ts",
      "apps/cli/src/lib/pi-sdk.ts",
      "runtime-pi/pi-sdk.ts",
      "runtime-pi/sidecar/**",
      "runtime-pi/runners/**",
    ],
    languageOptions: {
      parser: tseslint.parser,
    },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@mariozechner/pi-ai", "@mariozechner/pi-ai/*"],
              message:
                "Import the Pi SDK only through the package-local pi-sdk barrel (pi-sdk.ts) — see docs/architecture/SUPPLY_CHAIN.md",
            },
            {
              group: ["@mariozechner/pi-coding-agent", "@mariozechner/pi-coding-agent/*"],
              message:
                "Import the Pi SDK only through the package-local pi-sdk barrel (pi-sdk.ts) — see docs/architecture/SUPPLY_CHAIN.md",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["apps/web/src/**/*.{ts,tsx}", "packages/ui/src/**/*.{ts,tsx}"],
    languageOptions: {
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
    },
  },
  eslintConfigPrettier,
);
