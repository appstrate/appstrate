// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useWatch } from "react-hook-form";
import { useAppForm } from "../hooks/use-app-form";
import { useTranslation } from "react-i18next";
import { cn } from "@appstrate/ui/cn";
import { Button } from "@appstrate/ui/components/button";
import { Checkbox } from "@appstrate/ui/components/checkbox";
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@appstrate/ui/components/select";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@appstrate/ui/components/collapsible";
import { ChevronDown } from "lucide-react";
import type { AgentDetail } from "@appstrate/shared-types";
import { AgentInputForm } from "./agent-input-form";
import {
  changedInputValues,
  hasInputFields,
  initialInputValues,
  type AgentInputSettings,
} from "../lib/agent-input";
import { RunOverridesPanel, type RunOverridesValue } from "./run-overrides-panel";
import { AgentVersionField } from "./package-version-select";
import { ActorSelect, type ActorValue } from "./actor-select";
import type { ModelGenerationSettings } from "@appstrate/core/model-generation";

// Sentinel for the schedule's "inherit" version choice — nothing stored; the
// agent's version resolution applies at fire time, which means the latest
// published version.
const VERSION_INHERIT = "__inherit__";

/** Stable "no agent loaded yet" layers — a per-render literal would change
 * identity and defeat the launch form's memoized partition. */
const EMPTY_INPUT_SETTINGS: AgentInputSettings = { values: {}, locked_fields: [] };

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

interface ScheduleSaveData {
  name?: string;
  cron_expression: string;
  timezone?: string;
  input?: Record<string, unknown>;
  enabled?: boolean;
  model_id_override?: string | null;
  generation_config_override?: ModelGenerationSettings | null;
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
    model_id_override?: string | null;
    generation_config_override?: ModelGenerationSettings | null;
    proxy_id_override?: string | null;
    version_override?: string | null;
    connection_overrides?: Record<string, string> | null;
    actor?: ActorValue;
  };
  /** The schedule's current actor (edit mode) — used to detect a real change. */
  currentActor?: ActorValue;
  /**
   * The agent's input wrapper (schema + hints + order) plus the
   * per-space layers behind it (`values` + `locked_fields`).
   */
  inputWrapper?: AgentDetail["input"];
  /** Persisted defaults — passed straight through to RunOverridesPanel. */
  persistedModelId?: string | null;
  persistedGenerationConfig?: ModelGenerationSettings | null;
  persistedProxyId?: string | null;
  /**
   * Whether the caller may write the package — i.e. whether the working
   * copy is theirs to run. Gates the `draft` option: offering it to anyone
   * else turns a server refusal (`403 draft_not_writable`) into a clickable
   * dead end.
   */
  homeWritable?: boolean;
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
  inputWrapper,
  agentIntegrations,
  persistedModelId,
  persistedGenerationConfig,
  persistedProxyId,
  homeWritable,
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

  // The wrapper carries the stored values and locks; the constant stands in
  // only while the agent detail is still loading.
  const settings: AgentInputSettings = inputWrapper ?? EMPTY_INPUT_SETTINGS;
  const hasInput = hasInputFields(inputWrapper);

  // Seeded from the schedule's frozen values on top of the agent's resolved
  // defaults, minus every locked field: a schedule that still carries a value
  // for a field locked since it was saved would be refused on the next save
  // (400 `locked_input_field`).
  const [inputValues, setInputValues] = useState<Record<string, unknown>>(() =>
    initialInputValues(inputWrapper, settings, defaultValues?.input),
  );

  // Override-layer state — mirrors the Run modal's accordion, except
  // these overrides are persisted on the schedule row and replayed on
  // every fire (vs. the Run modal which only applies them once).
  const [overrides, setOverrides] = useState<RunOverridesValue>(() => {
    const v: RunOverridesValue = {};
    if (defaultValues?.connection_overrides)
      v.connection_overrides = defaultValues.connection_overrides;
    if (defaultValues?.model_id_override) v.model_id_override = defaultValues.model_id_override;
    if (defaultValues?.generation_config_override)
      v.generation_config_override = defaultValues.generation_config_override;
    if (defaultValues?.proxy_id_override) v.proxy_id_override = defaultValues.proxy_id_override;
    return v;
  });
  // Version override lives outside the model/proxy panel: a schedule either
  // "inherits" (nothing stored → resolve at fire time) or freezes one version.
  // `undefined` = inherit (no override stored).
  const [versionOverride, setVersionOverride] = useState<string | undefined>(
    defaultValues?.version_override ?? undefined,
  );
  const versionSelectValue = versionOverride ?? VERSION_INHERIT;
  const setVersion = (next: string) => {
    // Only the inherit option means "no override". Every other pick is stored
    // as written, including one that happens to name today's latest version:
    // an explicit choice stays explicit, and a publish tomorrow must not move
    // a schedule its author deliberately froze.
    setVersionOverride(next === VERSION_INHERIT ? undefined : next);
  };
  // Naming the working copy is an author's act, and the route judges
  // `version_override` (403 `draft_not_writable`) on every write that decides
  // it. Echoing back the value the row already holds decides nothing, so a
  // reader who only moves the cron of someone else's draft schedule must not be
  // refused for a choice they did not make. Send the key only on a real change;
  // an absent key leaves the stored value untouched, per the route's optional
  // rule. The route ignores an unchanged value too, so either half alone spares
  // that reader the refusal — both exist because a client must not CLAIM an act
  // its user did not make, and a route must not judge one it was not asked for.
  const versionOverrideChanged =
    (versionOverride ?? null) !== (defaultValues?.version_override ?? null);

  const initialOverridesNonEmpty =
    !!defaultValues?.model_id_override ||
    !!defaultValues?.generation_config_override ||
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
    ((actor.userId ?? null) !== (currentActor?.userId ?? null) ||
      (actor.endUserId ?? null) !== (currentActor?.endUserId ?? null));

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
    // The form state is SEEDED with the agent's resolved values so the admin
    // sees what a fire will use — but `package_schedules.input` outranks both
    // layers behind it, so submitting that seed back would freeze the author
    // default and the editor's stored value onto this row: later edits to the
    // stored value would never reach a single fire again. Send only what this
    // schedule itself decides. Dropping an unchanged key loses nothing — the
    // editor layer supplies exactly that key at fire time, and it supplies the
    // value it holds THEN, which is the whole point.
    //
    // Always sent, even empty: on edit an absent `input` means "leave the row
    // untouched" (`updateSchedule` only assigns when `!== undefined`), so an
    // empty object is how a schedule that no longer decides anything releases
    // the values it used to freeze. On create the route defaults it to `{}`
    // anyway, so the two paths agree.
    const input = changedInputValues(inputWrapper, settings, inputValues);

    // On create: omit empty overrides entirely (server stores null).
    // On edit: send `null` for cleared overrides so the row resets to
    // "use the agent's persisted defaults". `undefined` would leave the
    // existing override untouched per the Zod schema's optional rule.
    const overridePayload = isEdit
      ? {
          model_id_override: overrides.model_id_override ?? null,
          generation_config_override: overrides.generation_config_override ?? null,
          proxy_id_override: overrides.proxy_id_override ?? null,
          ...(versionOverrideChanged ? { version_override: versionOverride ?? null } : {}),
          connection_overrides: overrides.connection_overrides ?? null,
        }
      : {
          ...(overrides.model_id_override
            ? { model_id_override: overrides.model_id_override }
            : {}),
          ...(overrides.generation_config_override
            ? { generation_config_override: overrides.generation_config_override }
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

          {/* Agent parameters — same three display states as a run launch:
              locked fields read-only, pre-filled ones folded into "Avancé". */}
          {hasInput && (
            <div className="space-y-3">
              <Label>{t("schedule.inputTitle")}</Label>
              <AgentInputForm
                wrapper={inputWrapper}
                settings={settings}
                value={inputValues}
                onChange={setInputValues}
              />
            </div>
          )}

          {/* Overrides accordion — surfaces per-schedule overrides for model,
          proxy, and version. Same UX vocabulary as the Run modal so users
          learn the override layer once. */}
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
                    { value: VERSION_INHERIT, label: t("run.overrides.versionInheritLatest") },
                    // The working copy belongs to whoever can write the
                    // package; for everybody else the schedule would be
                    // refused at every fire, so the option is not offered.
                    // It IS listed when the schedule already holds it, though:
                    // a reader opening someone else's draft schedule must see
                    // what it says, not a blank trigger with no matching item.
                    ...(homeWritable || versionOverride === "draft"
                      ? [{ value: "draft", label: t("run.overrides.versionDraft") }]
                      : []),
                  ]}
                />
                <RunOverridesPanel
                  packageId={packageId}
                  persistedModelId={persistedModelId ?? null}
                  persistedGenerationConfig={persistedGenerationConfig ?? null}
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
