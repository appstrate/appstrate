// SPDX-License-Identifier: Apache-2.0

import { lazy, Suspense } from "react";
import type { EditorProps, DiffEditorProps } from "@monaco-editor/react";
import { Spinner } from "@appstrate/ui/components/spinner";
import { useTheme } from "../../stores/theme-store";

/**
 * Lazy facade over the self-hosted Monaco setup (`./setup.ts`).
 *
 * Every editor surface goes through `CodeEditor` / `CodeDiff`: the first render triggers a dynamic
 * import of the setup module, which configures `@monaco-editor/react` with the locally bundled
 * `monaco-editor` + Vite workers, so Monaco lives in its own async chunk fetched only when an
 * editor actually mounts. They also own the theme and the options every pane shares.
 */
const EditorImpl = lazy(() => import("./setup").then((m) => ({ default: m.Editor })));
const DiffEditorImpl = lazy(() => import("./setup").then((m) => ({ default: m.DiffEditor })));

const BASE_OPTIONS = {
  minimap: { enabled: false },
  fontSize: 13,
  fontFamily: "'SF Mono', 'Fira Code', monospace",
  scrollBeyondLastLine: false,
} satisfies NonNullable<EditorProps["options"]>;

function useMonacoTheme() {
  return useTheme().resolvedTheme === "dark" ? "vs-dark" : "vs";
}

function EditorFallback({ height }: { height?: string | number }) {
  return (
    <div className="flex items-center justify-center" style={{ height: height ?? "300px" }}>
      <Spinner />
    </div>
  );
}

export function CodeEditor({ options, ...props }: Omit<EditorProps, "theme">) {
  const theme = useMonacoTheme();
  return (
    <Suspense fallback={<EditorFallback height={props.height} />}>
      <EditorImpl theme={theme} options={{ ...BASE_OPTIONS, ...options }} {...props} />
    </Suspense>
  );
}

/** Read-only side-by-side diff. */
export function CodeDiff({ options, ...props }: Omit<DiffEditorProps, "theme">) {
  const theme = useMonacoTheme();
  return (
    <Suspense fallback={<EditorFallback height={props.height} />}>
      <DiffEditorImpl
        theme={theme}
        // The wrapper would dispose the models before the widget lets go of
        // them ("TextModel got disposed…"); they are disposed once it has.
        keepCurrentOriginalModel
        keepCurrentModifiedModel
        onMount={(diff) => {
          const models = diff.getModel();
          diff.onDidDispose(() =>
            setTimeout(() => {
              models?.original.dispose();
              models?.modified.dispose();
            }),
          );
        }}
        options={{ ...BASE_OPTIONS, readOnly: true, ...options }}
        {...props}
      />
    </Suspense>
  );
}
