// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
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
import { LazySchemaForm as SchemaForm } from "./lazy-schema-form";
import { useSchemaFormLabels } from "../hooks/use-schema-form-labels";
import { uploadClient } from "../api/uploads";
import type { JSONSchemaObject, SchemaWrapper } from "@appstrate/core/form";
import { RunOverridesPanel, type RunOverridesValue } from "./run-overrides-panel";
import { AgentVersionField } from "./package-version-select";
import { ActorSelect, type ActorValue } from "./actor-select";

// Sentinel for the schedule's "inherit" version choice — no pin stored; the
// agent's version resolution applies at fire time.
const VERSION_INHERIT = "__inherit__";

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
  cron_expression: string;
  timezone?: string;
  input?: Record<string, unknown>;
  enabled?: boolean;
  /**
   * Per-schedule override layer. Frozen at create/update; deep-merged with
   * the application's persisted config every time the schedule fires.
   * `null` clears a previously-set override on edit.
   */
  config_override?: Record<string, unknown> | null;
  model_id_override?: string | null;
  proxy_id_override?: string | null;
  version_override?: string | null;
  /**
   * Per-integration connection picks frozen on the schedule row
   * (`package_schedules.connection_overrides`). Flat map keyed by
   * integration id: `{ "@scope/integration": "<connection_id>" }`. Same
   * wire shape as the run-route's `connection_overrides` (validated by
   * `routes/schedules.ts`'s `z.record(z.string(), z.string())`); `null`
   * clears on edit.
   */
  connection_overrides?: Record<string, string> | null;
  /**
   * Schedule execution identity (#738). Omitted on create → server defaults to
   * the caller. Omitted on edit → actor left unchanged (never cleared).
   */
  actor?: ActorValue;
}

interface ScheduleFormProps {
  mode: "create" | "edit";
  defaultValues?: {
    name?: string;
    cron_expression?: string;
    timezone?: string;
    enabled?: boolean;
    input?: Record<string, unknown>;
    config_override?: Record<string, unknown> | null;
    model_id_override?: string | null;
    proxy_id_override?: string | null;
    version_override?: string | null;
    connection_overrides?: Record<string, string> | null;
    actor?: ActorValue;
  };
  /** The schedule's current actor (edit mode) — used to detect a real change. */
  currentActor?: ActorValue;
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
  /**
   * Agent's declared integration deps — surfaces the connectionOverrides
   * picker. Pass an empty array to hide. Read from
   * `agentDetail.dependencies.integrations` at the page level.
   */
  agentIntegrations?: Array<{ id: string; tools?: string[] | "*" }>;
  agents?: Array<{ id: string; displayName: string }>;
  selectedAgentId?: string;
  onAgentChange?: (agentId: string) => void;
  onSubmit: (data: ScheduleSaveData) => void;
  onCancel: () => void;
  onDelete?: () => void;
  isPending?: boolean;
  blockedMessage?: string;
}

interface FormFields {
  name: string;
  cron_expression: string;
  timezone: string;
  enabled: boolean;
}

export function ScheduleForm({
  mode,
  defaultValues,
  currentActor,
  inputSchema,
  configSchema,
  persistedConfig,
  agentIntegrations,
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
}: ScheduleFormProps) {
  const { t } = useTranslation(["agents", "common"]);
  const cronPresets = getCronPresets(t);
  const isEdit = mode === "edit";

  const [confirmDelete, setConfirmDelete] = useState(false);

  const schema: JSONSchemaObject = inputSchema || { type: "object" as const, properties: {} };
  const hasInputSchema = Object.keys(schema.properties).length > 0;
  const wrapper: SchemaWrapper = { schema };
  const labels = useSchemaFormLabels();

  const [inputValues, setInputValues] = useState<Record<string, unknown>>(
    () => defaultValues?.input ?? {},
  );

  // Override-layer state — mirrors the Run modal's accordion, except
  // these overrides are persisted on the schedule row and replayed on
  // every fire (vs. the Run modal which only applies them once).
  const [overrides, setOverrides] = useState<RunOverridesValue>(() => {
    const v: RunOverridesValue = {};
    if (defaultValues?.config_override) v.config_override = defaultValues.config_override;
    if (defaultValues?.connection_overrides)
      v.connection_overrides = defaultValues.connection_overrides;
    if (defaultValues?.model_id_override) v.model_id_override = defaultValues.model_id_override;
    if (defaultValues?.proxy_id_override) v.proxy_id_override = defaultValues.proxy_id_override;
    return v;
  });
  // Version override lives outside the model/proxy/config panel: a schedule
  // "inherits" (no pin → resolve at fire time) or pins a specific version.
  // `undefined` = inherit (no override stored).
  const [versionOverride, setVersionOverride] = useState<string | undefined>(
    defaultValues?.version_override ?? undefined,
  );
  // Default to the inherit option (its label surfaces the agent's pinned
  // version) rather than `persistedVersion` directly — the latter has no
  // matching item when the agent has no published versions, which would render
  // the trigger blank.
  const versionSelectValue = versionOverride ?? VERSION_INHERIT;
  const setVersion = (next: string) => {
    // Selecting the inherit option, or re-selecting the agent's own pinned
    // version, means "no override" — the schedule follows the agent's
    // resolution at fire time rather than freezing a redundant pin.
    setVersionOverride(
      next === VERSION_INHERIT || next === (persistedVersion ?? "latest") ? undefined : next,
    );
  };
  const initialOverridesNonEmpty =
    !!(defaultValues?.config_override && Object.keys(defaultValues.config_override).length > 0) ||
    !!defaultValues?.model_id_override ||
    !!defaultValues?.proxy_id_override ||
    !!defaultValues?.version_override ||
    !!(
      defaultValues?.connection_overrides &&
      Object.keys(defaultValues.connection_overrides).length > 0
    );
  const [overridesOpen, setOverridesOpen] = useState(initialOverridesNonEmpty);

  // #738: execution identity. `undefined` = caller (create) / unchanged (edit).
  const [actor, setActor] = useState<ActorValue | undefined>(defaultValues?.actor);

  // True only when the selected actor differs from the schedule's current one.
  // Exploring the picker (or re-selecting the same identity) is not a change, so
  // it must not wipe the frozen connection picks.
  const actorChanged =
    !!actor &&
    ((actor.user_id ?? null) !== (currentActor?.user_id ?? null) ||
      (actor.end_user_id ?? null) !== (currentActor?.end_user_id ?? null));

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
      cron_expression: defaultValues?.cron_expression ?? "0 9 * * *",
      timezone: defaultValues?.timezone ?? "UTC",
      enabled: defaultValues?.enabled ?? true,
    },
  });

  const [cronExpression, timezone, enabled] = useWatch({
    control,
    name: ["cron_expression", "timezone", "enabled"],
  });

  const onFormSubmit = handleSubmit((data) => {
    const input = hasInputSchema ? inputValues : undefined;

    // On create: omit empty overrides entirely (server stores null).
    // On edit: send `null` for cleared overrides so the row resets to
    // "use the agent's persisted defaults". `undefined` would leave the
    // existing override untouched per the Zod schema's optional rule.
    const overridePayload = isEdit
      ? {
          config_override: overrides.config_override ?? null,
          model_id_override: overrides.model_id_override ?? null,
          proxy_id_override: overrides.proxy_id_override ?? null,
          version_override: versionOverride ?? null,
          connection_overrides: overrides.connection_overrides ?? null,
        }
      : {
          ...(overrides.config_override ? { config_override: overrides.config_override } : {}),
          ...(overrides.model_id_override
            ? { model_id_override: overrides.model_id_override }
            : {}),
          ...(overrides.proxy_id_override
            ? { proxy_id_override: overrides.proxy_id_override }
            : {}),
          ...(versionOverride ? { version_override: versionOverride } : {}),
          ...(overrides.connection_overrides
            ? { connection_overrides: overrides.connection_overrides }
            : {}),
        };

    onSubmit({
      name: data.name || undefined,
      cron_expression: data.cron_expression,
      timezone: data.timezone,
      input,
      ...(isEdit ? { enabled: data.enabled } : {}),
      ...overridePayload,
      // Create: send whatever actor was picked (omitted → backend defaults to
      // the caller). Edit: send only on a real change, and then drop the seeded
      // connection_overrides so they reset under the new identity.
      ...(isEdit
        ? actorChanged
          ? { actor, connection_overrides: undefined }
          : {}
        : actor
          ? { actor }
          : {}),
    });
  });

  return (
    <form onSubmit={onFormSubmit} className="space-y-6">
      {/* Agent selector (create mode only) — kept visible even when blocked so
          the user can pick a compatible agent instead of hitting a dead end. */}
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

      {/* When the selected agent is incompatible, show the block message in
          place of the rest of the form — but leave the selector usable above. */}
      {blockedMessage ? (
        <p className="text-muted-foreground text-sm">{blockedMessage}</p>
      ) : (
        <>
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
                    setValue("cron_expression", p.cron);
                    clearErrors("cron_expression");
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
                {...register("cron_expression", {
                  validate: (v) => {
                    if (!v.trim()) return t("validation.required", { ns: "common" });
                    return undefined;
                  },
                })}
                placeholder="*/30 * * * *"
                aria-invalid={showError("cron_expression") ? true : undefined}
                className={cn(showError("cron_expression") && "border-destructive")}
              />
              <p className="text-muted-foreground text-sm">{t("schedule.cronHint")}</p>
              {showError("cron_expression") && errors.cron_expression?.message && (
                <p className="text-destructive text-sm">{errors.cron_expression.message}</p>
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

          {/* Execution identity (#738) */}
          <div className="space-y-2">
            <Label>{t("schedule.actorTitle")}</Label>
            {/* Edit seeds `actor` with the schedule's current identity, so the
                placeholder only shows in create mode — where the default really
                is the caller. */}
            <ActorSelect
              value={actor}
              onChange={setActor}
              placeholder={t("schedule.actorDefaultSelf")}
            />
            <p className="text-muted-foreground text-xs">{t("schedule.actorHint")}</p>
          </div>

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
              <CollapsibleContent className="space-y-4 pt-3">
                <p className="text-muted-foreground text-xs">{t("schedule.overridesHint")}</p>
                <AgentVersionField
                  packageId={packageId}
                  label={t("run.overrides.versionLabel")}
                  value={versionSelectValue}
                  onChange={setVersion}
                  leadingOptions={[
                    {
                      value: VERSION_INHERIT,
                      label: persistedVersion
                        ? t("run.overrides.versionInheritPinned", { version: persistedVersion })
                        : t("run.overrides.versionInheritLatest"),
                    },
                    { value: "draft", label: t("run.overrides.versionDraft") },
                  ]}
                />
                <RunOverridesPanel
                  packageId={packageId}
                  configSchema={configSchema}
                  persistedConfig={persistedConfig ?? {}}
                  persistedModelId={persistedModelId ?? null}
                  persistedProxyId={persistedProxyId ?? null}
                  {...(agentIntegrations ? { agentIntegrations } : {})}
                  value={overrides}
                  onChange={setOverrides}
                />
              </CollapsibleContent>
            </Collapsible>
          )}
        </>
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
        <Button type="submit" disabled={isPending || Boolean(blockedMessage)}>
          {isEdit ? t("btn.save") : t("btn.create")}
        </Button>
      </div>
    </form>
  );
}
