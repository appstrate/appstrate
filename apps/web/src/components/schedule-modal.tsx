import { useState, type ReactNode } from "react";
import { Modal } from "./modal";
import { FormField } from "./form-field";
import type { FlowInputField, Schedule } from "@appstrate/shared-types";

const CRON_PRESETS = [
  { label: "Toutes les 30 min", cron: "*/30 * * * *" },
  { label: "Toutes les heures", cron: "0 * * * *" },
  { label: "Tous les jours a 9h", cron: "0 9 * * *" },
  { label: "Lundi-Vendredi 9h", cron: "0 9 * * 1-5" },
  { label: "Tous les lundis 9h", cron: "0 9 * * 1" },
] as const;

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
  inputSchema?: Record<string, FlowInputField>;
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
  const isEdit = !!schedule;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? "Modifier la planification" : "Nouvelle planification"}
      actions={null}
    >
      {open && (
        <>
          {flowPicker}
          <ScheduleForm
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
  inputSchema?: Record<string, FlowInputField>;
  onClose: () => void;
  onSave: (data: ScheduleSaveData) => void;
  onDelete?: () => void;
  isPending?: boolean;
}) {
  const [name, setName] = useState(schedule?.name ?? "");
  const [cronExpression, setCronExpression] = useState(schedule?.cron_expression ?? "0 9 * * *");
  const [timezone, setTimezone] = useState(schedule?.timezone ?? "UTC");
  const [enabled, setEnabled] = useState(schedule?.enabled ?? true);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const schema = inputSchema || {};
  const hasInputSchema = Object.keys(schema).length > 0;

  const [inputValues, setInputValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    const existingInput = schedule?.input ?? {};
    for (const [key, field] of Object.entries(schema)) {
      initial[key] = String(existingInput[key] ?? field.default ?? "");
    }
    return initial;
  });

  const handleSubmit = () => {
    if (!cronExpression.trim()) {
      alert("L'expression cron est requise");
      return;
    }

    let input: Record<string, unknown> | undefined;
    if (hasInputSchema) {
      input = {};
      for (const [key, field] of Object.entries(schema)) {
        let value: unknown = inputValues[key];
        if (field.type === "number" && value) value = Number(value);
        input[key] = value || null;
      }
    }

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
        <label htmlFor="sched-name">Nom (optionnel)</label>
        <input
          id="sched-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Ex: Execution quotidienne"
        />
      </div>

      <div className="form-group">
        <label>Frequence</label>
        <div className="cron-presets">
          {CRON_PRESETS.map((p) => (
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
        <label htmlFor="sched-cron">Expression cron</label>
        <input
          id="sched-cron"
          type="text"
          value={cronExpression}
          onChange={(e) => setCronExpression(e.target.value)}
          placeholder="*/30 * * * *"
        />
        <div className="hint">Format: minute heure jour mois jour-semaine</div>
      </div>

      <div className="form-group">
        <label htmlFor="sched-tz">Fuseau horaire</label>
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
            Active
          </label>
        </div>
      )}

      {hasInputSchema && (
        <>
          <div className="schedule-input-title">Parametres d'entree</div>
          {Object.entries(schema).map(([key, field]) => (
            <FormField
              key={key}
              id={`sched-input-${key}`}
              label={key}
              required={field.required}
              type={field.type === "number" ? "number" : "text"}
              value={inputValues[key] || ""}
              onChange={(v) => setInputValues((prev) => ({ ...prev, [key]: v }))}
              placeholder={field.placeholder || field.description}
              description={field.description}
            />
          ))}
        </>
      )}

      <div className="modal-actions">
        {schedule && onDelete && (
          <div className="modal-actions-left">
            {confirmDelete ? (
              <>
                <button className="btn-danger" onClick={onDelete}>
                  Confirmer
                </button>
                <button onClick={() => setConfirmDelete(false)}>Annuler</button>
              </>
            ) : (
              <button className="btn-danger" onClick={() => setConfirmDelete(true)}>
                Supprimer
              </button>
            )}
          </div>
        )}
        <button onClick={onClose}>Annuler</button>
        <button className="primary" onClick={handleSubmit} disabled={isPending}>
          {schedule ? "Enregistrer" : "Creer"}
        </button>
      </div>
    </>
  );
}
