import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "./modal";
import { InputFields } from "./input-fields";
import { initInputValues, buildInputPayload } from "./input-utils";
import type { JSONSchemaObject, Schedule } from "@appstrate/shared-types";

function getCronPresets(t: (key: string) => string) {
  return [
    { label: t("schedule.preset30min"), cron: "*/30 * * * *" },
    { label: t("schedule.presetHourly"), cron: "0 * * * *" },
    { label: t("schedule.presetDaily9"), cron: "0 9 * * *" },
    { label: t("schedule.presetWeekday9"), cron: "0 9 * * 1-5" },
    { label: t("schedule.presetMonday9"), cron: "0 9 * * 1" },
  ];
}

const TIMEZONES = [
  "UTC",
  "Europe/Paris",
  "Europe/London",
  "America/New_York",
  "America/Chicago",
  "America/Los_Angeles",
  "Asia/Tokyo",
] as const;

export interface ScheduleSaveData {
  name?: string;
  cronExpression: string;
  timezone?: string;
  input?: Record<string, unknown>;
  enabled?: boolean;
}

interface ScheduleModalProps {
  open: boolean;
  onClose: () => void;
  schedule?: Schedule | null;
  inputSchema?: JSONSchemaObject;
  onSave: (data: ScheduleSaveData) => void;
  onDelete?: () => void;
  isPending?: boolean;
  flowPicker?: ReactNode;
  children?: ReactNode;
}

export function ScheduleModal({
  open,
  onClose,
  schedule,
  inputSchema,
  onSave,
  onDelete,
  isPending,
  flowPicker,
}: ScheduleModalProps) {
  const { t } = useTranslation(["flows", "common"]);
  const isEdit = !!schedule;
  const schemaKeys = inputSchema?.properties ? Object.keys(inputSchema.properties).join(",") : "";

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? t("schedule.titleEdit") : t("schedule.titleNew")}
      actions={null}
    >
      {open && (
        <>
          {flowPicker}
          <ScheduleForm
            key={schemaKeys}
            schedule={schedule}
            inputSchema={inputSchema}
            onClose={onClose}
            onSave={onSave}
            onDelete={onDelete}
            isPending={isPending}
          />
        </>
      )}
    </Modal>
  );
}

function ScheduleForm({
  schedule,
  inputSchema,
  onClose,
  onSave,
  onDelete,
  isPending,
}: {
  schedule?: Schedule | null;
  inputSchema?: JSONSchemaObject;
  onClose: () => void;
  onSave: (data: ScheduleSaveData) => void;
  onDelete?: () => void;
  isPending?: boolean;
}) {
  const { t } = useTranslation(["flows", "common"]);
  const cronPresets = getCronPresets(t);

  const [name, setName] = useState(schedule?.name ?? "");
  const [cronExpression, setCronExpression] = useState(schedule?.cronExpression ?? "0 9 * * *");
  const [timezone, setTimezone] = useState(schedule?.timezone ?? "UTC");
  const [enabled, setEnabled] = useState(schedule?.enabled ?? true);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const schema = inputSchema || { type: "object" as const, properties: {} };
  const hasInputSchema = Object.keys(schema.properties).length > 0;

  const [inputValues, setInputValues] = useState<Record<string, string>>(() =>
    initInputValues(schema, (schedule?.input ?? {}) as Record<string, unknown>),
  );

  const handleSubmit = () => {
    if (!cronExpression.trim()) {
      alert(t("schedule.cronRequired"));
      return;
    }

    const input = hasInputSchema ? buildInputPayload(schema, inputValues) : undefined;

    onSave({
      name: name || undefined,
      cronExpression,
      timezone,
      input,
      ...(schedule ? { enabled } : {}),
    });
    onClose();
  };

  return (
    <>
      <div className="form-group">
        <label htmlFor="sched-name">{t("schedule.name")}</label>
        <input
          id="sched-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("schedule.namePlaceholder")}
        />
      </div>

      <div className="form-group">
        <label>{t("schedule.frequency")}</label>
        <div className="cron-presets">
          {cronPresets.map((p) => (
            <button
              key={p.cron}
              type="button"
              className={`cron-preset ${cronExpression === p.cron ? "active" : ""}`}
              onClick={() => setCronExpression(p.cron)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="form-group">
        <label htmlFor="sched-cron">{t("schedule.cronLabel")}</label>
        <input
          id="sched-cron"
          type="text"
          value={cronExpression}
          onChange={(e) => setCronExpression(e.target.value)}
          placeholder="*/30 * * * *"
        />
        <div className="hint">{t("schedule.cronHint")}</div>
      </div>

      <div className="form-group">
        <label htmlFor="sched-tz">{t("schedule.timezone")}</label>
        <select id="sched-tz" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
          {TIMEZONES.map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
        </select>
      </div>

      {schedule && (
        <div className="form-group">
          <label className="toggle-label">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            {t("schedule.enabled")}
          </label>
        </div>
      )}

      {hasInputSchema && (
        <>
          <div className="schedule-input-title">{t("schedule.inputTitle")}</div>
          <InputFields
            schema={schema}
            values={inputValues}
            onChange={(key, v) => setInputValues((prev) => ({ ...prev, [key]: v }))}
            idPrefix="sched-input"
          />
        </>
      )}

      <div className="modal-actions">
        {schedule && onDelete && (
          <div className="modal-actions-left">
            {confirmDelete ? (
              <>
                <button className="btn-danger" onClick={onDelete}>
                  {t("btn.confirm")}
                </button>
                <button onClick={() => setConfirmDelete(false)}>{t("btn.cancel")}</button>
              </>
            ) : (
              <button className="btn-danger" onClick={() => setConfirmDelete(true)}>
                {t("btn.delete")}
              </button>
            )}
          </div>
        )}
        <button onClick={onClose}>{t("btn.cancel")}</button>
        <button className="primary" onClick={handleSubmit} disabled={isPending}>
          {schedule ? t("btn.save") : t("btn.create")}
        </button>
      </div>
    </>
  );
}
