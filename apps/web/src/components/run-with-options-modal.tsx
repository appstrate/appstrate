// SPDX-License-Identifier: Apache-2.0

import { defaultRunVersion, VERSION_DRAFT, VERSION_PUBLISHED } from "../lib/version-selector";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "./modal";
import { Button } from "@appstrate/ui/components/button";
import { Spinner } from "./spinner";
import type { SchemaWrapper } from "@appstrate/core/form";
import { AgentInputForm, type AgentInputFormHandle } from "./agent-input-form";
import { storedInputValues } from "../lib/agent-input";
import { RunOverridesPanel, type RunOverridesValue } from "./run-overrides-panel";
import { AgentVersionField } from "./package-version-select";
import { DependencyOverridesSection } from "./dependency-overrides-section";
import { useScheduleFormDeps } from "../hooks/use-schedules";
import type { AgentDetail } from "@appstrate/shared-types";

/**
 * Everything the modal collects, mapped onto a launch by `launchFromOptions`:
 * `version` rides the `?version=` query; `overrides` carries the
 * schedule-shaped delta for model / proxy / connections (reused from
 * `RunOverridesPanel`); `dependencyOverrides` the per-skill
 * `dependency_overrides` map. Defaults across the board mirror plain "Lancer".
 */
export interface RunWithOptionsSubmit {
  input: Record<string, unknown>;
  version: string;
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

/**
 * "Run with options" — the advanced run launcher. Surfaces every per-run
 * override the run API accepts (input, version, model, proxy, connection
 * overrides, and per-skill dependency overrides), so the dashboard reaches
 * parity with a hand-built run POST. Composed from existing pieces:
 * `AgentInputForm` (as in `RunModal`), `RunOverridesPanel` (the schedule
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
  // Seeded from the STORED values only — they are per-space and do not
  // move with the version pick. Author `default`s deliberately stay out: they
  // belong to the selected version's schema, and seeding the draft's here would
  // send them as caller input (the top precedence layer) for whatever version
  // the user later selects. The version-pinned wrapper supplies its own.
  const [inputData, setInputData] = useState<Record<string, unknown>>(() =>
    storedInputValues(agent.input),
  );
  // Draft is the author's working copy and the server refuses it to anyone who
  // cannot WRITE the package in its home (403 `draft_not_writable`), so the
  // modal neither defaults to it nor offers it outside that circle. Everyone
  // else starts on the latest published version — the same thing an omitted
  // selector resolves to, said explicitly because a `<Select>` needs a value.
  const [version, setVersion] = useState<string>(
    defaultRunVersion(agent.home_writable) ?? VERSION_PUBLISHED,
  );
  const [overrides, setOverrides] = useState<RunOverridesValue>({});
  const [dependencyOverrides, setDependencyOverrides] = useState<Record<string, string>>({});
  const inputFormRef = useRef<AgentInputFormHandle>(null);
  // Deps follow the selected version (#770): the input / integrations / skills
  // the modal renders match what the run will execute, not the draft.
  const { deps } = useScheduleFormDeps(agent.id, version);

  // Version-pinned input wrapper / skills (fall back to the draft the parent
  // passed while the version-aware detail is still loading).
  const inputWrapper: SchemaWrapper = deps?.inputWrapper ?? agent.input;
  // The fallback is the WIRE shape, so `home_writable` is renamed here rather
  // than left absent — an absent one silently hides the draft option for the
  // one render before the version-aware detail lands.
  const skills =
    deps?.skills ??
    (agent.dependencies.skills ?? []).map((s) => ({
      id: s.id,
      homeWritable: s.home_writable,
      ...(s.version ? { version: s.version } : {}),
      ...(s.name ? { name: s.name } : {}),
    }));

  const fire = (input: Record<string, unknown>) =>
    onSubmit({ input, version, overrides, dependencyOverrides });

  return (
    <div className="space-y-5">
      <AgentInputForm
        ref={inputFormRef}
        wrapper={inputWrapper}
        settings={agent.input}
        value={inputData}
        onChange={setInputData}
        onSubmit={fire}
      />

      {/* Run version — a run has no schedule-style "inherit" to defer to, so
          the single leading option is whatever this caller's default is:
          the working copy for an author, the latest published version for
          everyone else. Any other published version is an explicit pick,
          applied verbatim. */}
      <AgentVersionField
        packageId={agent.id}
        label={t("run.overrides.versionLabel")}
        value={version}
        onChange={setVersion}
        leadingOptions={[
          agent.home_writable
            ? { value: VERSION_DRAFT, label: t("run.overrides.versionDraft") }
            : { value: VERSION_PUBLISHED, label: t("run.overrides.versionPublished") },
        ]}
      />

      {deps && (
        <RunOverridesPanel
          packageId={agent.id}
          persistedModelId={deps.persistedModelId}
          persistedGenerationConfig={deps.persistedGenerationConfig}
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
        <Button onClick={() => inputFormRef.current?.submit()} disabled={isPending}>
          {isPending ? <Spinner /> : t("input.run")}
        </Button>
      </div>
    </div>
  );
}
