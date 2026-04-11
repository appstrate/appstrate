// SPDX-License-Identifier: Apache-2.0

import { useState, useCallback, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import Editor from "@monaco-editor/react";
import { useTheme } from "../stores/theme-store";
import { cn } from "@/lib/utils";
import { Label } from "@/components/ui/label";

interface JsonFieldEditorProps {
  id: string;
  label: string;
  required?: boolean;
  value: string;
  onChange: (value: string) => void;
  description?: string;
  error?: string;
}

export function JsonFieldEditor({
  id,
  label,
  required,
  value,
  onChange,
  description,
  error,
}: JsonFieldEditorProps) {
  const { t } = useTranslation("common");
  const { resolvedTheme } = useTheme();
  const [parseError, setParseError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Cleanup debounce timer on unmount
  useEffect(() => () => clearTimeout(debounceRef.current), []);

  const handleChange = useCallback(
    (v: string | undefined) => {
      const text = v ?? "";
      onChange(text);
      // Debounce JSON validation to avoid flashing errors while typing
      clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        if (!text.trim()) {
          setParseError(null);
          return;
        }
        try {
          JSON.parse(text);
          setParseError(null);
        } catch {
          setParseError(t("invalidJson"));
        }
      }, 500);
    },
    [onChange, t],
  );

  const hintId = description ? `hint-${id}` : undefined;
  const errorId = error || parseError ? `error-${id}` : undefined;

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>
        {label}
        {required ? " *" : ""}
      </Label>
      <div
        className={cn(
          "border-input overflow-hidden rounded-md border",
          (error || parseError) && "border-destructive",
        )}
      >
        <Editor
          height="160px"
          language="json"
          theme={resolvedTheme === "dark" ? "vs-dark" : "vs"}
          value={value}
          onChange={handleChange}
          options={{
            minimap: { enabled: false },
            fontSize: 12,
            fontFamily: "'SF Mono', 'Fira Code', monospace",
            scrollBeyondLastLine: false,
            padding: { top: 8, bottom: 8 },
            tabSize: 2,
            lineNumbers: "off",
            glyphMargin: false,
            folding: false,
            lineDecorationsWidth: 8,
            lineNumbersMinChars: 0,
            renderLineHighlight: "none",
            overviewRulerLanes: 0,
            hideCursorInOverviewRuler: true,
            overviewRulerBorder: false,
            scrollbar: {
              vertical: "auto",
              horizontal: "auto",
              verticalScrollbarSize: 6,
              horizontalScrollbarSize: 6,
            },
            formatOnPaste: true,
            automaticLayout: true,
          }}
        />
      </div>
      {description && (
        <p id={hintId} className="text-muted-foreground text-sm">
          {description}
        </p>
      )}
      {(error || parseError) && (
        <p id={errorId} className="text-destructive text-sm">
          {error || parseError}
        </p>
      )}
    </div>
  );
}
