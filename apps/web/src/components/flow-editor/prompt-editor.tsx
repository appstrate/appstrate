import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import Editor, { type OnMount } from "@monaco-editor/react";

interface PromptEditorProps {
  value: string;
  onChange: (value: string) => void;
}

export function PromptEditor({ value, onChange }: PromptEditorProps) {
  const { t } = useTranslation(["flows", "common"]);
  const handleMount: OnMount = useCallback((editor) => {
    editor.focus();
  }, []);

  return (
    <div className="prompt-editor-wrapper">
      <Editor
        height="500px"
        language="markdown"
        theme="vs-dark"
        value={value}
        onChange={(v) => onChange(v ?? "")}
        onMount={handleMount}
        options={{
          minimap: { enabled: false },
          wordWrap: "on",
          fontSize: 13,
          fontFamily: "'SF Mono', 'Fira Code', monospace",
          lineNumbers: "on",
          scrollBeyondLastLine: false,
          padding: { top: 12, bottom: 12 },
          renderWhitespace: "none",
          tabSize: 2,
        }}
      />
      <div className="hint" style={{ marginTop: "0.5rem" }}>
        {t("editor.promptHint")}
      </div>
    </div>
  );
}
