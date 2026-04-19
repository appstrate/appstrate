// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Vite preset for consumers of `@appstrate/ui/schema-form`.
 *
 * The schema-form widget pulls a CJS-heavy graph (RJSF → ajv → fast-uri,
 * jsonpointer, …). Vite's auto-discovery doesn't follow every subpath
 * import (notably `ajv/dist/2020.js`), so we list the entry points
 * explicitly here. Bundling this knowledge into the package keeps
 * consumers from having to maintain it themselves.
 *
 * Shipped as `.js` (not `.ts`) so Node — which loads Vite configs —
 * can require this file directly from `node_modules` without TypeScript
 * stripping (unsupported under `node_modules`).
 *
 * Usage:
 *
 *   import { defineConfig, mergeConfig } from "vite";
 *   import { viteConfig as appstrateUi } from "@appstrate/ui/vite";
 *
 *   export default mergeConfig(
 *     appstrateUi,
 *     defineConfig({
 *       // your app config
 *     }),
 *   );
 *
 * @type {import("vite").UserConfig}
 */
export const viteConfig = {
  optimizeDeps: {
    include: [
      "@appstrate/core/form",
      "@appstrate/core/ajv",
      "@appstrate/ui/schema-form",
      "@rjsf/core",
      "@rjsf/utils",
      "@rjsf/validator-ajv8",
      "ajv/dist/2020.js",
      "ajv-formats",
      "fast-uri",
      "jsonpointer",
      "react-select",
      "lucide-react",
    ],
  },
};
