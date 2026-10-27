// SPDX-License-Identifier: Apache-2.0

import { useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { FormModal } from "./form-modal";
import { AgentInputForm, type AgentInputFormHandle } from "./agent-input-form";
import { initialInputValues } from "../lib/agent-input";
import { useModels, useAgentModel } from "../hooks/use-models";
import { isModelSelectable } from "@appstrate/core/model-selectable";
import { isModelPinUnavailable } from "../lib/model-selectability";
import { ModelBillingHint } from "./model-billing-hint";
import type { AgentDetail } from "@appstrate/shared-types";

interface RunModalProps {
  open: boolean;
  onClose: () => void;
  agent: AgentDetail;
  onSubmit: (input: Record<string, unknown>) => void;
  isPending?: boolean;
  initialInput?: Record<string, unknown>;
}

/** Mounted afresh at each opening, so the fields seed from the agent again. */
export function RunModal({ open, ...props }: RunModalProps) {
  return open ? <RunModalForm {...props} /> : null;
}

function RunModalForm({
  onClose,
  agent,
  onSubmit,
  isPending,
  initialInput,
}: Omit<RunModalProps, "open">) {
  const { t } = useTranslation(["agents"]);
  const inputRef = useRef<AgentInputFormHandle>(null);
  // `agent.input` carries both halves: the AFPS wrapper and this space's
  // stored values + locks.
  const [inputData, setInputData] = useState<Record<string, unknown>>(() =>
    initialInputValues(agent.input, agent.input, initialInput),
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (inputRef.current?.validate() ?? true) onSubmit(inputData);
  };

  return (
    <FormModal
      onClose={onClose}
      title={t("input.title", { name: agent.display_name })}
      onSubmit={submit}
      isPending={isPending}
      submitLabel={t("input.run")}
    >
      <ResolvedModelHint packageId={agent.id} />
      <AgentInputForm
        ref={inputRef}
        wrapper={agent.input}
        settings={agent.input}
        value={inputData}
        onChange={setInputData}
      />
    </FormModal>
  );
}

/**
 * Resolved-model transparency line — mirrors the server's resolution
 * cascade (agent model setting > org default) so the user sees which model
 * the run will use BEFORE triggering. The org default is resolved at run
 * creation, so a default changed mid-session silently applies to the next
 * run — this line makes that visible at trigger time. A stale agent pin
 * (model deleted/disabled/on a dead credential) falls back to the org default,
 * matching `resolveModel` server-side.
 */
function ResolvedModelHint({ packageId }: { packageId: string }) {
  const { t } = useTranslation(["agents"]);
  const { data: orgModels } = useModels();
  const { data: agentModel } = useAgentModel(packageId);

  if (!orgModels || orgModels.length === 0) return null;

  // Candidates are found WITHOUT the selectability filter, then filtered — so
  // when the cascade resolves to nothing we still know which model failed it,
  // instead of rendering an empty line for a run that is about to fail.
  const pinnedCandidate = agentModel?.modelId
    ? orgModels.find((m) => m.id === agentModel.modelId)
    : undefined;
  const defaultCandidate = orgModels.find((m) => m.is_default);
  const pinned =
    pinnedCandidate && isModelSelectable(pinnedCandidate) ? pinnedCandidate : undefined;
  const resolved =
    pinned ??
    (defaultCandidate && isModelSelectable(defaultCandidate) ? defaultCandidate : undefined);

  if (!resolved) {
    // Only a dead credential earns a line. A merely disabled candidate renders
    // nothing, as before — the message names the credential as the cause and
    // would be a false statement for a healthy model that is switched off.
    const dead = [defaultCandidate, pinnedCandidate].find((m) => m?.needs_reconnection);
    if (!dead) return null;
    return (
      <p className="text-destructive text-xs" data-testid="run-resolved-model">
        {t("input.modelUnavailable", { name: dead.label })}
      </p>
    );
  }

  const source = pinned ? t("input.modelSourceAgent") : t("input.modelSourceOrgDefault");

  return (
    <div className="flex flex-col gap-1">
      <p className="text-muted-foreground text-xs" data-testid="run-resolved-model">
        {t("input.modelResolved", { name: resolved.label, source })}{" "}
        <ModelBillingHint billedTo={resolved.billed_to} />
      </p>
      {isModelPinUnavailable(orgModels, agentModel?.modelId) && (
        <p className="text-warning text-xs" data-testid="run-model-pin-unavailable">
          {t("input.modelPinUnavailable")}
        </p>
      )}
    </div>
  );
}
