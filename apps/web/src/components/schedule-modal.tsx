import { useState, type ReactNode } from "react";
import { useForm, useWatch } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { Modal } from "./modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { InputFields } from "./input-fields";
import {
  initFormValues,
  buildPayload,
  type JSONSchemaObject,
  type SchemaWrapper,
} from "@appstrate/core/form";
import type { Schedule } from "@appstrate/shared-types";

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
  blockedMessage?: string;
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
  blockedMessage,
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
          {blockedMessage ? (
            <>
              <p className="text-sm text-muted-foreground">{blockedMessage}</p>
              <div className="flex justify-end gap-2 mt-4 pt-4 border-t border-border">
                <Button variant="outline" onClick={onClose}>
                  {t("btn.cancel")}
                </Button>
              </div>
            </>
          ) : (
            <ScheduleForm
              key={schemaKeys}
              schedule={schedule}
              inputSchema={inputSchema}
              onClose={onClose}
              onSave={onSave}
              onDelete={onDelete}
              isPending={isPending}
            />
          )}
        </>
      )}
    </Modal>
  );
}

interface ScheduleFormFields {
  name: string;
  cronExpression: string;
  timezone: string;
  enabled: boolean;
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

  const [confirmDelete, setConfirmDelete] = useState(false);

  const schema: JSONSchemaObject = inputSchema || { type: "object" as const, properties: {} };
  const hasInputSchema = Object.keys(schema.properties).length > 0;
  const wrapper: SchemaWrapper = { schema };

  const [inputValues, setInputValues] = useState<Record<string, unknown>>(() =>
    initFormValues(schema, (schedule?.input ?? {}) as Record<string, unknown>),
  );

  const {
    register,
    handleSubmit,
    control,
    setValue,
    clearErrors,
    formState: { errors },
  } = useForm<ScheduleFormFields>({
    defaultValues: {
      name: schedule?.name ?? "",
      cronExpression: schedule?.cronExpression ?? "0 9 * * *",
      timezone: schedule?.timezone ?? "UTC",
      enabled: schedule?.enabled ?? true,
    },
    mode: "onBlur",
  });

  const [cronExpression, timezone, enabled] = useWatch({
    control,
    name: ["cronExpression", "timezone", "enabled"],
  });

  const onFormSubmit = handleSubmit((data) => {
    const input = hasInputSchema ? buildPayload(schema, inputValues) : undefined;

    onSave({
      name: data.name || undefined,
      cronExpression: data.cronExpression,
      timezone: data.timezone,
      input,
      ...(schedule ? { enabled: data.enabled } : {}),
    });
    onClose();
  });

  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="sched-name">{t("schedule.name")}</Label>
        <Input
          id="sched-name"
          type="text"
          {...register("name")}
          placeholder={t("schedule.namePlaceholder")}
        />
      </div>

      <div className="space-y-2">
        <Label>{t("schedule.frequency")}</Label>
        <div className="flex flex-wrap gap-1 mt-2">
          {cronPresets.map((p) => (
            <Button
              key={p.cron}
              type="button"
              variant="outline"
              size="sm"
              className={cn(
                "text-xs",
                cronExpression === p.cron
                  ? "border-primary bg-primary/10 text-foreground"
                  : "text-muted-foreground",
              )}
              onClick={() => {
                setValue("cronExpression", p.cron);
                clearErrors("cronExpression");
              }}
            >
              {p.label}
            </Button>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="sched-cron">{t("schedule.cronLabel")}</Label>
        <Input
          id="sched-cron"
          type="text"
          {...register("cronExpression", {
            validate: (v) => {
              if (!v.trim()) return t("validation.required", { ns: "common" });
              return undefined;
            },
          })}
          placeholder="*/30 * * * *"
          aria-invalid={errors.cronExpression ? true : undefined}
          className={cn(errors.cronExpression && "border-destructive")}
        />
        <div className="text-sm text-muted-foreground">{t("schedule.cronHint")}</div>
        {errors.cronExpression?.message && (
          <div className="text-sm text-destructive">{errors.cronExpression.message}</div>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="sched-tz">{t("schedule.timezone")}</Label>
        <Select value={timezone} onValueChange={(v) => setValue("timezone", v)}>
          <SelectTrigger id="sched-tz">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TIMEZONES.map((tz) => (
              <SelectItem key={tz} value={tz}>
                {tz}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {schedule && (
        <div className="space-y-2">
          <Label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setValue("enabled", e.target.checked)}
            />
            {t("schedule.enabled")}
          </Label>
        </div>
      )}

      {hasInputSchema && (
        <>
          <div className="text-sm font-medium text-muted-foreground mt-4 mb-2">
            {t("schedule.inputTitle")}
          </div>
          <InputFields
            schema={wrapper}
            values={inputValues}
            onChange={(key, v) => setInputValues((prev) => ({ ...prev, [key]: v }))}
            idPrefix="sched-input"
          />
        </>
      )}

      <div className="flex justify-end gap-2 mt-4 pt-4 border-t border-border">
        {schedule && onDelete && (
          <div className="flex gap-2 mr-auto">
            {confirmDelete ? (
              <>
                <Button variant="destructive" size="sm" onClick={onDelete}>
                  {t("btn.confirm")}
                </Button>
                <Button variant="outline" size="sm" onClick={() => setConfirmDelete(false)}>
                  {t("btn.cancel")}
                </Button>
              </>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive/80"
                onClick={() => setConfirmDelete(true)}
              >
                {t("btn.delete")}
              </Button>
            )}
          </div>
        )}
        <Button variant="outline" onClick={onClose}>
          {t("btn.cancel")}
        </Button>
        <Button onClick={onFormSubmit} disabled={isPending}>
          {schedule ? t("btn.save") : t("btn.create")}
        </Button>
      </div>
    </>
  );
}
