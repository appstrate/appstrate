interface PromptSectionProps {
  value: string;
  onChange: (value: string) => void;
}

export function PromptSection({ value, onChange }: PromptSectionProps) {
  return (
    <div className="editor-section">
      <div className="editor-section-header">Prompt</div>
      <div className="editor-section-body">
        <textarea
          className="prompt-textarea"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Instructions pour l'agent..."
        />
        <div className="hint">
          Variables disponibles : <code>{"{{config.*}}"}</code>, <code>{"{{state.*}}"}</code>,{" "}
          <code>{"{{input.*}}"}</code>, <code>{"{{#if state.*}}...{{/if}}"}</code>
        </div>
      </div>
    </div>
  );
}
