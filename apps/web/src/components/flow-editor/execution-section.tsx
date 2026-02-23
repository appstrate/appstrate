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
    <div className="editor-section">
      <div className="editor-section-header">{t("editor.execution")}</div>
      <div className="editor-section-body">
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
