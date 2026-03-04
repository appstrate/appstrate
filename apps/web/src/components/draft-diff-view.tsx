import { DiffEditor } from "@monaco-editor/react";

interface DraftDiffViewProps {
  original: string;
  modified: string;
  language?: string;
}

export function DraftDiffView({ original, modified, language = "plaintext" }: DraftDiffViewProps) {
  return (
    <DiffEditor
      height="400px"
      theme="vs-dark"
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
  );
}
