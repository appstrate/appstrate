// SPDX-License-Identifier: Apache-2.0

/**
 * A schedule's Paramètres tab: the agent settings' rail and rule. The control
 * IS the setting, so each one saves itself through `PATCH /api/schedules/{id}`
 * (absent keys are left as stored): a select or a preset on change, a text on
 * blur, the inputs and the execution overrides after a pause in typing.
 *
 * One write cannot be split: moving the actor of an armed schedule may leave a
 * connection choice open (`409 missing_integration_connection`), and only the
 * same write can answer it, so the identity section then asks for the picks and
 * saves both together.
 */

import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { ArrowRight, Lock, Unplug } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ScheduleWireDto } from "@appstrate/shared-types";
import { Button } from "@appstrate/ui/components/button";
import { AgentDetailSectionHeader, AgentDetailSplit } from "./agent-detail/agent-detail-split";
import { RailLink } from "./settings/rail-link";
import { SettingRow } from "./settings/setting-row";
import { InlineTextSetting } from "./settings/inline-text-setting";
import { RoleLimitNotice } from "./role-limit-notice";
import { ActorSelect } from "./actor-select";
import { PackageVersionSelect } from "./package-version-select";
import { RunOverridesPanel } from "./run-overrides-panel";
import { AgentIdentityTile } from "./agent-identity";
import { AgentIntegrationsBlock } from "./package-detail/agent-integrations-block";
import { InputFieldRow, SaveFeedback } from "./package-detail/agent-configuration-tab";
import { ScheduleActorConnectionChoice } from "./schedule-actor-connection-choice";
import { ScheduleConnectionRefusals } from "./schedule-connection-refusals";
import { EmptyState, ErrorState, LoadingState } from "./page-states";
import { FrequencyComposer } from "./frequency-composer";
import { NoAccessState } from "./route-gate";
import { useAuth } from "../hooks/use-auth";
import { usePermissions } from "../hooks/use-permissions";
import { useCanWriteSchedule } from "../hooks/use-can-write-schedule";
import { useAgents, usePackageDetail } from "../hooks/use-packages";
import { useScheduleFormDeps, useUpdateSchedule } from "../hooks/use-schedules";
import {
  changedInputValues,
  formatInputValue,
  hasInputFields,
  initialInputValues,
} from "../lib/agent-input";
import { authorDefaults, getOrderedKeys } from "@appstrate/core/form";
import { useSchemaFormLabels } from "../hooks/use-schema-form-labels";
import { useUploadClient } from "../hooks/use-upload";
import { type ConnectionChoice, scheduleConnectionChoices } from "../lib/connection-choice";
import {
  type ConnectionSet,
  withConnectionOverride,
  withDeclaredConnections,
} from "../lib/connection-set";
import { type ActorValue, type RunOverridesValue, sameActor } from "../lib/schedule-payload";
import { VERSION_PUBLISHED } from "../lib/version-selector";
import {
  SCHEDULE_SETTINGS_SECTIONS as SECTIONS,
  type ScheduleSettingsSection,
  scheduleSettingsHref,
  VERSION_INHERIT,
} from "../lib/schedule-options";

type Schedule = ScheduleWireDto;
type Save = ReturnType<typeof useUpdateSchedule>;
type Deps = NonNullable<ReturnType<typeof useScheduleFormDeps>["deps"]>;

/** Debounced save of a value edited continuously (typing, a slider). */
function useSaveAfterPause<T>(
  value: T,
  edited: boolean,
  save: (value: T) => void,
  done: () => void,
) {
  useEffect(() => {
    if (!edited) return;
    const timeout = window.setTimeout(() => {
      done();
      save(value);
    }, 650);
    return () => window.clearTimeout(timeout);
  }, [edited, value, save, done]);
}

/**
 * The integrations every fire runs, with their `required` flag: inherit is the latest published
 * version, never the draft the page would otherwise project for an author.
 */
function useFiredIntegrations(schedule: Schedule) {
  const version = schedule.version_override ?? VERSION_PUBLISHED;
  const integrations = usePackageDetail("agent", schedule.packageId, { version }).data?.dependencies
    .integrations;
  return { version, integrations };
}

export function ScheduleSettings({ schedule }: { schedule: Schedule }) {
  const { t } = useTranslation(["agents", "common"]);
  const location = useLocation();
  const { can } = usePermissions();
  const governs = useCanWriteSchedule(schedule);
  const mayWrite = can("schedules:write") && governs;
  const requested = new URLSearchParams(location.search).get("scheduleSettings");
  const active = SECTIONS.find((s) => s.id === requested) ?? SECTIONS[0];
  const update = useUpdateSchedule();

  return (
    <AgentDetailSplit
      data-schedule-settings
      railClassName="p-3"
      rail={
        <nav
          className="flex flex-col gap-0.5 max-md:flex-row max-md:overflow-x-auto"
          aria-label={t("schedule.tabSettings")}
        >
          {SECTIONS.map((section) => (
            <RailLink
              key={section.id}
              item={{
                to: scheduleSettingsHref(schedule.id, section.id),
                icon: section.icon,
                labelKey: section.labelKey,
              }}
              label={t(section.labelKey)}
              active={active.id === section.id}
              locked={!mayWrite}
            />
          ))}
        </nav>
      }
    >
      <section className="min-w-0 p-6">
        <AgentDetailSectionHeader
          title={t(active.labelKey)}
          description={t(active.descriptionKey)}
        />
        {/* Same tabs and sections for every role: what a role does not allow
            is said where the controls would be. */}
        {!mayWrite ? (
          <RoleLimitNotice>
            {t(can("schedules:write") ? "schedule.memberGoverned" : "schedule.settings.roleLimit")}
          </RoleLimitNotice>
        ) : (
          <SectionBody section={active.id} schedule={schedule} update={update} />
        )}
      </section>
    </AgentDetailSplit>
  );
}

function SectionBody({
  section,
  schedule,
  update,
}: {
  section: ScheduleSettingsSection;
  schedule: Schedule;
  update: Save;
}) {
  if (section === "general") return <GeneralSection schedule={schedule} update={update} />;
  if (section === "recurrence") return <RecurrenceSection schedule={schedule} update={update} />;
  if (section === "identity") return <IdentitySection schedule={schedule} update={update} />;
  return <AgentBoundSection section={section} schedule={schedule} update={update} />;
}

// ─── Général ─────────────────────────────────────────────

function GeneralSection({ schedule, update }: { schedule: Schedule; update: Save }) {
  const { t } = useTranslation(["agents"]);
  const { data: agents } = useAgents();
  const agent = agents?.find((a) => a.id === schedule.packageId);
  return (
    <>
      <SettingRow label={t("schedule.name")}>
        <InlineTextSetting
          value={schedule.name ?? ""}
          placeholder={t("schedule.namePlaceholder")}
          aria-label={t("schedule.name")}
          onCommit={(name) => update.mutate({ id: schedule.id, name })}
        />
      </SettingRow>
      <SettingRow label={t("schedule.agent")} description={t("schedule.settings.agentHint")}>
        {/* The agent's identity, as its own Général previews it. */}
        <Link
          to={`/agents/${schedule.packageId}`}
          className="border-border bg-muted/20 hover:bg-muted/40 flex w-full items-center gap-3 rounded-lg border p-3 transition-colors"
        >
          <AgentIdentityTile
            agentId={schedule.packageId}
            icon={agent?.icon}
            color={agent?.color}
            className="size-11 rounded-xl"
            iconClassName="size-5"
          />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">
              {agent?.display_name || schedule.packageId}
            </span>
            {agent?.description && (
              <span className="text-muted-foreground block truncate text-xs">
                {agent.description}
              </span>
            )}
          </span>
          <ArrowRight className="text-muted-foreground size-4 shrink-0" aria-hidden />
        </Link>
      </SettingRow>
      <SaveFeedback pending={update.isPending} success={update.isSuccess} error={update.isError} />
    </>
  );
}

// ─── Récurrence ──────────────────────────────────────────

function RecurrenceSection({ schedule, update }: { schedule: Schedule; update: Save }) {
  // A rhythm is composed field by field (a number typed, a day ticked): it is
  // saved once the composing pauses, and only when it is complete.
  const [cron, setCron] = useState(schedule.cron_expression);
  const [edited, setEdited] = useState(false);
  useSaveAfterPause(
    cron,
    edited,
    (next) => update.mutate({ id: schedule.id, cron_expression: next }),
    () => setEdited(false),
  );
  return (
    <>
      <FrequencyComposer
        cron={schedule.cron_expression}
        timezone={schedule.timezone}
        onChange={(next) => {
          if (!next || next === cron) return;
          setCron(next);
          setEdited(true);
        }}
        onTimezoneChange={(timezone) => update.mutate({ id: schedule.id, timezone })}
      />
      <SaveFeedback pending={update.isPending} success={update.isSuccess} error={update.isError} />
    </>
  );
}

// ─── Identité ────────────────────────────────────────────

function IdentitySection({ schedule, update }: { schedule: Schedule; update: Save }) {
  const { t } = useTranslation(["agents"]);
  const stored: ActorValue = {
    userId: schedule.userId ?? undefined,
    endUserId: schedule.endUserId ?? undefined,
  };
  const [actor, setActor] = useState<ActorValue>(stored);
  // The refusal of the last actor save, and the picks that answer it.
  const [choices, setChoices] = useState<ConnectionChoice[]>([]);
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const { integrations } = useFiredIntegrations(schedule);

  // The stored picks name the previous identity's connections: a new actor
  // starts without them, as the create form does.
  const save = (next: ActorValue, nextPicks: Record<string, string[]> | null) =>
    update.mutate(
      { id: schedule.id, actor: next, connection_overrides: nextPicks },
      {
        onSuccess: () => {
          setChoices([]);
          setPicks({});
        },
        onError: (err) => {
          const refused = scheduleConnectionChoices(err);
          setChoices(refused);
          // Any other refusal changed nothing: the field goes back to the stored identity. A
          // connection choice keeps the picked one, the picks answer it.
          if (refused.length === 0) setActor(stored);
        },
      },
    );

  return (
    <>
      <SettingRow label={t("schedule.actorTitle")} description={t("schedule.actorHint")}>
        <ActorSelect
          value={actor}
          onChange={(next) => {
            const nextActor = next ?? stored;
            setActor(nextActor);
            setChoices([]);
            setPicks({});
            if (!sameActor(nextActor, stored)) save(nextActor, null);
          }}
        />
      </SettingRow>
      {choices.length > 0 && (
        <div className="space-y-4">
          <ScheduleActorConnectionChoice
            choices={choices}
            integrations={integrations ?? []}
            value={picks}
            onChange={(integrationId, connectionIds) =>
              setPicks(
                withConnectionOverride(
                  { connection_overrides: picks },
                  integrationId,
                  connectionIds,
                ).connection_overrides ?? {},
              )
            }
          />
          <Button
            type="button"
            disabled={update.isPending}
            onClick={() => save(actor, Object.keys(picks).length > 0 ? picks : null)}
          >
            {t("schedule.settings.saveIdentity")}
          </Button>
        </div>
      )}
      {/* A choice to make is the form's state, not a failed save. */}
      <SaveFeedback
        pending={update.isPending}
        success={update.isSuccess}
        error={update.isError && choices.length === 0}
      />
    </>
  );
}

// ─── Sections that read the agent ────────────────────────

function AgentBoundSection({
  section,
  schedule,
  update,
}: {
  section: "inputs" | "execution" | "connections";
  schedule: Schedule;
  update: Save;
}) {
  const { deps, error, denied } = useScheduleFormDeps(schedule.packageId);
  if (error) return <ErrorState error={error} />;
  if (denied) return <NoAccessState />;
  if (!deps) return <LoadingState />;
  // Keyed on the schedule: each section seeds its local state once.
  if (section === "inputs")
    return <InputsSection key={schedule.id} schedule={schedule} deps={deps} update={update} />;
  if (section === "execution")
    return <ExecutionSection key={schedule.id} schedule={schedule} deps={deps} update={update} />;
  return <ConnectionsSection schedule={schedule} update={update} />;
}

// ─── Entrées ─────────────────────────────────────────────

function InputsSection({
  schedule,
  deps,
  update,
}: {
  schedule: Schedule;
  deps: Deps;
  update: Save;
}) {
  const { t } = useTranslation(["agents"]);
  const labels = useSchemaFormLabels();
  const upload = useUploadClient();
  const wrapper = deps.inputWrapper;
  // Seeded from the schedule's frozen values over the agent's resolved ones,
  // minus every locked field; only what differs from the agent is sent back,
  // so a later change of the agent's stored value still reaches every fire.
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    initialInputValues(wrapper, wrapper, schedule.input ?? undefined),
  );
  const [edited, setEdited] = useState(false);
  useSaveAfterPause(
    values,
    edited,
    (next) => update.mutate({ id: schedule.id, input: changedInputValues(wrapper, wrapper, next) }),
    () => setEdited(false),
  );

  if (deps.hasFileInputs) {
    return <p className="text-muted-foreground text-sm">{t("schedule.fileInputBlocked")}</p>;
  }
  if (!hasInputFields(wrapper)) {
    return <p className="text-muted-foreground text-sm">{t("detail.emptyConfig")}</p>;
  }
  const defaults = authorDefaults(wrapper.schema);
  return (
    <div className="space-y-4">
      {getOrderedKeys(wrapper.schema, wrapper.property_order).map((key) => {
        // A field the agent locks is the agent's value at every fire.
        const locked = wrapper.locked_fields.includes(key);
        const agentValue = wrapper.values[key] ?? defaults[key];
        return (
          <InputFieldRow
            key={key}
            fieldKey={key}
            wrapper={wrapper}
            value={locked ? agentValue : values[key]}
            disabled={locked}
            labels={labels}
            upload={upload}
            onValueChange={(next) => {
              setValues((prev) => {
                const out = { ...prev };
                if (next === undefined) delete out[key];
                else out[key] = next;
                return out;
              });
              setEdited(true);
            }}
            hint={
              locked ? (
                <>
                  <Lock className="size-3.5" aria-hidden />
                  {t("schedule.settings.lockedByAgent")}
                </>
              ) : agentValue !== undefined &&
                JSON.stringify(values[key]) !== JSON.stringify(agentValue) ? (
                // Said only when this schedule replaces the agent's value.
                t("schedule.settings.agentValue", { value: formatInputValue(agentValue) })
              ) : undefined
            }
          />
        );
      })}
      <SaveFeedback pending={update.isPending} success={update.isSuccess} error={update.isError} />
    </div>
  );
}

// ─── Exécution ───────────────────────────────────────────

function ExecutionSection({
  schedule,
  deps,
  update,
}: {
  schedule: Schedule;
  deps: Deps;
  update: Save;
}) {
  const { t } = useTranslation(["agents"]);
  const [overrides, setOverrides] = useState<RunOverridesValue>(() => ({
    ...(schedule.model_id_override ? { model_id_override: schedule.model_id_override } : {}),
    ...(schedule.generation_config_override
      ? { generation_config_override: schedule.generation_config_override }
      : {}),
    ...(schedule.proxy_id_override ? { proxy_id_override: schedule.proxy_id_override } : {}),
  }));
  const [edited, setEdited] = useState(false);
  useSaveAfterPause(
    overrides,
    edited,
    (next) =>
      update.mutate({
        id: schedule.id,
        model_id_override: next.model_id_override ?? null,
        generation_config_override: next.generation_config_override ?? null,
        proxy_id_override: next.proxy_id_override ?? null,
      }),
    () => setEdited(false),
  );
  const version = schedule.version_override ?? VERSION_INHERIT;

  return (
    <>
      <SettingRow
        label={t("run.overrides.versionLabel")}
        description={t("schedule.settings.versionHint")}
      >
        <PackageVersionSelect
          type="agent"
          packageId={schedule.packageId}
          value={version}
          // Only a real change is sent: naming the working copy is an author's
          // act the route judges (403 `draft_not_writable`), and echoing the
          // stored value back would claim it for whoever touched the select.
          onChange={(next) => {
            if (next !== version) {
              update.mutate({
                id: schedule.id,
                version_override: next === VERSION_INHERIT ? null : next,
              });
            }
          }}
          leadingOptions={[
            { value: VERSION_INHERIT, label: t("run.overrides.versionInheritLatest") },
            ...(deps.homeWritable || version === "draft"
              ? [{ value: "draft", label: t("run.overrides.versionDraft") }]
              : []),
          ]}
        />
      </SettingRow>
      <RunOverridesPanel
        layout="settings"
        scheduled
        packageId={schedule.packageId}
        persistedModelId={deps.persistedModelId}
        persistedGenerationConfig={deps.persistedGenerationConfig}
        persistedProxyId={deps.persistedProxyId}
        value={overrides}
        onChange={(next) => {
          setOverrides(next);
          setEdited(true);
        }}
        version={schedule.version_override ?? VERSION_PUBLISHED}
      />
      <SaveFeedback pending={update.isPending} success={update.isSuccess} error={update.isError} />
    </>
  );
}

// ─── Connexions ──────────────────────────────────────────

function ConnectionsSection({ schedule, update }: { schedule: Schedule; update: Save }) {
  const { t } = useTranslation(["agents"]);
  const { user } = useAuth();
  const [choices, setChoices] = useState<ConnectionChoice[]>([]);
  const { version: firedVersion, integrations } = useFiredIntegrations(schedule);
  const picks = schedule.connection_overrides ?? {};
  // The pickers judge the VIEWER's connections: the agent's table speaks only
  // for a schedule that runs as the viewer. Another actor's connections are
  // named from the candidates the server offers when it refuses a write.
  const actorIsViewer =
    !!user && sameActor({ userId: schedule.userId ?? undefined }, { userId: user.id });

  const pick = (integrationId: string, connectionIds: ConnectionSet) => {
    const next = withDeclaredConnections(
      withConnectionOverride({ connection_overrides: picks }, integrationId, connectionIds),
      integrations?.map((i) => i.id),
    ).connection_overrides;
    update.mutate(
      { id: schedule.id, connection_overrides: next ?? null },
      {
        onSuccess: () => setChoices([]),
        onError: (err) => setChoices(scheduleConnectionChoices(err)),
      },
    );
  };

  if (!integrations) return <LoadingState />;
  if (integrations.length === 0) {
    return (
      <EmptyState
        message={t("detail.emptyConnections")}
        hint={t("schedule.settings.noIntegrations")}
        icon={Unplug}
        compact
      />
    );
  }
  return (
    <div className="space-y-4">
      <ScheduleConnectionRefusals choices={choices} />
      {actorIsViewer ? (
        <AgentIntegrationsBlock
          entries={integrations}
          agentPackageId={schedule.packageId}
          scheduleOverrides={{ value: picks, onChange: pick, version: firedVersion }}
        />
      ) : (
        <ScheduleActorConnectionChoice
          choices={choices}
          integrations={integrations}
          value={picks}
          onChange={pick}
        />
      )}
    </div>
  );
}
