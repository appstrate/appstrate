import { useTranslation } from "react-i18next";
import { FormField } from "../form-field";

export interface ExecutionSettings {
  timeout: number;
  logs: boolean;
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
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-foreground">{t("editor.execLogs")}</p>
            <p className="text-xs text-muted-foreground">{t("editor.execLogsDesc")}</p>
          </div>
          <input
            id="exec-logs"
            type="checkbox"
            checked={value.logs}
            onChange={(e) => update({ logs: e.target.checked })}
          />
        </div>
      </div>
    </div>
  );
}
