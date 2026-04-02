// SPDX-License-Identifier: Apache-2.0

import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import Editor from "@monaco-editor/react";
import { useTheme } from "../stores/theme-store";

interface JsonEditorProps {
  value: Record<string, unknown>;
  onApply: (parsed: Record<string, unknown>) => void;
  schema?: { uri: string; schema: object };
}

export function JsonEditor({ value, onApply, schema }: JsonEditorProps) {
  const { t } = useTranslation(["agents", "common"]);
  const { resolvedTheme } = useTheme();

  const initialJson = useMemo(() => {
    return JSON.stringify(value, null, 2);
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
      setParseError(null);
      onApply(parsed);
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
                uri: schema?.uri ?? "https://afps.appstrate.dev/schema/v1/any.schema.json",
                fileMatch: ["*"],
                schema: schema?.schema ?? {},
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
        <div className="text-destructive bg-destructive/10 border-destructive/30 rounded-md border px-3 py-2 text-sm">
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
