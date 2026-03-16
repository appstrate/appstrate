import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import Editor from "@monaco-editor/react";
import { useTheme } from "../../hooks/use-theme";
import type { FlowFormState } from "./types";
import { assemblePayload, payloadToFormState } from "./utils";
import flowSchema from "./flow-schema.json";

const FLOW_SCHEMA_URI = "https://afps.appstrate.dev/schema/v1/flow.schema.json";

interface JsonEditorProps {
  form: FlowFormState;
  onApply: (newState: FlowFormState) => void;
}

export function JsonEditor({ form, onApply }: JsonEditorProps) {
  const { t } = useTranslation(["flows", "common"]);
  const { resolvedTheme } = useTheme();

  const initialJson = useMemo(() => {
    const { manifest } = assemblePayload(form);
    return JSON.stringify(manifest, null, 2);
    // Only compute once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [jsonValue, setJsonValue] = useState(initialJson);
  const [parseError, setParseError] = useState<string | null>(null);

  const handleApply = () => {
    try {
      const parsed = JSON.parse(jsonValue);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setParseError(t("editor.jsonErrorStructure"));
        return;
      }
      const newState = payloadToFormState({
        manifest: parsed,
        prompt: form.prompt,
      });
      setParseError(null);
      onApply(newState);
    } catch {
      setParseError(t("editor.jsonInvalid"));
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <Editor
        height="600px"
        language="json"
        theme={resolvedTheme === "dark" ? "vs-dark" : "vs"}
        value={jsonValue}
        onChange={(v) => {
          setJsonValue(v ?? "");
          setParseError(null);
        }}
        beforeMount={(monaco) => {
          monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
            enableSchemaRequest: false,
            validate: true,
            schemas: [
              {
                uri: FLOW_SCHEMA_URI,
                fileMatch: ["*"],
                schema: flowSchema,
              },
            ],
          });
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
      {parseError && (
        <div className="text-sm text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">
          {parseError}
        </div>
      )}
      <div className="flex justify-end">
        <Button type="button" onClick={handleApply}>
          {t("editor.jsonApply")}
        </Button>
      </div>
    </div>
  );
}
