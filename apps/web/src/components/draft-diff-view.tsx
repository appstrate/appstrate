// SPDX-License-Identifier: Apache-2.0

import { MonacoDiffEditor as DiffEditor } from "./monaco";
import { useTheme } from "../stores/theme-store";

interface DraftDiffViewProps {
  original: string;
  modified: string;
  language?: string;
  originalLabel?: string;
  modifiedLabel?: string;
}

export function DraftDiffView({
  original,
  modified,
  language = "plaintext",
  originalLabel,
  modifiedLabel,
}: DraftDiffViewProps) {
  const { resolvedTheme } = useTheme();
  return (
    <div>
      {(originalLabel || modifiedLabel) && (
        <div className="border-border mb-0 flex border-b">
          <div className="text-muted-foreground flex-1 px-3 py-1.5 text-xs font-medium">
            {originalLabel}
          </div>
          <div className="text-muted-foreground flex-1 px-3 py-1.5 text-xs font-medium">
            {modifiedLabel}
          </div>
        </div>
      )}
      <DiffEditor
        height="400px"
        // Monaco disposes its models on unmount before the widget resets, which
        // logs "TextModel got disposed…" every time the diff closes in a modal.
        // Keeping the models hands that cleanup back to monaco itself.
        keepCurrentOriginalModel
        keepCurrentModifiedModel
        theme={resolvedTheme === "dark" ? "vs-dark" : "vs"}
        language={language}
        original={original}
        modified={modified}
        options={{
          readOnly: true,
          minimap: { enabled: false },
          fontSize: 13,
          fontFamily: "'SF Mono', 'Fira Code', monospace",
          renderSideBySide: true,
          scrollBeyondLastLine: false,
        }}
      />
    </div>
  );
}
