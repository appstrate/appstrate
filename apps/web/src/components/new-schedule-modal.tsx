// SPDX-License-Identifier: Apache-2.0

/**
 * Creating a schedule: a small object, so a modal (like a model or a webhook),
 * not a page (like a package). It asks what a schedule needs to exist — the
 * agent, a name, when it fires, the inputs the agent asks for — and, folded,
 * what may decide whether it can be created at all: who it runs as, the
 * version (an agent never published fires only its draft), the model (one
 * no organization credential serves is refused) and the connections.
 *
 * Opened from anywhere by the `newSchedule` URL parameter (`useModalParam`),
 * carrying the agent to preselect or `1` for none: the schedules list, an
 * agent's page and its settings all open the same modal. The agent map embeds
 * the form itself, its agent fixed.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import type { ScheduleWireDto } from "@appstrate/shared-types";
import { cn } from "@appstrate/ui/cn";
import { Button } from "@appstrate/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@appstrate/ui/components/collapsible";
import { Field, FieldDescription, FieldGroup } from "@appstrate/ui/components/field";
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@appstrate/ui/components/select";
import { Modal } from "./modal";
import { ActorSelect } from "./actor-select";
import { AgentInputForm } from "./agent-input-form";
import { FrequencyComposer } from "./frequency-composer";
import { AgentVersionField } from "./package-version-select";
import { RunOverridesPanel } from "./run-overrides-panel";
import { ScheduleActorConnectionChoice } from "./schedule-actor-connection-choice";
import { ScheduleConnectionAnswer } from "./schedule-connection-answer";
import { ErrorState, LoadingState } from "./page-states";
import { useActorName } from "../hooks/use-actor-name";
import { useAuth } from "../hooks/use-auth";
import { useModalParam } from "../hooks/use-modal-param";
import { usePermissions } from "../hooks/use-permissions";
import { useAgentConnectionReadiness } from "../hooks/use-integrations";
import { useAgents, usePackageDetail } from "../hooks/use-packages";
import { useCreateSchedule, useScheduleFormDeps } from "../hooks/use-schedules";
import { changedInputValues, hasInputFields, initialInputValues } from "../lib/agent-input";
import {
  type SubmittedPicks,
  picksAfterActorChange,
  refusalForActor,
  scheduleConnectionChoices,
  withConnectionPickAs,
} from "../lib/connection-choice";
import type { ConnectionSet } from "../lib/connection-set";
import {
  type ActorValue,
  type RunOverridesValue,
  sameActor,
  scheduleCreatePayload,
} from "../lib/schedule-payload";
import { VERSION_INHERIT } from "../lib/schedule-options";
import { scheduleDetailPath } from "../lib/package-paths";
import { VERSION_PUBLISHED } from "../lib/version-selector";

/** The URL parameter that opens the modal; its value is the agent to preselect, or `1`. */
export const NEW_SCHEDULE_PARAM = "newSchedule";

/** A new schedule's first rhythm: every day at 9, in UTC. */
const DEFAULT_CRON = "0 9 * * *";
const DEFAULT_TIMEZONE = "UTC";

/** Mounted once in the shell: the modal answers the parameter on any page. */
export function NewScheduleModalHost() {
  const { t } = useTranslation(["agents"]);
  const { can } = usePermissions();
  const param = useModalParam(NEW_SCHEDULE_PARAM);
  if (!param.value || !can("schedules:write")) return null;
  return (
    <Modal
      open
      onClose={param.close}
      title={t("schedule.titleNew")}
      className="max-h-[90svh] overflow-y-auto sm:max-w-xl"
    >
      <NewScheduleForm
        initialAgentId={param.value === "1" ? undefined : param.value}
        onCancel={param.close}
        onCreated={(schedule) => param.leave(scheduleDetailPath(schedule.id))}
      />
    </Modal>
  );
}

/**
 * The form itself. `fixedAgent` hides the agent selector: the agent map creates
 * a schedule for the agent it shows, never another one.
 */
export function NewScheduleForm({
  initialAgentId,
  fixedAgent = false,
  onCreated,
  onCancel,
}: {
  initialAgentId?: string;
  fixedAgent?: boolean;
  onCreated: (schedule: ScheduleWireDto) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation(["agents"]);
  const { data: agents } = useAgents();
  const [picked, setPicked] = useState<string | undefined>(initialAgentId);
  const agentId = picked ?? agents?.[0]?.id;

  return (
    <div className="space-y-5">
      {!fixedAgent && (
        <Field>
          <Label htmlFor="new-schedule-agent">{t("schedule.agent")}</Label>
          <Select value={agentId ?? ""} onValueChange={setPicked}>
            <SelectTrigger id="new-schedule-agent">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(agents ?? []).map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>
                  {agent.display_name ?? agent.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}
      {agentId ? (
        // A new agent, a new form: its inputs and connections are another agent's.
        <ScheduleFields key={agentId} agentId={agentId} onCreated={onCreated} onCancel={onCancel} />
      ) : (
        agents && <p className="text-muted-foreground text-sm">{t("schedule.noAgent")}</p>
      )}
    </div>
  );
}

function ScheduleFields({
  agentId,
  onCreated,
  onCancel,
}: {
  agentId: string;
  onCreated: (schedule: ScheduleWireDto) => void;
  onCancel: () => void;
}) {
  // The form seeds its inputs once: it waits for the agent detail, or a field
  // locked since would be seeded and refused (400 `locked_input_field`).
  const { deps, error } = useScheduleFormDeps(agentId);
  if (error) return <ErrorState error={error} />;
  if (!deps) return <LoadingState />;
  return (
    <ScheduleFieldsReady deps={deps} agentId={agentId} onCreated={onCreated} onCancel={onCancel} />
  );
}

export function ScheduleFieldsReady({
  deps,
  agentId,
  onCreated,
  onCancel,
}: {
  deps: NonNullable<ReturnType<typeof useScheduleFormDeps>["deps"]>;
  agentId: string;
  onCreated: (schedule: ScheduleWireDto) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const { user } = useAuth();
  const create = useCreateSchedule(agentId);
  const wrapper = deps.inputWrapper;
  const [name, setName] = useState("");
  const [cron, setCron] = useState<string | null>(DEFAULT_CRON);
  const [timezone, setTimezone] = useState(DEFAULT_TIMEZONE);
  // Seeded from the agent's resolved values; only what differs is sent, so a
  // later change of the agent's own value still reaches every fire.
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    initialInputValues(wrapper, wrapper, undefined),
  );
  // Who a fire runs as (`undefined`: the creator) and the overrides stored for it. One state:
  // the connection picks belong to the actor, so a write to either reads the other as it stands.
  const [{ actor, overrides }, setRun] = useState<{
    actor: ActorValue | undefined;
    overrides: RunOverridesValue;
  }>({ actor: undefined, overrides: {} });
  // `undefined`: inherit, the latest published version at every fire.
  const [versionOverride, setVersionOverride] = useState<string | undefined>();
  const [optionsOpen, setOptionsOpen] = useState(false);

  const creator: ActorValue | undefined = user ? { userId: user.id } : undefined;
  const runsAs = actor ?? creator;
  const runsAsViewer = !!user && sameActor(runsAs, { userId: user.id });
  const actorName = useActorName(runsAs);
  const firedVersion = versionOverride ?? VERSION_PUBLISHED;
  // Its `required` flags tell which integrations may run with "Aucune connexion".
  const firedIntegrations = usePackageDetail("agent", agentId, { version: firedVersion }).data
    ?.dependencies.integrations;
  // The server takes no fallback for an enabled schedule, so the connection the viewer's fallback
  // binds is named in the write — from their own verdict, asked only when the fires run as them.
  const { data: readiness, isLoading: readinessLoading } = useAgentConnectionReadiness(
    runsAsViewer ? agentId : undefined,
    firedVersion,
  );
  const picks = overrides.connection_overrides ?? {};

  // A scheduled fire cannot ask which connection to use: a refusal over it is answered here, in
  // the same write. It speaks for the identity it was sent for, stale once the actor moves.
  const [submitted, setSubmitted] = useState<SubmittedPicks | null>(null);
  const refused = refusalForActor(scheduleConnectionChoices(create.error), submitted, runsAs);

  const changeActor = (next: ActorValue | undefined) =>
    setRun((prev) => {
      const { connection_overrides: prevPicks, ...rest } = prev.overrides;
      const kept = picksAfterActorChange({
        picks: prevPicks,
        runsAs: prev.actor ?? creator,
        nextRunsAs: next ?? creator,
        stored: null,
      });
      return { actor: next, overrides: kept ? { ...rest, connection_overrides: kept } : rest };
    });
  const setConnectionPick = (integrationId: string, connectionIds: ConnectionSet) =>
    setRun((prev) => ({
      ...prev,
      overrides: withConnectionPickAs(prev.overrides, {
        pickedAs: runsAs,
        runsAs: prev.actor ?? creator,
        integrationId,
        connectionIds,
      }),
    }));

  const submit = () => {
    if (!cron) return;
    setSubmitted({ runsAs, picks });
    create.mutate(
      scheduleCreatePayload({
        overrides,
        runsAsViewer,
        viewerReadiness: readiness?.integrations,
        declared: firedIntegrations?.map((i) => i.id),
        name,
        cron_expression: cron,
        timezone,
        input: changedInputValues(wrapper, wrapper, values),
        versionOverride,
        actor,
      }),
      { onSuccess: onCreated },
    );
  };

  if (deps.hasFileInputs) {
    return <p className="text-muted-foreground text-sm">{t("schedule.fileInputBlocked")}</p>;
  }

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <FieldGroup className="gap-5">
        <Field>
          <Label htmlFor="new-schedule-name">{t("schedule.name")}</Label>
          <Input
            id="new-schedule-name"
            value={name}
            placeholder={t("schedule.namePlaceholder")}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
      </FieldGroup>
      <FrequencyComposer
        cron={DEFAULT_CRON}
        timezone={timezone}
        onChange={setCron}
        onTimezoneChange={setTimezone}
      />
      {hasInputFields(wrapper) && (
        <Field>
          <Label>{t("schedule.inputTitle")}</Label>
          <AgentInputForm
            wrapper={wrapper}
            settings={wrapper}
            value={values}
            onChange={setValues}
          />
        </Field>
      )}
      {/* Open while a refusal speaks for this actor: answering it may mean changing them. */}
      <Collapsible open={optionsOpen || refused.length > 0} onOpenChange={setOptionsOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="text-foreground hover:bg-muted/50 border-border flex w-full items-center justify-between rounded-md border border-dashed px-3 py-2 text-sm font-medium transition-colors"
          >
            <span>{t("schedule.optionsTitle")}</span>
            <ChevronDown
              className={cn(
                "text-muted-foreground size-4 transition-transform",
                (optionsOpen || refused.length > 0) && "rotate-180",
              )}
            />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-4 pt-3">
          <Field>
            <Label>{t("schedule.actorTitle")}</Label>
            <ActorSelect
              value={actor}
              onChange={changeActor}
              placeholder={t("schedule.actorDefaultSelf")}
            />
            <FieldDescription>{t("schedule.actorHint")}</FieldDescription>
          </Field>
          <AgentVersionField
            packageId={agentId}
            label={t("run.overrides.versionLabel")}
            value={versionOverride ?? VERSION_INHERIT}
            onChange={(next) => setVersionOverride(next === VERSION_INHERIT ? undefined : next)}
            leadingOptions={[
              { value: VERSION_INHERIT, label: t("run.overrides.versionPublished") },
              // The working copy is its writers' to run: anyone else would be refused at every
              // fire (403 `draft_not_writable`).
              ...(deps.homeWritable
                ? [{ value: "draft", label: t("run.overrides.versionDraft") }]
                : []),
            ]}
          />
          <RunOverridesPanel
            packageId={agentId}
            persistedModelId={deps.persistedModelId}
            persistedGenerationConfig={deps.persistedGenerationConfig}
            persistedProxyId={deps.persistedProxyId}
            {...(runsAsViewer && firedIntegrations ? { agentIntegrations: firedIntegrations } : {})}
            value={overrides}
            onChange={(next) => setRun((prev) => ({ ...prev, overrides: next }))}
            onConnectionPick={setConnectionPick}
            version={firedVersion}
            scheduled
          />
          {/* Fires running as someone else: the panel's pickers would judge the viewer's
              connections. A refusal is answered below the options. */}
          {!runsAsViewer &&
            refused.length === 0 &&
            ((firedIntegrations?.length ?? 0) > 0 || Object.keys(picks).length > 0) && (
              <ScheduleActorConnectionChoice
                choices={[]}
                integrations={firedIntegrations ?? []}
                value={picks}
                onChange={setConnectionPick}
              />
            )}
        </CollapsibleContent>
      </Collapsible>
      {refused.length > 0 && (
        <ScheduleConnectionAnswer
          choices={refused}
          submitted={submitted?.picks ?? {}}
          value={picks}
          integrations={firedIntegrations ?? []}
          actorName={actorName}
          onChange={setConnectionPick}
        />
      )}
      <p className="text-muted-foreground text-xs">{t("schedule.newHint")}</p>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          {t("btn.cancel")}
        </Button>
        <Button type="submit" disabled={!cron || create.isPending || readinessLoading}>
          {t("btn.create")}
        </Button>
      </div>
    </form>
  );
}
