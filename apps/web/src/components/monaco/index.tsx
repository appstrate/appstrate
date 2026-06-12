// SPDX-License-Identifier: Apache-2.0

import { lazy, Suspense } from "react";
import type { EditorProps, DiffEditorProps } from "@monaco-editor/react";
import { Spinner } from "../spinner";

/**
 * Lazy facade over the self-hosted Monaco setup (`./setup.ts`).
 *
 * All editor surfaces (json-editor, content-editor, draft-diff-view) go
 * through these wrappers: the first render triggers a dynamic import of the
 * setup module, which configures `@monaco-editor/react` with the locally
 * bundled `monaco-editor` + Vite workers. Monaco therefore lives in its own
 * async chunk, fetched only when an editor actually mounts.
 */
const EditorImpl = lazy(() => import("./setup").then((m) => ({ default: m.Editor })));
const DiffEditorImpl = lazy(() => import("./setup").then((m) => ({ default: m.DiffEditor })));

function EditorFallback({ height }: { height?: string | number }) {
  return (
    <div className="flex items-center justify-center" style={{ height: height ?? "300px" }}>
      <Spinner />
    </div>
  );
}

export function MonacoEditor(props: EditorProps) {
  return (
    <Suspense fallback={<EditorFallback height={props.height} />}>
      <EditorImpl {...props} />
    </Suspense>
  );
}

export function MonacoDiffEditor(props: DiffEditorProps) {
  return (
    <Suspense fallback={<EditorFallback height={props.height} />}>
      <DiffEditorImpl {...props} />
    </Suspense>
  );
}
