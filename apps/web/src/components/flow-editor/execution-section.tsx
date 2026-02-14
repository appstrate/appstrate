import { FormField } from "../form-field";

export interface ExecutionSettings {
  timeout: number;
  maxTokens: number;
  outputRetries: number;
}

interface ExecutionSectionProps {
  value: ExecutionSettings;
  onChange: (value: ExecutionSettings) => void;
}

export function ExecutionSection({ value, onChange }: ExecutionSectionProps) {
  const update = (patch: Partial<ExecutionSettings>) => onChange({ ...value, ...patch });

  return (
    <div className="editor-section">
      <div className="editor-section-header">Execution</div>
      <div className="editor-section-body">
        <FormField
          id="exec-timeout"
          label="Timeout"
          type="number"
          value={String(value.timeout)}
          onChange={(v) => update({ timeout: parseInt(v) || 300 })}
          description="En secondes (defaut: 300)"
        />
        <FormField
          id="exec-maxTokens"
          label="Max tokens"
          type="number"
          value={String(value.maxTokens)}
          onChange={(v) => update({ maxTokens: parseInt(v) || 8192 })}
          description="Defaut: 8192"
        />
        <FormField
          id="exec-outputRetries"
          label="Retries de validation output"
          type="number"
          value={String(value.outputRetries)}
          onChange={(v) => update({ outputRetries: Math.min(5, Math.max(0, parseInt(v) || 0)) })}
          description="0-5 (defaut: 2)"
        />
      </div>
    </div>
  );
}
