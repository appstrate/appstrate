import { useTranslation } from "react-i18next";
import { FormField } from "../form-field";

export interface ExecutionSettings {
  timeout: number;
  outputRetries: number;
}

interface ExecutionSectionProps {
  value: ExecutionSettings;
  onChange: (value: ExecutionSettings) => void;
}

export function ExecutionSection({ value, onChange }: ExecutionSectionProps) {
  const { t } = useTranslation(["flows", "common"]);
  const update = (patch: Partial<ExecutionSettings>) => onChange({ ...value, ...patch });

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card mb-4">
      <div className="bg-background px-4 py-3 text-xs font-semibold uppercase tracking-wide text-foreground border-b border-border">
        {t("editor.execution")}
      </div>
      <div className="space-y-3 p-4">
        <FormField
          id="exec-timeout"
          label={t("editor.execTimeout")}
          type="number"
          value={String(value.timeout)}
          onChange={(v) => update({ timeout: parseInt(v) || 300 })}
          description={t("editor.execTimeoutDesc")}
        />
        <FormField
          id="exec-outputRetries"
          label={t("editor.execRetries")}
          type="number"
          value={String(value.outputRetries)}
          onChange={(v) => update({ outputRetries: Math.min(5, Math.max(0, parseInt(v) || 0)) })}
          description={t("editor.execRetriesDesc")}
        />
      </div>
    </div>
  );
}
