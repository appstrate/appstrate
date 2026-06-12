// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  envDir: "../../",
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    // Default is 500 kB. Justified override: the self-hosted monaco-editor
    // chunk (FIX: no CDN for air-gapped installs) is ~3.6 MB minified — it is
    // lazy-loaded behind components/monaco and never on the critical path, so
    // its size is accepted. Every other chunk sits well below 600 kB; revisit
    // if the build starts warning again.
    chunkSizeWarningLimit: 3700,
    rollupOptions: {
      output: {
        // Stable vendor groups (rolldown `advancedChunks` — Vite 8 bundles
        // rolldown; the rollup `manualChunks` compat shim mis-places shared
        // runtime helpers, which dragged the lazy monaco chunk into the entry
        // graph). Framework code changes far less often than app code, so
        // pinning it to dedicated chunks maximises long-term caching across
        // deploys (route chunks change, vendor chunk hashes don't).
        //
        // Deliberately NOT grouped (verified against the emitted graph):
        // - monaco-editor: only reachable through the lazy components/monaco
        //   facade — natural chunking already isolates it in one async chunk.
        // - @rjsf/*: only reachable through LazySchemaForm, so it gets its own
        //   async chunk naturally. An explicit group would also capture its
        //   ajv dependency — which IS needed eagerly by @appstrate/core via
        //   @afps-spec/schema — and would drag the whole RJSF chunk into the
        //   entry graph.
        advancedChunks: {
          groups: [
            {
              name: "react-vendor",
              test: /node_modules\/(react|react-dom|react-router|react-router-dom|scheduler)\//,
            },
            { name: "query", test: /node_modules\/@tanstack\// },
            { name: "radix", test: /node_modules\/@radix-ui\// },
          ],
        },
      },
    },
  },
});
