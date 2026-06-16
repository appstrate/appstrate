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
import { AgentVersionField } from "./package-version-select";
import { DependencyOverridesSection } from "./dependency-overrides-section";
import { useScheduleFormDeps } from "../hooks/use-schedules";
import type { AgentDetail } from "@appstrate/shared-types";

/**
 * Everything the modal collects, mapped 1:1 onto the run API body by the
 * caller: `version` rides the `?version=` query (`undefined` = omit it, so the
 * server applies the exact same default as the plain "Lancer" button — latest
 * published when one exists, draft otherwise, #636); `overrides` carries the
 * schedule-shaped delta for model / proxy / config / connections (reused from
 * `RunOverridesPanel`); `dependencyOverrides` the per-skill
 * `dependency_overrides` map. Defaults across the board mirror plain "Lancer".
 */
export interface RunWithOptionsSubmit {
  input: Record<string, unknown>;
  version: string | undefined;
  overrides: RunOverridesValue;
  dependencyOverrides: Record<string, string>;
}

/**
 * Sentinel for the default version choice. Selecting it sends NO `?version=`,
 * so the run inherits the server-side default — identical to the plain
 * "Lancer" button (#636), which also omits the query. Hardcoding `draft` here
 * would diverge for any agent that has a published version (plain "Lancer"
 * runs the latest published, not the working copy).
 */
const VERSION_DEFAULT = "__default__";

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
  const [version, setVersion] = useState<string>(VERSION_DEFAULT);
  const [overrides, setOverrides] = useState<RunOverridesValue>({});
  const [dependencyOverrides, setDependencyOverrides] = useState<Record<string, string>>({});
  const inputFormRef = useRef<RjsfForm>(null);

  const inputWrapper: SchemaWrapper = agent.input ?? { schema: EMPTY_SCHEMA };
  const hasInputFields =
    !!inputWrapper.schema?.properties && Object.keys(inputWrapper.schema.properties).length > 0;
  const skills = agent.dependencies?.skills ?? [];

  const fire = (input: Record<string, unknown>) =>
    onSubmit({
      input,
      // Default sentinel → omit version (server applies the plain-"Lancer"
      // default); any explicit pick (draft or a published version) is sent.
      version: version === VERSION_DEFAULT ? undefined : version,
      overrides,
      dependencyOverrides,
    });

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

      {/* Run version — semantics: the leading "Default" option (selected by
          default) omits `?version=`, so the server applies the same default as
          plain "Lancer" (latest published, or draft when none). `draft` and any
          published version are explicit picks, applied verbatim. This is the
          run-time analogue of the schedule's "inherit", resolved now (server
          default at submit) rather than per-fire. */}
      <AgentVersionField
        packageId={agent.id}
        label={t("run.overrides.versionLabel")}
        value={version}
        onChange={setVersion}
        leadingOptions={[
          { value: VERSION_DEFAULT, label: t("run.overrides.versionDefault") },
          { value: "draft", label: t("run.overrides.versionDraft") },
        ]}
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
