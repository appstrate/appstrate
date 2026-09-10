// SPDX-License-Identifier: Apache-2.0

/**
 * A Monaco pane the author types into.
 *
 * **The editor owns its text from the moment it mounts.** `value` seeds it and
 * is never pushed again, because `@monaco-editor/react` implements a controlled
 * `value` as an effect that runs after the commit — `if (value !== undefined &&
 * value !== editor.getValue()) editor.executeEdits(…, fullModelRange, value)` —
 * and React batches. Two keys pressed inside one batch reach Monaco before the
 * render carrying the first one lands, so that effect rewrites the model back
 * to the older string and the second character is gone; the rewrite is made
 * with `onChange` suppressed, so nothing upstream ever learns of it. Fast
 * typing on a loaded machine therefore drops characters, silently.
 *
 * `onChange` still fires on every keystroke, so the caller's copy stays exact.
 * What the caller loses is the ability to push text back in mid-edit — which is
 * the point: text the author did not type arrives as a REMOUNT, keyed by the
 * caller on whatever made it change.
 */

import { useCallback } from "react";
import type { OnMount } from "@monaco-editor/react";
import { MonacoEditor as Editor } from "../monaco";
import { useTheme } from "../../stores/theme-store";

interface ContentEditorProps {
  /** The text the editor mounts with. Remount it (`key`) to show another. */
  value: string;
  onChange: (value: string) => void;
  /** Monaco language id — `languageForPath` for a file, a literal for a fixed one. */
  language: string;
  height?: string;
}

export function ContentEditor({ value, onChange, language, height = "500px" }: ContentEditorProps) {
  const { resolvedTheme } = useTheme();
  const handleMount: OnMount = useCallback((editor) => {
    editor.focus();
  }, []);

  return (
    <div className="border-border my-4 overflow-hidden rounded-lg border">
      <Editor
        height={height}
        language={language}
        theme={resolvedTheme === "dark" ? "vs-dark" : "vs"}
        defaultValue={value}
        onChange={(v) => onChange(v ?? "")}
        onMount={handleMount}
        options={{
          minimap: { enabled: false },
          wordWrap: language === "markdown" ? "on" : "off",
          fontSize: 13,
          fontFamily: "'SF Mono', 'Fira Code', monospace",
          lineNumbers: "on",
          scrollBeyondLastLine: false,
          padding: { top: 12, bottom: 12 },
          renderWhitespace: "none",
          tabSize: 2,
        }}
      />
    </div>
  );
}
