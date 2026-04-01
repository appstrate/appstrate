import { useCallback } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { useTheme } from "../../stores/theme-store";

interface ContentEditorProps {
  value: string;
  onChange: (value: string) => void;
  language: "markdown" | "typescript";
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
        value={value}
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
