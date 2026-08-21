// SPDX-License-Identifier: Apache-2.0

import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import {
  I18N_BOOT_NAMESPACES,
  I18N_FALLBACK_LANGUAGE,
  I18N_LANGUAGE_STORAGE_KEY,
} from "./src/i18n-config.ts";

/** `…/src/locales/<language>/<namespace>.json` */
const LOCALE_MODULE_RE = /[/\\]src[/\\]locales[/\\]([^/\\]+)[/\\]([^/\\]+)\.json$/;

/**
 * Emit `modulepreload` hints for the boot locale chunks.
 *
 * i18next fetches them through a dynamic import (`i18n.ts` →
 * `resourcesToBackend`), so the browser only discovers those URLs once the
 * whole entry graph has downloaded AND executed — a fully serialized
 * round-trip in front of the first render. Vite's own preload injection is
 * driven by the static import graph and therefore never sees them.
 *
 * This walks the emitted bundle for locale modules, groups their chunk URLs
 * by language, and injects a small inline script that appends the hints for
 * the language the visitor actually has. It runs while the head is still
 * parsing, so the locale chunks download alongside the entry chunk instead of
 * after it. Language resolution mirrors `i18n.ts`: the `i18nextLng`
 * localStorage key, falling back to `fr`. An unknown language, a blocked
 * localStorage, or a missing map entry simply skips the hint — the runtime
 * import still works, it is just not preloaded.
 */
function i18nBootPreload(): Plugin {
  let base = "/";
  const bootNamespaces = new Set<string>(I18N_BOOT_NAMESPACES);
  return {
    name: "appstrate:i18n-boot-preload",
    apply: "build",
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      order: "post",
      handler(_html, ctx) {
        if (!ctx.bundle) return;

        const byLanguage: Record<string, string[]> = {};
        for (const output of Object.values(ctx.bundle)) {
          if (output.type !== "chunk") continue;
          const moduleIds: string[] = output.moduleIds ?? Object.keys(output.modules ?? {});
          for (const moduleId of moduleIds) {
            const match = LOCALE_MODULE_RE.exec(moduleId);
            if (!match) continue;
            const [, language, namespace] = match;
            if (!bootNamespaces.has(namespace)) continue;
            (byLanguage[language] ??= []).push(`${base}${output.fileName}`);
            break;
          }
        }
        if (Object.keys(byLanguage).length === 0) return;

        // `</` is escaped so a filename can never close the script element.
        const map = JSON.stringify(byLanguage).replace(/</g, "\\u003c");
        const fallback = JSON.stringify(I18N_FALLBACK_LANGUAGE);
        const storageKey = JSON.stringify(I18N_LANGUAGE_STORAGE_KEY);
        return [
          {
            tag: "script",
            injectTo: "head",
            children: `(function(){var m=${map},f=${fallback},l=f;try{var s=localStorage.getItem(${storageKey});if(s)l=s.split("-")[0]}catch(e){}var u=m[l]||m[f];if(!u)return;for(var i=0;i<u.length;i++){var k=document.createElement("link");k.rel="modulepreload";k.crossOrigin="anonymous";k.href=u[i];document.head.appendChild(k)}})();`,
          },
        ];
      },
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), i18nBootPreload()],
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
        // `codeSplitting`, NOT `advancedChunks`: rolldown (bundled by Vite 8)
        // deprecated the latter in 1.1 — "if `advancedChunks` and
        // `codeSplitting` are both specified, `advancedChunks` will be ignored".
        // Same option shape, so this is a rename plus the tightening below.
        codeSplitting: {
          // Without a floor, a group's `test` promotes even a two-line shared
          // module into a chunk of its own, and the entry graph pays a request
          // for each. Anything under 20 kB is cheaper inlined into its importer.
          minSize: 20_000,
          groups: [
            {
              name: "react-vendor",
              test: /node_modules\/(react|react-dom|react-router|react-router-dom|scheduler)\//,
            },
            // Query, narrowed from all of `@tanstack/*`: the entry graph needs
            // the query client, while `@tanstack/react-virtual` is reached from
            // lazy routes only and was being dragged forward by the wider test.
            { name: "query", test: /node_modules\/@tanstack\/(query-core|react-query)\// },
            // Icons are imported by nearly every route; one shared chunk beats
            // the same icon module being duplicated across route chunks.
            { name: "icons", test: /node_modules\/lucide-react\// },
            // Deliberately NO `@radix-ui` group: the primitives are imported
            // per-component, so natural chunking already places each one with
            // the route that uses it. Forcing them together built one large
            // chunk that every route had to fetch to render any dialog.
          ],
        },
      },
    },
  },
});
