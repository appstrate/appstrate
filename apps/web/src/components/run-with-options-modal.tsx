// SPDX-License-Identifier: Apache-2.0

import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type RjsfForm from "@rjsf/core";
import { Modal } from "./modal";
import { Button } from "@appstrate/ui/components/button";
import { Spinner } from "./spinner";
import { LazySchemaForm as SchemaForm } from "./lazy-schema-form";
import type { SchemaWrapper, JSONSchemaObject } from "@appstrate/core/form";
import { useSchemaFormLabels } from "../hooks/use-schema-form-labels";
import { uploadClient } from "../api/uploads";
import { RunOverridesPanel, type RunOverridesValue } from "./run-overrides-panel";
import { AgentVersionField } from "./package-version-select";
import { DependencyOverridesSection } from "./dependency-overrides-section";
import { useScheduleFormDeps } from "../hooks/use-schedules";
import type { AgentDetail } from "@appstrate/shared-types";

/**
 * Everything the modal collects, mapped 1:1 onto the run API body by the
 * caller: `version` rides the `?version=` query; `overrides` carries the
 * schedule-shaped delta for model / proxy / config / connections (reused from
 * `RunOverridesPanel`); `dependencyOverrides` the per-skill
 * `dependency_overrides` map. Defaults across the board mirror plain "Lancer".
 */
export interface RunWithOptionsSubmit {
  input: Record<string, unknown>;
  version: string;
  overrides: RunOverridesValue;
  dependencyOverrides: Record<string, string>;
}

/**
 * Default version selector — `draft` (the working copy), matching the plain
 * "Lancer" button. The dashboard's run path forces `?version=draft` rather than
 * omitting it (`useRunAgent`), so the editor always runs the draft regardless
 * of the server's published-by-default for API/MCP callers (#636).
 */
const DEFAULT_VERSION = "draft";

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
  const [inputData, setInputData] = useState<Record<string, unknown>>({});
  const [version, setVersion] = useState<string>(DEFAULT_VERSION);
  const [overrides, setOverrides] = useState<RunOverridesValue>({});
  const [dependencyOverrides, setDependencyOverrides] = useState<Record<string, string>>({});
  const inputFormRef = useRef<RjsfForm>(null);
  // Deps follow the selected version (#770): the config / input / integrations /
  // skills the modal renders match what the run will execute, not the draft.
  const deps = useScheduleFormDeps(agent.id, version);
  const labels = useSchemaFormLabels();

  // Version-pinned input wrapper / skills (fall back to the draft props the
  // parent passed while the version-aware detail is still loading).
  const inputWrapper: SchemaWrapper = deps?.inputWrapper ?? agent.input ?? { schema: EMPTY_SCHEMA };
  const hasInputFields =
    !!inputWrapper.schema?.properties && Object.keys(inputWrapper.schema.properties).length > 0;
  const skills = deps?.skills ?? agent.dependencies?.skills ?? [];

  const fire = (input: Record<string, unknown>) =>
    onSubmit({ input, version, overrides, dependencyOverrides });

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

      {/* Run version — default `draft` (= plain "Lancer", which forces draft).
          The only leading option is `draft`; a run has no schedule-style
          "inherit" to defer to. Any published version is an explicit pick,
          applied verbatim. */}
      <AgentVersionField
        packageId={agent.id}
        label={t("run.overrides.versionLabel")}
        value={version}
        onChange={setVersion}
        leadingOptions={[{ value: DEFAULT_VERSION, label: t("run.overrides.versionDraft") }]}
      />

      {deps && (
        <RunOverridesPanel
          packageId={agent.id}
          configSchema={deps.configSchema}
          persistedConfig={deps.persistedConfig}
          persistedModelId={deps.persistedModelId}
          persistedProxyId={deps.persistedProxyId}
          agentIntegrations={deps.agentIntegrations}
          value={overrides}
          onChange={setOverrides}
          version={version}
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
