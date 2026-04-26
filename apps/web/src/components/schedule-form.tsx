// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useState } from "react";
import { useWatch } from "react-hook-form";
import { useAppForm } from "../hooks/use-app-form";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { ChevronDown } from "lucide-react";
import { SchemaForm } from "@appstrate/ui/schema-form";
import { useSchemaFormLabels } from "../hooks/use-schema-form-labels";
import { uploadClient } from "../api";
import type { JSONSchemaObject, SchemaWrapper } from "@appstrate/core/form";
import { useConnectionProfiles, useAppProfiles } from "../hooks/use-connection-profiles";
import { CombinedProfileSelect, type ForeignProfile } from "./combined-profile-select";
import { RunOverridesPanel, type RunOverridesValue } from "./run-overrides-panel";

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
  connectionProfileId: string;
  name?: string;
  cronExpression: string;
  timezone?: string;
  input?: Record<string, unknown>;
  enabled?: boolean;
  /**
   * Per-schedule override layer. Frozen at create/update; deep-merged with
   * the application's persisted config every time the schedule fires.
   * `null` clears a previously-set override on edit.
   */
  configOverride?: Record<string, unknown> | null;
  modelIdOverride?: string | null;
  proxyIdOverride?: string | null;
  versionOverride?: string | null;
}

interface ScheduleFormProps {
  mode: "create" | "edit";
  defaultValues?: {
    connectionProfileId?: string;
    name?: string;
    cronExpression?: string;
    timezone?: string;
    enabled?: boolean;
    input?: Record<string, unknown>;
    configOverride?: Record<string, unknown> | null;
    modelIdOverride?: string | null;
    proxyIdOverride?: string | null;
    versionOverride?: string | null;
  };
  inputSchema?: JSONSchemaObject;
  /** Agent's config schema — drives the override panel's config form. */
  configSchema?: JSONSchemaObject;
  /** Persisted application config — the merge baseline for the override delta. */
  persistedConfig?: Record<string, unknown>;
  /** Persisted defaults — passed straight through to RunOverridesPanel. */
  persistedModelId?: string | null;
  persistedProxyId?: string | null;
  persistedVersion?: string | null;
  /** Package id needed by RunOverridesPanel to fetch versions. */
  packageId?: string;
  agents?: Array<{ id: string; displayName: string }>;
  selectedAgentId?: string;
  onAgentChange?: (agentId: string) => void;
  onSubmit: (data: ScheduleSaveData) => void;
  onCancel: () => void;
  onDelete?: () => void;
  isPending?: boolean;
  blockedMessage?: string;
  /** Profile owned by another user — shown read-only in the selector */
  foreignProfile?: ForeignProfile;
}

interface FormFields {
  name: string;
  connectionProfileId: string;
  cronExpression: string;
  timezone: string;
  enabled: boolean;
}

export function ScheduleForm({
  mode,
  defaultValues,
  inputSchema,
  configSchema,
  persistedConfig,
  persistedModelId,
  persistedProxyId,
  persistedVersion,
  packageId,
  agents,
  selectedAgentId,
  onAgentChange,
  onSubmit,
  onCancel,
  onDelete,
  isPending,
  blockedMessage,
  foreignProfile,
}: ScheduleFormProps) {
  const { t } = useTranslation(["agents", "common"]);
  const cronPresets = getCronPresets(t);
  const isEdit = mode === "edit";

  const { data: userProfiles } = useConnectionProfiles();
  const { data: appProfiles } = useAppProfiles();
  const allProfiles = useMemo(
    () => [...(userProfiles ?? []), ...(appProfiles ?? [])],
    [userProfiles, appProfiles],
  );

  const [confirmDelete, setConfirmDelete] = useState(false);

  const schema: JSONSchemaObject = inputSchema || { type: "object" as const, properties: {} };
  const hasInputSchema = Object.keys(schema.properties).length > 0;
  const wrapper: SchemaWrapper = { schema };
  const labels = useSchemaFormLabels();

  const [inputValues, setInputValues] = useState<Record<string, unknown>>(
    () => (defaultValues?.input ?? {}) as Record<string, unknown>,
  );

  // Override-layer state — mirrors the Run modal's accordion, except
  // these overrides are persisted on the schedule row and replayed on
  // every fire (vs. the Run modal which only applies them once).
  const [overrides, setOverrides] = useState<RunOverridesValue>(() => {
    const v: RunOverridesValue = {};
    if (defaultValues?.configOverride) v.configOverride = defaultValues.configOverride;
    if (defaultValues?.modelIdOverride) v.modelId = defaultValues.modelIdOverride;
    if (defaultValues?.proxyIdOverride) v.proxyId = defaultValues.proxyIdOverride;
    if (defaultValues?.versionOverride) v.version = defaultValues.versionOverride;
    return v;
  });
  const initialOverridesNonEmpty =
    !!(defaultValues?.configOverride && Object.keys(defaultValues.configOverride).length > 0) ||
    !!defaultValues?.modelIdOverride ||
    !!defaultValues?.proxyIdOverride ||
    !!defaultValues?.versionOverride;
  const [overridesOpen, setOverridesOpen] = useState(initialOverridesNonEmpty);

  const {
    register,
    handleSubmit,
    control,
    setValue,
    clearErrors,
    showError,
    formState: { errors },
  } = useAppForm<FormFields>({
    defaultValues: {
      name: defaultValues?.name ?? "",
      connectionProfileId: defaultValues?.connectionProfileId ?? allProfiles[0]?.id ?? "",
      cronExpression: defaultValues?.cronExpression ?? "0 9 * * *",
      timezone: defaultValues?.timezone ?? "UTC",
      enabled: defaultValues?.enabled ?? true,
    },
  });

  const [connectionProfileId, cronExpression, timezone, enabled] = useWatch({
    control,
    name: ["connectionProfileId", "cronExpression", "timezone", "enabled"],
  });

  // When profiles load after form init, set the default if still empty
  useEffect(() => {
    if (!connectionProfileId && allProfiles.length > 0) {
      setValue("connectionProfileId", allProfiles[0]!.id);
    }
  }, [connectionProfileId, allProfiles, setValue]);

  const onFormSubmit = handleSubmit((data) => {
    const input = hasInputSchema ? inputValues : undefined;

    // On create: omit empty overrides entirely (server stores null).
    // On edit: send `null` for cleared overrides so the row resets to
    // "use the agent's persisted defaults". `undefined` would leave the
    // existing override untouched per the Zod schema's optional rule.
    const overridePayload = isEdit
      ? {
          configOverride: overrides.configOverride ?? null,
          modelIdOverride: overrides.modelId ?? null,
          proxyIdOverride: overrides.proxyId ?? null,
          versionOverride: overrides.version ?? null,
        }
      : {
          ...(overrides.configOverride ? { configOverride: overrides.configOverride } : {}),
          ...(overrides.modelId ? { modelIdOverride: overrides.modelId } : {}),
          ...(overrides.proxyId ? { proxyIdOverride: overrides.proxyId } : {}),
          ...(overrides.version ? { versionOverride: overrides.version } : {}),
        };

    onSubmit({
      connectionProfileId: data.connectionProfileId,
      name: data.name || undefined,
      cronExpression: data.cronExpression,
      timezone: data.timezone,
      input,
      ...(isEdit ? { enabled: data.enabled } : {}),
      ...overridePayload,
    });
  });

  if (blockedMessage) {
    return (
      <div className="space-y-6">
        <p className="text-muted-foreground text-sm">{blockedMessage}</p>
        <div className="border-border flex justify-end gap-2 border-t pt-4">
          <Button variant="outline" onClick={onCancel}>
            {t("btn.cancel")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={onFormSubmit} className="space-y-6">
      {/* Agent selector (create mode only) */}
      {mode === "create" && agents && onAgentChange && (
        <div className="space-y-3">
          <Label htmlFor="sched-agent">{t("schedule.agent")}</Label>
          <Select value={selectedAgentId ?? ""} onValueChange={onAgentChange}>
            <SelectTrigger id="sched-agent">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {agents.map((f) => (
                <SelectItem key={f.id} value={f.id}>
                  {f.displayName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Connection profile */}
      {(allProfiles.length > 1 || foreignProfile) && (
        <div className="space-y-3">
          <Label htmlFor="sched-profile">{t("schedule.connectionProfile")}</Label>
          <CombinedProfileSelect
            value={connectionProfileId}
            onChange={(v) => {
              if (v != null) setValue("connectionProfileId", v);
              else if (allProfiles.length > 0) setValue("connectionProfileId", allProfiles[0]!.id);
            }}
            triggerClassName="w-full"
            id="sched-profile"
            foreignProfile={foreignProfile}
          />
        </div>
      )}

      {/* Name */}
      <div className="space-y-3">
        <Label htmlFor="sched-name">{t("schedule.name")}</Label>
        <Input
          id="sched-name"
          type="text"
          {...register("name")}
          placeholder={t("schedule.namePlaceholder")}
        />
      </div>

      {/* Frequency (presets + cron input) */}
      <div className="space-y-3">
        <Label>{t("schedule.frequency")}</Label>
        <div className="flex flex-wrap gap-1">
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
            aria-invalid={showError("cronExpression") ? true : undefined}
            className={cn(showError("cronExpression") && "border-destructive")}
          />
          <p className="text-muted-foreground text-sm">{t("schedule.cronHint")}</p>
          {showError("cronExpression") && errors.cronExpression?.message && (
            <p className="text-destructive text-sm">{errors.cronExpression.message}</p>
          )}
        </div>
      </div>

      {/* Timezone */}
      <div className="space-y-3">
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

      {/* Enabled toggle (edit mode only) */}
      {isEdit && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Checkbox
              id="schedule-enabled"
              checked={enabled}
              onCheckedChange={(checked) => setValue("enabled", Boolean(checked))}
            />
            <Label htmlFor="schedule-enabled" className="cursor-pointer font-normal">
              {t("schedule.enabled")}
            </Label>
          </div>
        </div>
      )}

      {/* Input fields (conditional) */}
      {hasInputSchema && (
        <div className="space-y-3">
          <Label>{t("schedule.inputTitle")}</Label>
          <SchemaForm
            wrapper={wrapper}
            formData={inputValues}
            upload={uploadClient}
            labels={labels}
            onChange={(e) => setInputValues(e.formData as Record<string, unknown>)}
          />
        </div>
      )}

      {/* Overrides accordion — surfaces per-schedule overrides for config,
          model, proxy, and version. Same UX vocabulary as the Run modal so
          users learn the override layer once. */}
      {packageId && (
        <Collapsible open={overridesOpen} onOpenChange={setOverridesOpen}>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="text-foreground hover:bg-muted/50 border-border flex w-full items-center justify-between rounded-md border border-dashed px-3 py-2 text-sm font-medium transition-colors"
            >
              <span>{t("schedule.overridesTitle")}</span>
              <ChevronDown
                className={cn(
                  "text-muted-foreground size-4 transition-transform",
                  overridesOpen && "rotate-180",
                )}
              />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-3">
            <p className="text-muted-foreground mb-3 text-xs">{t("schedule.overridesHint")}</p>
            <RunOverridesPanel
              packageId={packageId}
              configSchema={configSchema}
              persistedConfig={persistedConfig ?? {}}
              persistedModelId={persistedModelId ?? null}
              persistedProxyId={persistedProxyId ?? null}
              persistedVersion={persistedVersion ?? null}
              value={overrides}
              onChange={setOverrides}
            />
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* Footer */}
      <div className="border-border flex justify-end gap-2 border-t pt-4">
        {isEdit && onDelete && (
          <div className="mr-auto flex gap-2">
            {confirmDelete ? (
              <>
                <Button type="button" variant="destructive" size="sm" onClick={onDelete}>
                  {t("btn.confirm")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setConfirmDelete(false)}
                >
                  {t("btn.cancel")}
                </Button>
              </>
            ) : (
              <Button
                type="button"
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
        <Button type="button" variant="outline" onClick={onCancel}>
          {t("btn.cancel")}
        </Button>
        <Button type="submit" disabled={isPending || allProfiles.length === 0}>
          {isEdit ? t("btn.save") : t("btn.create")}
        </Button>
      </div>
    </form>
  );
}
