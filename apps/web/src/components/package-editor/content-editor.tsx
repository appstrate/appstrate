import { useCallback } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";

interface ContentEditorProps {
  value: string;
  onChange: (value: string) => void;
  language: "markdown" | "typescript";
  height?: string;
}

export function ContentEditor({ value, onChange, language, height = "500px" }: ContentEditorProps) {
  const handleMount: OnMount = useCallback((editor) => {
    editor.focus();
  }, []);

  return (
    <div className="prompt-editor-wrapper">
      <Editor
        height={height}
        language={language}
        theme="vs-dark"
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
