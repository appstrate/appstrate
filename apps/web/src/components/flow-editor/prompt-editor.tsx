import { useRef, useEffect, useCallback } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import type { editor, Position } from "monaco-editor";
import type { SchemaField } from "./schema-section";

interface PromptEditorProps {
  value: string;
  onChange: (value: string) => void;
  configFields: SchemaField[];
  stateFields: SchemaField[];
  inputFields: SchemaField[];
}

export function PromptEditor({
  value,
  onChange,
  configFields,
  stateFields,
  inputFields,
}: PromptEditorProps) {
  const configRef = useRef(configFields);
  const stateRef = useRef(stateFields);
  const inputRef = useRef(inputFields);
  const disposableRef = useRef<{ dispose: () => void } | null>(null);

  useEffect(() => {
    configRef.current = configFields;
  }, [configFields]);
  useEffect(() => {
    stateRef.current = stateFields;
  }, [stateFields]);
  useEffect(() => {
    inputRef.current = inputFields;
  }, [inputFields]);

  useEffect(() => {
    return () => {
      disposableRef.current?.dispose();
    };
  }, []);

  const handleMount: OnMount = useCallback((editor, monaco) => {
    disposableRef.current = monaco.languages.registerCompletionItemProvider("markdown", {
      triggerCharacters: ["{", "."],
      provideCompletionItems: (model: editor.ITextModel, position: Position) => {
        const lineContent = model.getLineContent(position.lineNumber);
        const textBefore = lineContent.substring(0, position.column - 1);

        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: position.column,
          endColumn: position.column,
        };

        // After {{config. → suggest config field keys
        if (/\{\{config\.\s*$/.test(textBefore)) {
          return {
            suggestions: configRef.current
              .filter((f) => f.key)
              .map((f) => ({
                label: f.key,
                kind: monaco.languages.CompletionItemKind.Field,
                insertText: f.key + "}}",
                detail: `config.${f.key} (${f.type})`,
                documentation: f.description,
                range,
              })),
          };
        }

        // After {{state. → suggest state field keys
        if (/\{\{state\.\s*$/.test(textBefore)) {
          return {
            suggestions: stateRef.current
              .filter((f) => f.key)
              .map((f) => ({
                label: f.key,
                kind: monaco.languages.CompletionItemKind.Field,
                insertText: f.key + "}}",
                detail: `state.${f.key} (${f.type})`,
                documentation: f.description || f.format,
                range,
              })),
          };
        }

        // After {{input. → suggest input field keys
        if (/\{\{input\.\s*$/.test(textBefore)) {
          return {
            suggestions: inputRef.current
              .filter((f) => f.key)
              .map((f) => ({
                label: f.key,
                kind: monaco.languages.CompletionItemKind.Field,
                insertText: f.key + "}}",
                detail: `input.${f.key} (${f.type})`,
                documentation: f.description,
                range,
              })),
          };
        }

        // After {{#if state. → suggest state keys with closing block
        if (/\{\{#if state\.\s*$/.test(textBefore)) {
          return {
            suggestions: stateRef.current
              .filter((f) => f.key)
              .map((f) => ({
                label: f.key,
                kind: monaco.languages.CompletionItemKind.Snippet,
                insertText: f.key + "}}$0{{/if}}",
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                detail: `#if state.${f.key}`,
                documentation: "Conditional block",
                range,
              })),
          };
        }

        // After {{ → suggest namespaces
        if (/\{\{\s*$/.test(textBefore)) {
          return {
            suggestions: [
              {
                label: "config.",
                kind: monaco.languages.CompletionItemKind.Module,
                insertText: "config.",
                detail: "Configuration variables",
                range,
              },
              {
                label: "state.",
                kind: monaco.languages.CompletionItemKind.Module,
                insertText: "state.",
                detail: "Persistent state variables",
                range,
              },
              {
                label: "input.",
                kind: monaco.languages.CompletionItemKind.Module,
                insertText: "input.",
                detail: "User input variables",
                range,
              },
              {
                label: "#if state.",
                kind: monaco.languages.CompletionItemKind.Snippet,
                insertText: "#if state.",
                detail: "Conditional block",
                range,
              },
            ],
          };
        }

        return { suggestions: [] };
      },
    });

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
        Variables : <code>{"{{config.*}}"}</code>, <code>{"{{state.*}}"}</code>,{" "}
        <code>{"{{input.*}}"}</code>, <code>{"{{#if state.*}}...{{/if}}"}</code> — Autocompletion
        active
      </div>
    </div>
  );
}
