// SPDX-License-Identifier: Apache-2.0

/**
 * A schedule's Paramètres tab: the agent settings' rail and rule. The control
 * IS the setting, so each one saves itself through `PATCH /api/schedules/{id}`
 * (absent keys are left as stored): a select or a preset on change, a text on
 * blur, the inputs and the execution overrides after a pause in typing.
 *
 * The server re-checks an armed schedule's connections on every write, so any
 * save may be refused over them (`409 missing_integration_connection`): only
 * the same write can answer it, so the section then says why, asks for the
 * picks, and sends it again with them.
 */

import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Lock, Pause, Play, Trash2, Unplug } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ScheduleWireDto } from "@appstrate/shared-types";
import { Button } from "@appstrate/ui/components/button";
import { DropdownMenuItem, DropdownMenuSeparator } from "@appstrate/ui/components/dropdown-menu";
import { PageActionsMenu } from "./page-actions-menu";
import { toastScheduleConnectionChoice } from "../lib/mutation-error";
import { SettingsHeading } from "./settings/settings-heading";
import { SettingsRailView } from "./settings/settings-rail-view";
import { SettingRow } from "./settings/setting-row";
import { InlineTextSetting } from "./settings/inline-text-setting";
import { RoleLimitNotice } from "./role-limit-notice";
import { ActorSelect } from "./actor-select";
import { useActorName } from "../hooks/use-actor-name";
import { PackageVersionSelect } from "./package-version-select";
import { RunOverridesPanel } from "./run-overrides-panel";
import { PackageIcon } from "./package-icon";
import { AgentIntegrationsBlock } from "./package-detail/agent-integrations-block";
import { InputFieldRow } from "./settings/input-field-row";
import { SaveFeedback } from "./settings/save-feedback";
import { ScheduleActorConnectionChoice } from "./schedule-actor-connection-choice";
import { ScheduleConnectionAnswer } from "./schedule-connection-answer";
import { EmptyState, ErrorState } from "./page-states";
import { SettingsSkeleton } from "./loading-skeletons";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { isQueryInFlight } from "../lib/query-state";
import { FrequencyComposer } from "./frequency-composer";
import { NoAccessState } from "./route-gate";
import { useAuth } from "../hooks/use-auth";
import { usePermissions } from "../hooks/use-permissions";
import { useCanWriteSchedule } from "../hooks/use-can-write-schedule";
import { useAgents, usePackageDetail } from "../hooks/use-packages";
import { useScheduleFormDeps, useUpdateSchedule } from "../hooks/use-schedules";
import { useSaveAfterPause } from "../hooks/use-save-after-pause";
import {
  changedInputValues,
  formatInputValue,
  hasInputFields,
  initialInputValues,
} from "../lib/agent-input";
import { authorDefaults, getOrderedKeys } from "@appstrate/core/form";
import { useSchemaFormLabels } from "../hooks/use-schema-form-labels";
import { useUploadClient } from "../hooks/use-upload";
import { refusedScheduleWrite, scheduleConnectionChoices } from "../lib/connection-choice";
import { type ConnectionSet, withConnectionOverride } from "../lib/connection-set";
import {
  type ActorValue,
  type RunOverridesValue,
  type ScheduleOverridesState,
  dueScheduleMove,
  sameActor,
  scheduleConnectionPickPayload,
  scheduleExecutionPayload,
  scheduleRefusalAnswerPayload,
} from "../lib/schedule-payload";
import { VERSION_PUBLISHED } from "../lib/version-selector";
import {
  SCHEDULE_SETTINGS_SECTIONS as SECTIONS,
  type ScheduleSettingsSection,
  sectionWriteState,
  scheduleVersionOptions,
  VERSION_INHERIT,
} from "../lib/schedule-options";

type Schedule = ScheduleWireDto;
type UpdateMutation = ReturnType<typeof useUpdateSchedule>;
/**
 * The schedule's one write path; its `isError` leaves out a refusal over connections. `ready`
 * once the facts every write keeps its connections to have settled ({@link useFiredFacts}).
 * `fired` is those facts.
 */
type Save = Omit<UpdateMutation, "isError"> & {
  isError: boolean;
  ready: boolean;
  fired: Omit<ScheduleOverridesState, "overrides">;
};
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
 * `useUpdateSchedule` for this schedule: the settings' fields and moves, and the detail page's
 * enable/disable. A write refused over connections is the refusal panel's to say, not an
 * « Erreur d'enregistrement » under the field. A write names no connection it does not mean to:
 * the set a fallback binds is the server's to name (`withScheduleFallback`).
 */
function useScheduleWrite(schedule: Schedule): Save {
  const update = useUpdateSchedule();
  const { integrations, ready } = useFiredFacts(
    schedule.packageId,
    firedVersion(schedule.version_override),
  );
  const fired = { declared: integrations?.map((i) => i.id) };
  const refused = scheduleConnectionChoices(update.error).length > 0;
  return { ...update, isError: update.isError && !refused, ready, fired };
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
  const toggle = useScheduleWrite(schedule);
  return (
    <PageActionsMenu>
      <DropdownMenuItem
        onSelect={() =>
          toggle.mutate(
            { id: schedule.id, enabled: !schedule.enabled },
            { onError: toastScheduleConnectionChoice },
          )
        }
        disabled={toggle.isPending || !toggle.ready}
      >
        {schedule.enabled ? <Pause size={14} /> : <Play size={14} />}
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
            <Trash2 size={14} />
            {t("schedule.delete")}
          </DropdownMenuItem>
        </>
      )}
    </PageActionsMenu>
  );
}

/** What a move changes; an absent key does not move. */
type Move = { actor?: ActorValue; versionOverride?: string | null };
type ScheduleMove = ReturnType<typeof useScheduleMove>;

/**
 * A move of the actor or the version, sent once the NEXT state's facts have settled
 * ({@link dueScheduleMove}). Held by the tab, not by a section: a section left before they
 * settle would drop it. `held` from the request to the answer.
 */
function useScheduleMove(schedule: Schedule, update: Save) {
  const [move, setMove] = useState<Move | null>(null);
  const sent = useRef<Move | null>(null);
  const version =
    move?.versionOverride !== undefined ? move.versionOverride : schedule.version_override;
  const facts = useFiredFacts(schedule.packageId, firedVersion(version));
  useEffect(() => {
    if (!move || sent.current === move) return;
    const body = dueScheduleMove({
      ready: facts.ready,
      stored: {
        actor: storedActor(schedule),
        versionOverride: schedule.version_override ?? null,
        picks: schedule.connection_overrides ?? null,
      },
      next: move,
      declared: facts.integrations?.map((i) => i.id),
    });
    if (!body) return;
    sent.current = move;
    update.mutate({ id: schedule.id, ...body }, { onSettled: () => setMove(null) });
  });
  return { request: setMove, held: move };
}

/** The write's open refusal over connections, if its last write was refused over them. */
function openRefusal(schedule: Schedule, write: Save) {
  return refusedScheduleWrite(write.error, write.variables, {
    actor: storedActor(schedule),
    picks: schedule.connection_overrides ?? null,
  });
}

/**
 * Where the moves stand: the move held or in flight, else the one an open refusal waits on (its
 * answer re-sends it), else nothing — the stored value. A failed write leaves nothing shown.
 */
function shownMove(schedule: Schedule, move: ScheduleMove, moveWrite: Save): Move {
  if (move.held) return move.held;
  const sent =
    moveWrite.isPending || openRefusal(schedule, moveWrite) ? moveWrite.variables : undefined;
  if (!sent) return {};
  return {
    ...(sent.actor ? { actor: sent.actor } : {}),
    ...("version_override" in sent ? { versionOverride: sent.version_override } : {}),
  };
}

/**
 * The open refusal of the last write over connections, answered in place in every section,
 * Connexions included: the same write sent again with the picks.
 */
function RefusedWriteAnswer({ schedule, update }: { schedule: Schedule; update: Save }) {
  const refused = openRefusal(schedule, update);
  if (!refused || !update.variables) return null;
  // A new refusal, new picks.
  return (
    <RefusedWriteForm
      key={update.submittedAt}
      schedule={schedule}
      update={update}
      sent={update.variables}
      refused={refused}
    />
  );
}

function RefusedWriteForm({
  schedule,
  update,
  sent,
  refused,
}: {
  schedule: Schedule;
  update: Save;
  sent: NonNullable<Save["variables"]>;
  refused: NonNullable<ReturnType<typeof refusedScheduleWrite>>;
}) {
  const { t } = useTranslation(["agents"]);
  const actorName = useActorName(refused.runsAs);
  const version = "version_override" in sent ? sent.version_override : schedule.version_override;
  const integrations = usePackageDetail("agent", schedule.packageId, {
    version: firedVersion(version),
  }).data?.dependencies.integrations;
  const [picks, setPicks] = useState<Record<string, string[]>>(refused.picks);
  return (
    <div className="mb-6 space-y-4">
      <ScheduleConnectionAnswer
        choices={refused.choices}
        submitted={refused.picks}
        value={picks}
        integrations={integrations ?? []}
        actorName={actorName}
        onChange={(integrationId, connectionIds) =>
          setPicks(
            withConnectionOverride({ connection_overrides: picks }, integrationId, connectionIds)
              .connection_overrides ?? {},
          )
        }
      />
      <Button
        type="button"
        disabled={update.isPending}
        onClick={() => update.mutate(scheduleRefusalAnswerPayload(sent, picks))}
      >
        {t("schedule.settings.saveWithConnections")}
      </Button>
    </div>
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
      tab="settings"
      label={t("schedule.tabSettings")}
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
  const active = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];
  const write = useScheduleWrite(schedule);
  // Read alongside the write's facts, not once the section mounts: the agent-bound sections
  // wait for it under the same skeleton.
  const formDeps = useScheduleFormDeps(schedule.packageId);
  const agentBound =
    active.id !== "general" && active.id !== "recurrence" && active.id !== "identity";
  const formDepsSettled = !agentBound || !!formDeps.deps || !!formDeps.error || formDeps.denied;
  // The section the last field write came from: its state is that section's to say.
  const [writtenFrom, setWrittenFrom] = useState<ScheduleSettingsSection | null>(null);
  const update: Save = {
    ...sectionWriteState(write, writtenFrom, active.id),
    mutate: (variables, options) => {
      setWrittenFrom(active.id);
      write.mutate(variables, options);
    },
  };
  // Moves write through their own: a field saved while a move is in flight
  // would take over the move's answer.
  const moveWrite = useScheduleWrite(schedule);
  const move = useScheduleMove(schedule, moveWrite);

  return (
    <section className="min-w-0 p-6">
      <SettingsHeading title={t(active.labelKey)} description={t(active.descriptionKey)} />
      {/* Same tabs and sections for every role: what a role does not allow
          is said where the controls would be. */}
      {!mayWrite ? (
        <RoleLimitNotice>
          {t(can("schedules:write") ? "schedule.memberGoverned" : "schedule.settings.roleLimit")}
        </RoleLimitNotice>
      ) : (
        <>
          <RefusedWriteAnswer schedule={schedule} update={write} />
          <RefusedWriteAnswer schedule={schedule} update={moveWrite} />
          {/* Every control writes: none is offered before its write can name the
              connections the server re-checks. */}
          {update.ready && formDepsSettled ? (
            <SectionBody
              section={active.id}
              schedule={schedule}
              update={update}
              moveWrite={moveWrite}
              move={move}
              formDeps={formDeps}
            />
          ) : (
            <SettingsSkeleton />
          )}
        </>
      )}
    </section>
  );
}

interface SectionWrites {
  schedule: Schedule;
  update: Save;
  moveWrite: Save;
  move: ScheduleMove;
  /** The agent's settings, already read by the tab. */
  formDeps: ReturnType<typeof useScheduleFormDeps>;
}

function SectionBody({ section, ...writes }: SectionWrites & { section: ScheduleSettingsSection }) {
  const { schedule, update } = writes;
  if (section === "general") return <GeneralSection schedule={schedule} update={update} />;
  if (section === "recurrence") return <RecurrenceSection schedule={schedule} update={update} />;
  if (section === "identity") return <IdentitySection {...writes} />;
  return <AgentBoundSection section={section} {...writes} />;
}

// ─── Général ─────────────────────────────────────────────

function GeneralSection({ schedule, update }: { schedule: Schedule; update: Save }) {
  const { t } = useTranslation(["agents"]);
  const agentsQuery = useAgents();
  const agent = agentsQuery.data?.find((a) => a.id === schedule.packageId);
  const agentPending = isQueryInFlight(agentsQuery);
  return (
    <>
      <SettingRow
        label={t("schedule.name")}
        status={
          <SaveFeedback
            pending={update.isPending}
            success={update.isSuccess}
            error={update.isError}
          />
        }
      >
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
          {agentPending ? (
            <Skeleton className="size-11 shrink-0 rounded-xl" />
          ) : (
            <PackageIcon
              type="agent"
              icon={agent?.icon}
              color={agent?.color}
              className="size-11 rounded-xl"
              iconClassName="size-5"
            />
          )}
          <span className="min-w-0 flex-1">
            {agentPending ? (
              <>
                <Skeleton className="h-4 w-32" />
                <Skeleton className="mt-1.5 h-3 w-48 max-w-full" />
              </>
            ) : (
              <>
                <span className="block text-sm font-medium">
                  {agent?.display_name || schedule.packageId}
                </span>
                {agent?.description && (
                  <span className="text-muted-foreground block truncate text-xs">
                    {agent.description}
                  </span>
                )}
              </>
            )}
          </span>
          <ArrowRight className="text-muted-foreground size-4 shrink-0" aria-hidden />
        </Link>
      </SettingRow>
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

function IdentitySection({ schedule, moveWrite, move }: SectionWrites) {
  const { t } = useTranslation(["agents"]);
  const stored = storedActor(schedule);
  const actor = shownMove(schedule, move, moveWrite).actor ?? stored;

  return (
    <>
      <SettingRow label={t("schedule.actorTitle")} description={t("schedule.actorHint")}>
        <ActorSelect
          value={actor}
          disabled={move.held !== null}
          onChange={(next) => {
            const nextActor = next ?? stored;
            // Back on the stored identity nothing moves, and a refusal spoken for another is stale.
            if (sameActor(nextActor, stored)) return moveWrite.reset();
            move.request({ actor: nextActor });
          }}
        />
      </SettingRow>
      {/* A refusal other than over connections puts the field back and is toasted: no « Erreur
          d'enregistrement » under a field that shows the stored value. */}
      <SaveFeedback pending={moveWrite.isPending} success={moveWrite.isSuccess} error={false} />
    </>
  );
}

// ─── Sections that read the agent ────────────────────────

function AgentBoundSection({
  section,
  ...writes
}: SectionWrites & { section: "inputs" | "execution" | "connections" }) {
  const { schedule, update, formDeps } = writes;
  const { deps, error, denied } = formDeps;
  if (error) return <ErrorState error={error} />;
  if (denied) return <NoAccessState />;
  if (!deps) return <SettingsSkeleton />;
  // Keyed on the schedule: each section seeds its local state once.
  if (section === "inputs")
    return <InputsSection key={schedule.id} schedule={schedule} deps={deps} update={update} />;
  if (section === "execution")
    return <ExecutionSection key={schedule.id} deps={deps} {...writes} />;
  return <ConnectionsSection {...writes} />;
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
  moveWrite,
  move,
}: SectionWrites & { deps: Deps }) {
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
    (next) => update.mutate({ id: schedule.id, ...scheduleExecutionPayload(next) }),
    () => setEdited(false),
  );
  const storedVersion = schedule.version_override ?? VERSION_INHERIT;
  const moving = shownMove(schedule, move, moveWrite).versionOverride;
  const version = moving === undefined ? storedVersion : (moving ?? VERSION_INHERIT);

  return (
    <>
      <SettingRow
        label={t("run.overrides.versionLabel")}
        description={t("schedule.settings.versionHint")}
        status={
          <SaveFeedback
            pending={moveWrite.isPending}
            success={moveWrite.isSuccess}
            error={moveWrite.isError}
          />
        }
      >
        <PackageVersionSelect
          type="agent"
          packageId={schedule.packageId}
          value={version}
          disabled={move.held !== null}
          // Only a real change is sent: naming the working copy is an author's
          // act the route judges (403 `draft_not_writable`), and echoing the
          // stored value back would claim it for whoever touched the select.
          onChange={(next) => {
            if (next === version) return;
            // Back on the stored version nothing moves, and a refusal spoken for another is stale.
            if (next === storedVersion) return moveWrite.reset();
            move.request({ versionOverride: next === VERSION_INHERIT ? null : next });
          }}
          leadingOptions={scheduleVersionOptions(t, {
            draftOffered: deps.homeWritable || version === "draft",
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
        value={overrides}
        onChange={(next) => {
          setOverrides(next);
          setEdited(true);
        }}
        version={firedVersion(schedule.version_override)}
      />
      <SaveFeedback pending={update.isPending} success={update.isSuccess} error={update.isError} />
    </>
  );
}

// ─── Connexions ──────────────────────────────────────────

function ConnectionsSection({ schedule, update, moveWrite }: SectionWrites) {
  const { t } = useTranslation(["agents"]);
  const actor = storedActor(schedule);
  const version = firedVersion(schedule.version_override);
  const fired = usePackageDetail("agent", schedule.packageId, { version });
  const integrations = fired.data?.dependencies.integrations;
  const picks = schedule.connection_overrides ?? {};
  // The pickers judge the VIEWER's connections: the agent's table speaks only
  // for a schedule that runs as the viewer. Another actor's connections are
  // named from the candidates the server offers when it refuses a write.
  const actorIsViewer = useIsViewer(actor);

  // An open refusal is answered above by re-sending the refused write: a pick sent on its own
  // would drop that write, and be judged against the stored version's integrations.
  if (openRefusal(schedule, update) || openRefusal(schedule, moveWrite)) return null;

  const pick = (integrationId: string, connectionIds: ConnectionSet) =>
    update.mutate({
      id: schedule.id,
      ...scheduleConnectionPickPayload({
        ...update.fired,
        picks: schedule.connection_overrides ?? null,
        integrationId,
        connectionIds,
      }),
    });

  if (fired.error) return <ErrorState error={fired.error} />;
  if (!integrations) return <SettingsSkeleton rows={2} />;
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
      scheduleOverrides={{ value: picks, onChange: pick, version }}
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
