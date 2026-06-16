// SPDX-License-Identifier: Apache-2.0

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
import { RunOverridesPanel, type RunOverridesValue } from "./run-overrides-panel";
import { DependencyOverridesSection } from "./dependency-overrides-section";
import { useScheduleFormDeps } from "../hooks/use-schedules";
import type { AgentDetail } from "@appstrate/shared-types";

/**
 * Everything the modal collects, mapped 1:1 onto the run API body by the
 * caller: `overrides` carries the schedule-shaped override delta (version,
 * model, proxy, config, connections — reused from `RunOverridesPanel`),
 * `dependencyOverrides` the per-skill `dependency_overrides` map.
 */
export interface RunWithOptionsSubmit {
  input: Record<string, unknown>;
  overrides: RunOverridesValue;
  dependencyOverrides: Record<string, string>;
}

interface RunWithOptionsModalProps {
  open: boolean;
  onClose: () => void;
  agent: AgentDetail;
  onSubmit: (payload: RunWithOptionsSubmit) => void;
  isPending?: boolean;
}

const EMPTY_SCHEMA: JSONSchemaObject = { type: "object", properties: {} };

/**
 * "Run with options" — the advanced run launcher. Surfaces every per-run
 * override the run API accepts (input, version, model, proxy, config,
 * connection overrides, and per-skill dependency overrides), so the dashboard
 * reaches parity with a hand-built run POST. Composed from existing pieces:
 * the input SchemaForm (as in `RunModal`), `RunOverridesPanel` (the schedule
 * editor's override surface), and the per-skill `DependencyOverridesSection`.
 */
export function RunWithOptionsModal({
  open,
  onClose,
  agent,
  onSubmit,
  isPending,
}: RunWithOptionsModalProps) {
  const { t } = useTranslation(["agents", "common"]);
  const guardedClose = () => {
    if (!isPending) onClose();
  };
  return (
    <Modal
      open={open}
      onClose={guardedClose}
      title={t("run.options.title", { name: agent.display_name })}
      actions={null}
    >
      {open && (
        <RunWithOptionsForm
          agent={agent}
          onClose={guardedClose}
          onSubmit={onSubmit}
          isPending={isPending}
        />
      )}
    </Modal>
  );
}

function RunWithOptionsForm({
  agent,
  onClose,
  onSubmit,
  isPending,
}: {
  agent: AgentDetail;
  onClose: () => void;
  onSubmit: (payload: RunWithOptionsSubmit) => void;
  isPending?: boolean;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const deps = useScheduleFormDeps(agent.id);
  const labels = useSchemaFormLabels();
  const [inputData, setInputData] = useState<Record<string, unknown>>({});
  const [overrides, setOverrides] = useState<RunOverridesValue>({});
  const [dependencyOverrides, setDependencyOverrides] = useState<Record<string, string>>({});
  const inputFormRef = useRef<RjsfForm>(null);

  const inputWrapper: SchemaWrapper = agent.input ?? { schema: EMPTY_SCHEMA };
  const hasInputFields =
    !!inputWrapper.schema?.properties && Object.keys(inputWrapper.schema.properties).length > 0;
  const skills = agent.dependencies?.skills ?? [];

  const fire = (input: Record<string, unknown>) =>
    onSubmit({ input, overrides, dependencyOverrides });

  const handleSubmit = () => {
    // Route through rjsf validation first when the agent declares input —
    // its onSubmit fires `fire(formData)` with the validated payload.
    if (hasInputFields && inputFormRef.current) {
      inputFormRef.current.submit();
      return;
    }
    fire(inputData);
  };

  return (
    <div className="space-y-5">
      {hasInputFields && (
        <div className="space-y-2">
          <SchemaForm
            ref={inputFormRef}
            wrapper={inputWrapper}
            formData={inputData}
            upload={uploadClient}
            labels={labels}
            onChange={(e) => setInputData(e.formData as Record<string, unknown>)}
            onSubmit={(e) => fire(e.formData as Record<string, unknown>)}
          />
        </div>
      )}

      {deps && (
        <RunOverridesPanel
          packageId={agent.id}
          configSchema={deps.configSchema}
          persistedConfig={deps.persistedConfig}
          persistedModelId={deps.persistedModelId}
          persistedProxyId={deps.persistedProxyId}
          persistedVersion={deps.persistedVersion}
          agentIntegrations={deps.agentIntegrations}
          value={overrides}
          onChange={setOverrides}
        />
      )}

      <DependencyOverridesSection
        skills={skills}
        value={dependencyOverrides}
        onChange={setDependencyOverrides}
      />

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
