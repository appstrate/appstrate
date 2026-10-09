// SPDX-License-Identifier: Apache-2.0

/**
 * Creating a schedule: a small object, so a modal (like a model or a webhook),
 * not a page (like a package). It asks only what a schedule needs to exist —
 * the agent, a name, when it fires, the inputs the agent asks for — and the
 * schedule's Paramètres tab takes the rest (identity, version, model, proxy,
 * connections).
 *
 * Opened from anywhere by the `newSchedule` URL parameter (`useModalParam`),
 * carrying the agent to preselect or `1` for none: the schedules list, an
 * agent's page and its settings all open the same modal. The agent map embeds
 * the form itself, its agent fixed.
 */

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { ScheduleWireDto } from "@appstrate/shared-types";
import { Button } from "@appstrate/ui/components/button";
import { Field, FieldGroup } from "@appstrate/ui/components/field";
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
import { AgentInputForm } from "./agent-input-form";
import { FrequencyComposer } from "./frequency-composer";
import { ScheduleActorConnectionChoice } from "./schedule-actor-connection-choice";
import { ErrorState, LoadingState } from "./page-states";
import { useModalParam } from "../hooks/use-modal-param";
import { usePermissions } from "../hooks/use-permissions";
import { useAgents } from "../hooks/use-packages";
import { useCreateSchedule, useScheduleFormDeps } from "../hooks/use-schedules";
import { changedInputValues, hasInputFields, initialInputValues } from "../lib/agent-input";
import { scheduleConnectionChoices } from "../lib/connection-choice";
import { withConnectionOverride } from "../lib/connection-set";
import { browserTimezone } from "../lib/cron-frequency";

/** The URL parameter that opens the modal; its value is the agent to preselect, or `1`. */
export const NEW_SCHEDULE_PARAM = "newSchedule";

/** A new schedule's first rhythm: weekdays at 9. */
const DEFAULT_CRON = "0 9 * * 1-5";

/** Mounted once in the shell: the modal answers the parameter on any page. */
export function NewScheduleModalHost() {
  const { t } = useTranslation(["agents"]);
  const navigate = useNavigate();
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
        onCreated={(schedule) => navigate(`/schedules/${schedule.id}`)}
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

function ScheduleFieldsReady({
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
  const create = useCreateSchedule(agentId);
  const wrapper = deps.inputWrapper;
  const [name, setName] = useState("");
  const [cron, setCron] = useState<string | null>(DEFAULT_CRON);
  const [timezone, setTimezone] = useState(browserTimezone);
  // Seeded from the agent's resolved values; only what differs is sent, so a
  // later change of the agent's own value still reaches every fire.
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    initialInputValues(wrapper, wrapper, undefined),
  );
  // A scheduled fire cannot ask which connection to use: when the server
  // refuses over it, the choice is made here, in the same write.
  const choices = scheduleConnectionChoices(create.error);
  const [picks, setPicks] = useState<Record<string, string[]>>({});

  const submit = () => {
    if (!cron) return;
    create.mutate(
      {
        ...(name.trim() ? { name: name.trim() } : {}),
        cron_expression: cron,
        timezone,
        input: changedInputValues(wrapper, wrapper, values),
        ...(Object.keys(picks).length > 0 ? { connection_overrides: picks } : {}),
      },
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
      {choices.length > 0 && (
        <ScheduleActorConnectionChoice
          choices={choices}
          value={picks}
          onChange={(integrationId, connectionIds) =>
            setPicks(
              withConnectionOverride({ connection_overrides: picks }, integrationId, connectionIds)
                .connection_overrides ?? {},
            )
          }
        />
      )}
      <p className="text-muted-foreground text-xs">{t("schedule.newHint")}</p>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          {t("btn.cancel")}
        </Button>
        <Button type="submit" disabled={!cron || create.isPending}>
          {t("btn.create")}
        </Button>
      </div>
    </form>
  );
}
