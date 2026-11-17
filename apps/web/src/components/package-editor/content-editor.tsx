// SPDX-License-Identifier: Apache-2.0

/**
 * A Monaco pane the author types into. The editor owns its text from mount: `value` only seeds it,
 * because `@monaco-editor/react` applies a controlled `value` in a post-commit effect that, under
 * React batching, rewrites the model to an older string with `onChange` suppressed — fast typing
 * silently drops characters. Text the author did not type must arrive as a REMOUNT (`key`).
 */

import { useCallback } from "react";
import type { OnMount } from "@monaco-editor/react";
import { CodeEditor } from "../monaco";

interface ContentEditorProps {
  /** The text the editor mounts with. Remount it (`key`) to show another. */
  value: string;
  onChange: (value: string) => void;
  /** Monaco language id — `languageForPath` for a file, a literal for a fixed one. */
  language: string;
  height?: string;
}

export function ContentEditor({ value, onChange, language, height = "500px" }: ContentEditorProps) {
  const handleMount: OnMount = useCallback((editor) => {
    editor.focus();
  }, []);

  return (
    <div className="border-border my-4 overflow-hidden rounded-lg border">
      <CodeEditor
        height={height}
        language={language}
        defaultValue={value}
        onChange={(v) => onChange(v ?? "")}
        onMount={handleMount}
        options={{
          wordWrap: language === "markdown" ? "on" : "off",
          lineNumbers: "on",
          padding: { top: 12, bottom: 12 },
          renderWhitespace: "none",
          tabSize: 2,
        }}
      />
    </div>
  );
}
