// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useWatch } from "react-hook-form";
import { useAppForm } from "../hooks/use-app-form";
import { useTranslation } from "react-i18next";
import { cn } from "@appstrate/ui/cn";
import { Button } from "@appstrate/ui/components/button";
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
import type { AgentInputSettings } from "@appstrate/core/input-resolution";
import { changedInputValues, hasInputFields, initialInputValues } from "../lib/agent-input";
import { RunOverridesPanel } from "./run-overrides-panel";
import { AgentVersionField } from "./package-version-select";
import { ActorSelect } from "./actor-select";
import { ScheduleActorConnectionChoice } from "./schedule-actor-connection-choice";
import { ScheduleConnectionRefusals } from "./schedule-connection-refusals";
import { VERSION_PUBLISHED } from "../lib/version-selector";
import {
  type ConnectionChoice,
  type SubmittedPicks,
  pendingConnectionChoices,
  picksAfterActorChange,
  refusalForActor,
} from "../lib/connection-choice";
import { withConnectionOverride, withDeclaredConnections } from "../lib/connection-set";
import {
  type ActorValue,
  type RunOverridesValue,
  sameActor,
  scheduleOverridePayload,
} from "../lib/schedule-payload";
import { useAuth } from "../hooks/use-auth";
import { timezoneOptions } from "../lib/timezones";
import { CRON_PRESETS, VERSION_INHERIT } from "../lib/schedule-options";
import { usePackageDetail } from "../hooks/use-packages";
import type { ModelGenerationSettings } from "@appstrate/core/model-generation";

/** Stable "no agent loaded yet" layers — a per-render literal would change
 * identity and defeat the launch form's memoized partition. */
const EMPTY_INPUT_SETTINGS: AgentInputSettings = { values: {}, locked_fields: [] };

interface ScheduleSaveData {
  name?: string;
  cron_expression: string;
  timezone?: string;
  input?: Record<string, unknown>;
  model_id_override?: string | null;
  generation_config_override?: ModelGenerationSettings | null;
  proxy_id_override?: string | null;
  version_override?: string | null;
  /**
   * Per-integration connection picks frozen on the schedule row
   * (`package_schedules.connection_overrides`), same wire shape as the run
   * route's `connection_overrides`.
   */
  connection_overrides?: Record<string, string[]> | null;
  /** Schedule execution identity (#738). Omitted → the server defaults to the caller. */
  actor?: ActorValue;
}

/**
 * Creating a schedule: everything it needs to exist, in one write. An existing
 * schedule is changed in its Paramètres tab (`ScheduleSettings`), field by field.
 */
interface ScheduleFormProps {
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
  agents?: Array<{ id: string; displayName: string }>;
  selectedAgentId?: string;
  onAgentChange?: (agentId: string) => void;
  onSubmit: (data: ScheduleSaveData) => void;
  onCancel: () => void;
  isPending?: boolean;
  blockedMessage?: string;
  /**
   * What the last save was refused over (`409 missing_integration_connection`):
   * a scheduled fire cannot ask which connection to use.
   */
  connectionChoices?: readonly ConnectionChoice[];
}

interface FormFields {
  name: string;
  cron_expression: string;
  timezone: string;
}

export function ScheduleForm({
  inputWrapper,
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
  isPending,
  blockedMessage,
  connectionChoices,
}: ScheduleFormProps) {
  const { t } = useTranslation(["agents", "common"]);

  // The wrapper carries the stored values and locks; the constant stands in
  // only while the agent detail is still loading.
  const settings: AgentInputSettings = inputWrapper ?? EMPTY_INPUT_SETTINGS;
  const hasInput = hasInputFields(inputWrapper);

  // Seeded from the agent's resolved defaults, minus every locked field.
  const [inputValues, setInputValues] = useState<Record<string, unknown>>(() =>
    initialInputValues(inputWrapper, settings, undefined),
  );

  // Override-layer state — mirrors the Run modal's accordion, except
  // these overrides are persisted on the schedule row and replayed on
  // every fire (vs. the Run modal which only applies them once).
  const [overrides, setOverrides] = useState<RunOverridesValue>({});
  // Version override lives outside the model/proxy panel: a schedule either
  // "inherits" (nothing stored → resolve at fire time) or freezes one version.
  // `undefined` = inherit (no override stored).
  const [versionOverride, setVersionOverride] = useState<string | undefined>(undefined);
  const versionSelectValue = versionOverride ?? VERSION_INHERIT;
  const setVersion = (next: string) => {
    // Only the inherit option means "no override". Every other pick is stored
    // as written, including one that happens to name today's latest version:
    // an explicit choice stays explicit, and a publish tomorrow must not move
    // a schedule its author deliberately froze.
    setVersionOverride(next === VERSION_INHERIT ? undefined : next);
  };
  const [overridesOpen, setOverridesOpen] = useState(false);

  // #738: execution identity. `undefined` = the caller.
  const [actor, setActor] = useState<ActorValue | undefined>(undefined);
  const { user } = useAuth();
  // Who a fire runs as while the select holds nothing: the caller.
  const baseActor: ActorValue | undefined = user ? { userId: user.id } : undefined;
  const runsAs = actor ?? baseActor;
  // The pickers judge the VIEWER's connections; they only speak for a schedule
  // that runs as the viewer.
  const actorIsViewer = !!user && sameActor(runsAs, { userId: user.id });
  const changeActor = (next: ActorValue | undefined) => {
    setOverrides((prev) => {
      const { connection_overrides: picks, ...rest } = prev;
      const kept = picksAfterActorChange({
        picks,
        runsAs,
        nextRunsAs: next ?? baseActor,
      });
      return kept ? { ...rest, connection_overrides: kept } : rest;
    });
    setActor(next);
  };
  const setConnectionPick = (integrationId: string, connectionIds: string[]) =>
    setOverrides((prev) => withConnectionOverride(prev, integrationId, connectionIds));

  // Derived, not synced: a refusal is stale once the actor moves, answered once a pick moves.
  const [submitted, setSubmitted] = useState<SubmittedPicks | null>(null);
  const refused = refusalForActor(connectionChoices, submitted, runsAs);
  const pending = pendingConnectionChoices(
    refused,
    submitted?.picks,
    overrides.connection_overrides,
  );
  // Open while a refusal speaks for this actor, so answering it does not fold the pick away.
  const overridesShown = overridesOpen || refused.length > 0;

  // Rows come from the definition every fire runs: inherit is the latest published version,
  // never the draft this page would otherwise project for an author.
  const firedVersion = versionOverride ?? VERSION_PUBLISHED;
  const firedIntegrations = usePackageDetail("agent", packageId, { version: firedVersion }).data
    ?.dependencies.integrations;
  // The saved map replaces the stored one: a key the fired version no longer declares is
  // dropped (the server refuses it), whichever picker — or none — the form shows.
  const declaredOverrides = withDeclaredConnections(
    overrides,
    firedIntegrations?.map((i) => i.id),
  );
  const showActorChoice =
    !actorIsViewer &&
    ((firedIntegrations?.length ?? 0) > 0 ||
      refused.length > 0 ||
      Object.keys(declaredOverrides.connection_overrides ?? {}).length > 0);

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
      name: "",
      cron_expression: "0 9 * * *",
      timezone: "UTC",
    },
  });

  const [cronExpression, timezone] = useWatch({
    control,
    name: ["cron_expression", "timezone"],
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
    const input = changedInputValues(inputWrapper, settings, inputValues);

    setSubmitted({ runsAs, picks: declaredOverrides.connection_overrides ?? {} });
    onSubmit({
      name: data.name || undefined,
      cron_expression: data.cron_expression,
      timezone: data.timezone,
      input,
      ...scheduleOverridePayload({ overrides: declaredOverrides, versionOverride, actor }),
    });
  });

  return (
    <form onSubmit={onFormSubmit} className="space-y-6">
      {/* Agent selector — kept visible even when blocked so the user can pick
          a compatible agent instead of hitting a dead end. */}
      {agents && onAgentChange && (
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
              {CRON_PRESETS.map((p) => (
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
                  {t(p.labelKey)}
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
                {timezoneOptions(timezone).map((tz) => (
                  <SelectItem key={tz} value={tz}>
                    {tz}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Execution identity (#738) */}
          <div className="space-y-2">
            <Label>{t("schedule.actorTitle")}</Label>
            <ActorSelect
              value={actor}
              onChange={changeActor}
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

          <ScheduleConnectionRefusals choices={pending} />

          {/* Overrides accordion — surfaces per-schedule overrides for model,
          proxy, and version. Same UX vocabulary as the Run modal so users
          learn the override layer once. */}
          {packageId && (
            <Collapsible open={overridesShown} onOpenChange={setOverridesOpen}>
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="text-foreground hover:bg-muted/50 border-border flex w-full items-center justify-between rounded-md border border-dashed px-3 py-2 text-sm font-medium transition-colors"
                >
                  <span>{t("schedule.overridesTitle")}</span>
                  <ChevronDown
                    className={cn(
                      "text-muted-foreground size-4 transition-transform",
                      overridesShown && "rotate-180",
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
                  {...(actorIsViewer && firedIntegrations
                    ? { agentIntegrations: firedIntegrations }
                    : {})}
                  value={overrides}
                  onChange={setOverrides}
                  version={firedVersion}
                />
                {showActorChoice && (
                  <ScheduleActorConnectionChoice
                    choices={refused}
                    value={declaredOverrides.connection_overrides ?? {}}
                    onChange={setConnectionPick}
                  />
                )}
              </CollapsibleContent>
            </Collapsible>
          )}
        </>
      )}

      {/* Footer */}
      <div className="border-border flex justify-end gap-2 border-t pt-4">
        <Button type="button" variant="outline" onClick={onCancel}>
          {t("btn.cancel")}
        </Button>
        <Button type="submit" disabled={isPending || Boolean(blockedMessage)}>
          {t("btn.create")}
        </Button>
      </div>
    </form>
  );
}
