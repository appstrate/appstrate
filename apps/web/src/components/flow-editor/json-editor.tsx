import { useState, useMemo } from "react";
import Editor from "@monaco-editor/react";
import type { FlowFormState } from "./types";
import { assemblePayload, payloadToFormState } from "./utils";

interface JsonEditorProps {
  form: FlowFormState;
  userEmail: string;
  onApply: (newState: FlowFormState) => void;
}

export function JsonEditor({ form, userEmail, onApply }: JsonEditorProps) {
  const initialJson = useMemo(
    () => JSON.stringify(assemblePayload(form, userEmail), null, 2),
    // Only compute once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const [jsonValue, setJsonValue] = useState(initialJson);
  const [parseError, setParseError] = useState<string | null>(null);

  const handleApply = () => {
    try {
      const parsed = JSON.parse(jsonValue);
      if (!parsed.manifest || typeof parsed.prompt !== "string") {
        setParseError('Le JSON doit contenir "manifest" (objet) et "prompt" (string).');
        return;
      }
      const newState = payloadToFormState({
        manifest: parsed.manifest,
        prompt: parsed.prompt,
        skills: Array.isArray(parsed.skills) ? parsed.skills : [],
      });
      setParseError(null);
      onApply(newState);
    } catch {
      setParseError("JSON invalide : verifiez la syntaxe.");
    }
  };

  return (
    <div className="json-editor-wrapper">
      <Editor
        height="600px"
        language="json"
        theme="vs-dark"
        value={jsonValue}
        onChange={(v) => {
          setJsonValue(v ?? "");
          setParseError(null);
        }}
        options={{
          minimap: { enabled: false },
          fontSize: 13,
          fontFamily: "'SF Mono', 'Fira Code', monospace",
          scrollBeyondLastLine: false,
          padding: { top: 12, bottom: 12 },
          tabSize: 2,
          formatOnPaste: true,
        }}
      />
      {parseError && <div className="json-editor-error">{parseError}</div>}
      <div className="json-editor-actions">
        <button type="button" className="primary" onClick={handleApply}>
          Appliquer au formulaire
        </button>
      </div>
    </div>
  );
}
