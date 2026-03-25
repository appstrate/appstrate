import { DiffEditor } from "@monaco-editor/react";
import { useTheme } from "../stores/theme-store";

interface DraftDiffViewProps {
  original: string;
  modified: string;
  language?: string;
}

export function DraftDiffView({ original, modified, language = "plaintext" }: DraftDiffViewProps) {
  const { resolvedTheme } = useTheme();
  return (
    <DiffEditor
      height="400px"
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
  );
}
