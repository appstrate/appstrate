import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type RjsfForm from "@rjsf/core";
import { Modal } from "./modal";
import { Button } from "@/components/ui/button";
import { Spinner } from "./spinner";
import { LazySchemaForm as SchemaForm } from "./lazy-schema-form";
import type { SchemaWrapper, JSONSchemaObject } from "@appstrate/core/form";
import { useSchemaFormLabels } from "../hooks/use-schema-form-labels";
import { uploadClient } from "../api/uploads";
import { useModels, useAgentModel } from "../hooks/use-models";
import type { AgentDetail } from "@appstrate/shared-types";

interface RunModalProps {
  open: boolean;
  onClose: () => void;
  agent: AgentDetail;
  onSubmit: (input: Record<string, unknown>) => void;
  isPending?: boolean;
  initialInput?: Record<string, unknown>;
}

const EMPTY_SCHEMA: JSONSchemaObject = { type: "object", properties: {} };

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
  const inputWrapper: SchemaWrapper = agent.input ?? { schema: EMPTY_SCHEMA };
  const hasInputFields =
    !!inputWrapper.schema?.properties && Object.keys(inputWrapper.schema.properties).length > 0;
  const [inputData, setInputData] = useState<Record<string, unknown>>(initialInput ?? {});
  const inputFormRef = useRef<RjsfForm>(null);
  const labels = useSchemaFormLabels();

  const handleSubmit = () => {
    if (hasInputFields && inputFormRef.current) {
      inputFormRef.current.submit();
      return;
    }
    onSubmit(inputData);
  };

  return (
    <div className="space-y-5">
      <ResolvedModelHint packageId={agent.id} />
      {hasInputFields && (
        <div className="space-y-2">
          <SchemaForm
            ref={inputFormRef}
            wrapper={inputWrapper}
            formData={inputData}
            upload={uploadClient}
            labels={labels}
            onChange={(e) => setInputData(e.formData as Record<string, unknown>)}
            onSubmit={(e) => onSubmit(e.formData as Record<string, unknown>)}
          />
        </div>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <Button variant="outline" onClick={onClose} disabled={isPending}>
          {t("btn.cancel")}
        </Button>
        <Button onClick={handleSubmit} disabled={isPending}>
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
 * (model deleted/disabled) falls back to the org default, matching
 * `resolveModel` server-side.
 */
function ResolvedModelHint({ packageId }: { packageId: string }) {
  const { t } = useTranslation(["agents"]);
  const { data: orgModels } = useModels();
  const { data: agentModel } = useAgentModel(packageId);

  if (!orgModels || orgModels.length === 0) return null;

  const pinned = agentModel?.modelId
    ? orgModels.find((m) => m.id === agentModel.modelId && m.enabled)
    : undefined;
  const resolved = pinned ?? orgModels.find((m) => m.isDefault && m.enabled);
  if (!resolved) return null;

  const source = pinned ? t("input.modelSourceAgent") : t("input.modelSourceOrgDefault");

  return (
    <p className="text-muted-foreground text-xs" data-testid="run-resolved-model">
      {t("input.modelResolved", { name: resolved.label, source })}
    </p>
  );
}
