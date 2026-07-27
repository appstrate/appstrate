// SPDX-License-Identifier: Apache-2.0

/**
 * Self-hosted Monaco wiring (no CDN).
 *
 * By default `@monaco-editor/react` fetches Monaco from cdn.jsdelivr.net at
 * runtime, which breaks air-gapped self-hosting. This module bundles
 * `monaco-editor` locally and hands the instance to the loader, and wires the
 * web workers through Vite's `?worker` imports so everything is served from
 * our own origin.
 *
 * IMPORTANT: this module must only ever be imported dynamically (see
 * `./index.tsx`) so the ~3 MB Monaco payload stays in its own lazy chunk and
 * never lands in the entry bundle.
 */
import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
// The worker specifiers below look truncated next to the `monaco-editor/esm/vs/…`
// form every Monaco tutorial shows — they are not. Since 0.56 the package's
// `exports` map is `"./*": "./esm/vs/*.js"`, so it prefixes `esm/vs/` itself and
// spelling it out resolves to `esm/vs/esm/vs/…` and fails the build. The bare
// `monaco-editor` import above stays the documented full-feature entry point.
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker";

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    if (label === "json") return new JsonWorker();
    if (label === "typescript" || label === "javascript") return new TsWorker();
    return new EditorWorker();
  },
};

loader.config({ monaco });

export { default as Editor, DiffEditor } from "@monaco-editor/react";
