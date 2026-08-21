import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "./modal";
import { Button } from "@appstrate/ui/components/button";
import { Spinner } from "./spinner";
import { AgentInputForm, type AgentInputFormHandle } from "./agent-input-form";
import { initialInputValues } from "../lib/agent-input";
import { useModels, useAgentModel } from "../hooks/use-models";
import { isModelSelectable } from "../lib/model-selectability";
import type { AgentDetail } from "@appstrate/shared-types";

interface RunModalProps {
  open: boolean;
  onClose: () => void;
  agent: AgentDetail;
  onSubmit: (input: Record<string, unknown>) => void;
  isPending?: boolean;
  initialInput?: Record<string, unknown>;
}

export function RunModal({
  open,
  onClose,
  agent,
  onSubmit,
  isPending,
  initialInput,
}: RunModalProps) {
  const { t } = useTranslation(["agents", "common"]);

  const guardedClose = () => {
    if (!isPending) onClose();
  };

  return (
    <Modal
      open={open}
      onClose={guardedClose}
      title={t("input.title", { name: agent.display_name })}
      actions={null}
    >
      {open && (
        <RunModalForm
          agent={agent}
          onClose={guardedClose}
          onSubmit={onSubmit}
          isPending={isPending}
          initialInput={initialInput}
        />
      )}
    </Modal>
  );
}

function RunModalForm({
  agent,
  onClose,
  onSubmit,
  isPending,
  initialInput,
}: {
  agent: AgentDetail;
  onClose: () => void;
  onSubmit: (input: Record<string, unknown>) => void;
  isPending?: boolean;
  initialInput?: Record<string, unknown>;
}) {
  const { t } = useTranslation(["agents", "common"]);
  // `agent.input` carries both halves: the AFPS wrapper and this application's
  // stored values + locks.
  const [inputData, setInputData] = useState<Record<string, unknown>>(() =>
    initialInputValues(agent.input, agent.input, initialInput),
  );
  const inputFormRef = useRef<AgentInputFormHandle>(null);

  return (
    <div className="space-y-5">
      <ResolvedModelHint packageId={agent.id} />
      <AgentInputForm
        ref={inputFormRef}
        wrapper={agent.input}
        settings={agent.input}
        value={inputData}
        onChange={setInputData}
        onSubmit={onSubmit}
      />

      <div className="flex justify-end gap-2 pt-1">
        <Button variant="outline" onClick={onClose} disabled={isPending}>
          {t("btn.cancel")}
        </Button>
        <Button onClick={() => inputFormRef.current?.submit()} disabled={isPending}>
          {isPending ? <Spinner /> : t("input.run")}
        </Button>
      </div>
    </div>
  );
}

/**
 * Resolved-model transparency line (#635) — mirrors the server's resolution
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
    <p className="text-muted-foreground text-xs" data-testid="run-resolved-model">
      {t("input.modelResolved", { name: resolved.label, source })}
    </p>
  );
}
