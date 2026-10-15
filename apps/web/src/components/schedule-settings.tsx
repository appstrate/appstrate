// SPDX-License-Identifier: Apache-2.0

/**
 * A schedule's Paramètres tab: the agent settings' rail, with one explicit Save. The sections
 * edit one draft, and Save sends it as a single `PATCH /api/schedules/{id}` carrying the changed
 * keys only (absent keys are left as stored).
 *
 * The server re-checks an armed schedule's connections on every write, so a save may be refused
 * over them (`409 missing_integration_connection`): the toast says so and leads to Connexions,
 * where the refusal's candidates are the choice for another actor's connections.
 */

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Pause, Play, Trash2, Unplug } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ScheduleWireDto } from "@appstrate/shared-types";
import { DropdownMenuItem, DropdownMenuSeparator } from "@appstrate/ui/components/dropdown-menu";
import { Input } from "@appstrate/ui/components/input";
import { PageActionsMenu } from "./page-actions-menu";
import { toastScheduleConnectionChoice } from "../lib/mutation-error";
import { SettingsHeading } from "./settings/settings-heading";
import { SettingsRailView } from "./settings/settings-rail-view";
import { SettingRow } from "./settings/setting-row";
import { RoleLimitNotice } from "./role-limit-notice";
import { ActorSelect } from "./actor-select";
import { PackageVersionSelect } from "./package-version-select";
import { RunOverridesPanel } from "./run-overrides-panel";
import { AgentIntegrationsBlock } from "./package-detail/agent-integrations-block";
import { ScheduleInputFields } from "./schedule-input-fields";
import { ScheduleActorConnectionChoice } from "./schedule-actor-connection-choice";
import { ScheduleConnectionAnswer } from "./schedule-connection-answer";
import { useActorName } from "../hooks/use-actor-name";
import { SaveBar } from "./save-bar";
import { UnsavedChangesModal } from "./unsaved-changes-modal";
import { EmptyState, ErrorState } from "./page-states";
import { SettingsSkeleton } from "./loading-skeletons";
import { FrequencyComposer } from "./frequency-composer";
import { NoAccessState } from "./route-gate";
import { useAuth } from "../hooks/use-auth";
import { usePermissions } from "../hooks/use-permissions";
import { useCanWriteSchedule } from "../hooks/use-can-write-schedule";
import { usePackageDetail } from "../hooks/use-packages";
import { useScheduleFormDeps, useUpdateSchedule } from "../hooks/use-schedules";
import { useUnsavedChanges } from "../hooks/use-unsaved-changes";
import { changedInputValues, initialInputValues } from "../lib/agent-input";
import { type ConnectionChoice, scheduleConnectionChoices } from "../lib/connection-choice";
import { withConnectionOverride } from "../lib/connection-set";
import {
  type ActorValue,
  type RunOverridesValue,
  type ScheduleDraft,
  sameActor,
  scheduleUpdatePayload,
} from "../lib/schedule-payload";
import { VERSION_PUBLISHED } from "../lib/version-selector";
import {
  SCHEDULE_SETTINGS_SECTIONS as SECTIONS,
  type ScheduleSettingsSection,
  scheduleSettingsHref,
  scheduleVersionOptions,
  VERSION_INHERIT,
} from "../lib/schedule-options";

const SECTION_IDS: readonly string[] = SECTIONS.map((section) => section.id);

type Schedule = ScheduleWireDto;
type Deps = NonNullable<ReturnType<typeof useScheduleFormDeps>["deps"]>;

/** Who the schedule runs as, as stored. */
function storedActor(schedule: Schedule): ActorValue {
  return { userId: schedule.userId ?? undefined, endUserId: schedule.endUserId ?? undefined };
}

/** The version a fire runs: inherit is the latest published one, never the draft. */
function firedVersion(versionOverride: string | null | undefined): string {
  return versionOverride ?? VERSION_PUBLISHED;
}

function useIsViewer(actor: ActorValue): boolean {
  const { user } = useAuth();
  return !!user && sameActor(actor, { userId: user.id });
}

/** What the fires run at `version`: the integrations it declares, with their `required` flag. */
function useFiredFacts(packageId: string, version: string) {
  const detail = usePackageDetail("agent", packageId, { version });
  return { integrations: detail.data?.dependencies.integrations, ready: !detail.isLoading };
}

/**
 * The detail page's deeds. The enable/disable write is held here rather than by its menu item:
 * the item unmounts with the menu, and the write's refusal would go unsaid.
 */
export function ScheduleActionsMenu({
  schedule,
  onDelete,
  deletePending,
}: {
  schedule: Schedule;
  onDelete: () => void;
  deletePending: boolean;
}) {
  const { t } = useTranslation(["agents"]);
  const { can } = usePermissions();
  const toggle = useUpdateSchedule();
  // A write names no connection it does not mean to, but waits on what the fires run.
  const { ready } = useFiredFacts(schedule.packageId, firedVersion(schedule.version_override));
  return (
    <PageActionsMenu>
      <DropdownMenuItem
        onSelect={() =>
          toggle.mutate(
            { id: schedule.id, enabled: !schedule.enabled },
            { onError: (err) => toastScheduleConnectionChoice(err) },
          )
        }
        disabled={toggle.isPending || !ready}
      >
        {schedule.enabled ? <Pause /> : <Play />}
        {schedule.enabled ? t("schedule.disable") : t("schedule.enable")}
      </DropdownMenuItem>
      {can("schedules:delete") && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={onDelete}
            disabled={deletePending}
            className="text-destructive focus:text-destructive"
          >
            <Trash2 />
            {t("common:btn.delete")}
          </DropdownMenuItem>
        </>
      )}
    </PageActionsMenu>
  );
}

export function ScheduleSettings({ schedule }: { schedule: Schedule }) {
  const { t } = useTranslation(["agents", "common"]);
  const { can } = usePermissions();
  const governs = useCanWriteSchedule(schedule);
  const mayWrite = can("schedules:write") && governs;

  return (
    <SettingsRailView
      param="scheduleSettings"
      // One draft spans every section: switching sections never leaves it.
      definitionSections={SECTION_IDS}
      tab="settings"
      label={t("common:nav.settings")}
      groups={[
        {
          title: t("detail.settings.configurationGroup"),
          items: SECTIONS.map((section) => ({
            id: section.id,
            icon: section.icon,
            label: t(section.labelKey),
            locked: !mayWrite,
          })),
        },
      ]}
      resolve={(requested) => SECTIONS.find((s) => s.id === requested)?.id ?? SECTIONS[0].id}
    >
      {({ active }) => (
        <ScheduleSettingsPanel schedule={schedule} section={active} mayWrite={mayWrite} />
      )}
    </SettingsRailView>
  );
}

/** What a save was refused over connections: for whom, the choices, and the picks it was judged with. */
interface Refusal {
  actor: ActorValue;
  choices: ConnectionChoice[];
  submitted: Record<string, string[]>;
}

/** What every section reads and edits: the schedule, and the draft over it. */
interface SectionProps {
  schedule: Schedule;
  draft: ScheduleDraft;
  edit: (next: ScheduleDraft) => void;
  /** The version the fires will run once the draft is saved. */
  version: string | null;
}

function ScheduleSettingsPanel({
  schedule,
  section,
  mayWrite,
}: {
  schedule: Schedule;
  section: ScheduleSettingsSection;
  mayWrite: boolean;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const { can } = usePermissions();
  const navigate = useNavigate();
  const active = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];
  const update = useUpdateSchedule();
  const [draft, setDraft] = useState<ScheduleDraft>({});
  // What the last save was refused over, for the actor it was judged for.
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const stored = storedActor(schedule);
  const version =
    draft.versionOverride !== undefined ? draft.versionOverride : schedule.version_override;
  const facts = useFiredFacts(schedule.packageId, firedVersion(version));
  // Read alongside the facts, not once the section mounts: the agent-bound sections wait for it
  // under the same skeleton.
  const formDeps = useScheduleFormDeps(schedule.packageId);
  const agentBound = active.id !== "general";
  const formDepsSettled = !agentBound || !!formDeps.deps || !!formDeps.error || formDeps.denied;

  // An edit back to what is stored is no edit; a new actor drops the picks made for the old one.
  const edit = (next: ScheduleDraft) =>
    setDraft((prev) => {
      const merged = { ...prev, ...next };
      if (next.name !== undefined && next.name === (schedule.name ?? "")) delete merged.name;
      if (next.cron !== undefined && next.cron === schedule.cron_expression) delete merged.cron;
      if (next.timezone !== undefined && next.timezone === schedule.timezone)
        delete merged.timezone;
      if (
        next.versionOverride !== undefined &&
        next.versionOverride === (schedule.version_override ?? null)
      ) {
        delete merged.versionOverride;
      }
      if (next.actor !== undefined) {
        delete merged.picks;
        if (sameActor(next.actor, stored)) delete merged.actor;
      }
      return merged;
    });

  const inputWrapper = formDeps.deps?.inputWrapper;
  const body = scheduleUpdatePayload({
    stored: {
      actor: stored,
      versionOverride: schedule.version_override ?? null,
      picks: schedule.connection_overrides ?? null,
    },
    draft: {
      ...draft,
      input:
        draft.input && inputWrapper
          ? changedInputValues(inputWrapper, inputWrapper, draft.input)
          : undefined,
    },
    declared: facts.integrations?.map((i) => i.id),
  });
  const dirty = Object.keys(body).length > 0;
  const { blocker } = useUnsavedChanges(dirty);
  const discard = () => {
    setDraft({});
    setRefusal(null);
  };
  const save = () =>
    update.mutate(
      { id: schedule.id, ...body },
      {
        onSuccess: discard,
        onError: (err) => {
          const choices = scheduleConnectionChoices(err);
          if (choices.length > 0) {
            setRefusal({
              actor: draft.actor ?? stored,
              choices,
              submitted: body.connection_overrides ?? schedule.connection_overrides ?? {},
            });
          }
          toastScheduleConnectionChoice(err, {
            label: t("schedule.settings.chooseConnections"),
            onClick: () => navigate(scheduleSettingsHref(schedule.id, "connections")),
          });
        },
      },
    );

  return (
    <section className="min-w-0 p-6">
      <SettingsHeading title={t(active.labelKey)} description={t(active.descriptionKey)} />
      {/* Same tabs and sections for every role: what a role does not allow
          is said where the controls would be. */}
      {!mayWrite ? (
        <RoleLimitNotice>
          {t(can("schedules:write") ? "schedule.memberGoverned" : "schedule.settings.roleLimit")}
        </RoleLimitNotice>
      ) : facts.ready && formDepsSettled ? (
        <>
          <SectionBody
            section={active.id}
            schedule={schedule}
            draft={draft}
            edit={edit}
            version={version ?? null}
            formDeps={formDeps}
            facts={facts}
            refusal={refusal}
          />
          {dirty && (
            <SaveBar
              message={t("schedule.settings.unsaved")}
              pending={update.isPending}
              onDiscard={discard}
              onSave={save}
            />
          )}
          <UnsavedChangesModal blocker={blocker} />
        </>
      ) : (
        <SettingsSkeleton />
      )}
    </section>
  );
}

interface BodyProps extends SectionProps {
  formDeps: ReturnType<typeof useScheduleFormDeps>;
  facts: ReturnType<typeof useFiredFacts>;
  refusal: Refusal | null;
}

function SectionBody({ section, ...props }: BodyProps & { section: ScheduleSettingsSection }) {
  if (section === "general") return <GeneralSection {...props} />;
  return <AgentBoundSection section={section} {...props} />;
}

// ─── Général ─────────────────────────────────────────────

function GeneralSection({ schedule, draft, edit }: SectionProps) {
  const { t } = useTranslation(["agents"]);
  const stored = storedActor(schedule);
  return (
    <div className="flex flex-col gap-6">
      <SettingRow label={t("schedule.name")}>
        <Input
          value={draft.name ?? schedule.name ?? ""}
          placeholder={t("schedule.namePlaceholder")}
          aria-label={t("schedule.name")}
          onChange={(e) => edit({ name: e.target.value })}
        />
      </SettingRow>
      {/* A rhythm is composed field by field (a time picked, a day ticked): the composer
          reports it once it is valid. */}
      <FrequencyComposer
        cron={draft.cron ?? schedule.cron_expression}
        timezone={draft.timezone ?? schedule.timezone}
        onChange={(next) => next && edit({ cron: next })}
        onTimezoneChange={(timezone) => edit({ timezone })}
      />
      <SettingRow label={t("schedule.actorTitle")} description={t("schedule.actorHint")}>
        <ActorSelect
          value={draft.actor ?? stored}
          onChange={(next) => edit({ actor: next ?? stored })}
        />
      </SettingRow>
    </div>
  );
}

// ─── Sections that read the agent ────────────────────────

function AgentBoundSection({
  section,
  ...props
}: BodyProps & { section: "inputs" | "execution" | "connections" }) {
  const { error, denied, deps } = props.formDeps;
  if (error) return <ErrorState error={error} />;
  if (denied) return <NoAccessState />;
  if (!deps) return <SettingsSkeleton />;
  // Keyed on the schedule: each section seeds its local state once.
  if (section === "inputs") return <InputsSection key={props.schedule.id} deps={deps} {...props} />;
  if (section === "execution")
    return <ExecutionSection key={props.schedule.id} deps={deps} {...props} />;
  return <ConnectionsSection {...props} />;
}

// ─── Entrées ─────────────────────────────────────────────

function InputsSection({ schedule, draft, edit, deps }: BodyProps & { deps: Deps }) {
  // The schedule's frozen values over the agent's resolved ones, minus every locked field; only
  // what differs from the agent is sent back, so a later change of the agent's stored value
  // still reaches every fire.
  const values =
    draft.input ??
    initialInputValues(deps.inputWrapper, deps.inputWrapper, schedule.input ?? undefined);
  return <ScheduleInputFields deps={deps} values={values} onChange={(input) => edit({ input })} />;
}

// ─── Exécution ───────────────────────────────────────────

function storedOverrides(schedule: Schedule): RunOverridesValue {
  return {
    ...(schedule.model_id_override ? { model_id_override: schedule.model_id_override } : {}),
    ...(schedule.generation_config_override
      ? { generation_config_override: schedule.generation_config_override }
      : {}),
    ...(schedule.proxy_id_override ? { proxy_id_override: schedule.proxy_id_override } : {}),
  };
}

function ExecutionSection({ schedule, draft, edit, version, deps }: BodyProps & { deps: Deps }) {
  const { t } = useTranslation(["agents"]);
  const storedVersion = schedule.version_override ?? VERSION_INHERIT;
  const shown = version ?? VERSION_INHERIT;

  return (
    <>
      <SettingRow
        label={t("run.overrides.versionLabel")}
        description={t("schedule.settings.versionHint")}
      >
        <PackageVersionSelect
          type="agent"
          packageId={schedule.packageId}
          value={shown}
          // Only a real change is sent: naming the working copy is an author's
          // act the route judges (403 `draft_not_writable`), and echoing the
          // stored value back would claim it for whoever touched the select.
          onChange={(next) =>
            next !== shown && edit({ versionOverride: next === VERSION_INHERIT ? null : next })
          }
          leadingOptions={scheduleVersionOptions(t, {
            draftOffered: deps.homeWritable || shown === "draft" || storedVersion === "draft",
          })}
        />
      </SettingRow>
      <RunOverridesPanel
        layout="settings"
        scheduled
        packageId={schedule.packageId}
        persistedModelId={deps.persistedModelId}
        persistedGenerationConfig={deps.persistedGenerationConfig}
        persistedProxyId={deps.persistedProxyId}
        value={draft.overrides ?? storedOverrides(schedule)}
        onChange={(next) => edit({ overrides: next })}
        version={firedVersion(version)}
      />
    </>
  );
}

// ─── Connexions ──────────────────────────────────────────

function ConnectionsSection({ schedule, draft, edit, version, facts, refusal }: BodyProps) {
  const { t } = useTranslation(["agents"]);
  const actor = draft.actor ?? storedActor(schedule);
  const integrations = facts.integrations;
  // After an actor move the stored picks name the previous identity's connections.
  const picks = draft.picks ?? (draft.actor ? {} : (schedule.connection_overrides ?? {}));
  // The pickers judge the VIEWER's connections: the agent's table speaks only
  // for a schedule that runs as the viewer. Another actor's connections are
  // named from the candidates the server offers when it refuses a save.
  const actorIsViewer = useIsViewer(actor);
  const actorName = useActorName(actor);

  const pick = (
    integrationId: string,
    connectionIds: Parameters<typeof withConnectionOverride>[2],
  ) =>
    edit({
      picks:
        withConnectionOverride({ connection_overrides: picks }, integrationId, connectionIds)
          .connection_overrides ?? {},
    });

  if (!integrations) return <SettingsSkeleton rows={2} />;
  // A refusal is answered where the picks are: why each integration was refused, and the choice.
  if (refusal && sameActor(refusal.actor, actor)) {
    return (
      <ScheduleConnectionAnswer
        choices={refusal.choices}
        submitted={refusal.submitted}
        value={picks}
        integrations={integrations}
        actorName={actorName}
        onChange={pick}
      />
    );
  }
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
  return actorIsViewer ? (
    <AgentIntegrationsBlock
      entries={integrations}
      agentPackageId={schedule.packageId}
      scheduleOverrides={{ value: picks, onChange: pick, version: firedVersion(version) }}
    />
  ) : (
    <ScheduleActorConnectionChoice
      choices={[]}
      integrations={integrations}
      value={picks}
      onChange={pick}
    />
  );
}
