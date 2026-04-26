// SPDX-License-Identifier: Apache-2.0

import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import type RjsfForm from "@rjsf/core";
import { Modal } from "./modal";
import { Button } from "@/components/ui/button";
import { Spinner } from "./spinner";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { SchemaForm } from "@appstrate/ui/schema-form";
import type { SchemaWrapper, JSONSchemaObject } from "@appstrate/core/form";
import { useSchemaFormLabels } from "../hooks/use-schema-form-labels";
import { uploadClient } from "../api";
import { RunOverridesPanel, type RunOverridesValue } from "./run-overrides-panel";
import { useAgentModel } from "../hooks/use-models";
import { useAgentProxy } from "../hooks/use-proxies";
import { usePackageDetail } from "../hooks/use-packages";
import type { AgentDetail } from "@appstrate/shared-types";

interface RunModalProps {
  open: boolean;
  onClose: () => void;
  agent: AgentDetail;
  onSubmit: (payload: { input: Record<string, unknown>; overrides: RunOverridesValue }) => void;
  isPending?: boolean;
  initialInput?: Record<string, unknown>;
  initialOverrides?: RunOverridesValue;
  /** Open the override panel by default (Re-run flow seeds non-empty overrides). */
  defaultOverridesOpen?: boolean;
}

const EMPTY_SCHEMA: JSONSchemaObject = { type: "object", properties: {} };

export function RunModal({
  open,
  onClose,
  agent,
  onSubmit,
  isPending,
  initialInput,
  initialOverrides,
  defaultOverridesOpen,
}: RunModalProps) {
  const { t } = useTranslation(["agents", "common"]);

  const guardedClose = () => {
    if (!isPending) onClose();
  };

  return (
    <Modal
      open={open}
      onClose={guardedClose}
      title={t("input.title", { name: agent.displayName })}
      actions={null}
    >
      {open && (
        <RunModalForm
          agent={agent}
          onClose={guardedClose}
          onSubmit={onSubmit}
          isPending={isPending}
          initialInput={initialInput}
          initialOverrides={initialOverrides}
          defaultOverridesOpen={defaultOverridesOpen}
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
  initialOverrides,
  defaultOverridesOpen,
}: {
  agent: AgentDetail;
  onClose: () => void;
  onSubmit: (payload: { input: Record<string, unknown>; overrides: RunOverridesValue }) => void;
  isPending?: boolean;
  initialInput?: Record<string, unknown>;
  initialOverrides?: RunOverridesValue;
  defaultOverridesOpen?: boolean;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const inputWrapper: SchemaWrapper = agent.input ?? { schema: EMPTY_SCHEMA };
  const hasInputFields =
    !!inputWrapper.schema?.properties && Object.keys(inputWrapper.schema.properties).length > 0;
  const [inputData, setInputData] = useState<Record<string, unknown>>(initialInput ?? {});
  const inputFormRef = useRef<RjsfForm>(null);
  const labels = useSchemaFormLabels();

  // Pull persisted defaults so the override panel can compute a true delta.
  // We re-fetch even though they're already on `agent` because
  // `agentModel` / `agentProxy` carry the resolved value vs the inherit
  // sentinel that `application_packages` doesn't expose directly.
  const { data: detail } = usePackageDetail("agent", agent.id);
  const { data: agentModel } = useAgentModel(agent.id);
  const { data: agentProxy } = useAgentProxy(agent.id);

  const persistedConfig = (detail?.config?.current ?? {}) as Record<string, unknown>;
  const persistedModelId = agentModel?.modelId ?? null;
  const persistedProxyId = agentProxy?.proxyId ?? null;
  const persistedVersion = detail?.version ?? null;

  const [overrides, setOverrides] = useState<RunOverridesValue>(initialOverrides ?? {});
  const [overridesOpen, setOverridesOpen] = useState(
    defaultOverridesOpen ?? hasNonEmptyOverride(initialOverrides),
  );

  const handleSubmit = () => {
    if (hasInputFields && inputFormRef.current) {
      inputFormRef.current.submit();
      return;
    }
    onSubmit({ input: inputData, overrides });
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
            onSubmit={(e) => onSubmit({ input: e.formData as Record<string, unknown>, overrides })}
          />
        </div>
      )}

      <Collapsible open={overridesOpen} onOpenChange={setOverridesOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="text-foreground hover:bg-muted/50 border-border flex w-full items-center justify-between rounded-md border border-dashed px-3 py-2 text-sm font-medium transition-colors"
          >
            <span className="inline-flex items-center gap-2">
              {t("run.modal.overridesTitle")}
              {hasNonEmptyOverride(overrides) && (
                <span className="bg-primary/15 text-primary inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold">
                  {countOverrides(overrides)}
                </span>
              )}
            </span>
            <ChevronDown
              className={`text-muted-foreground size-4 transition-transform ${
                overridesOpen ? "rotate-180" : ""
              }`}
            />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-3">
          <p className="text-muted-foreground mb-3 text-xs">{t("run.modal.overridesHint")}</p>
          <RunOverridesPanel
            packageId={agent.id}
            configSchema={agent.config?.schema ?? undefined}
            persistedConfig={persistedConfig}
            persistedModelId={persistedModelId}
            persistedProxyId={persistedProxyId}
            persistedVersion={persistedVersion}
            value={overrides}
            onChange={setOverrides}
          />
        </CollapsibleContent>
      </Collapsible>

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

function hasNonEmptyOverride(o: RunOverridesValue | undefined): boolean {
  if (!o) return false;
  if (o.modelId != null) return true;
  if (o.proxyId != null) return true;
  if (o.version != null) return true;
  if (o.configOverride && Object.keys(o.configOverride).length > 0) return true;
  return false;
}

function countOverrides(o: RunOverridesValue): number {
  let n = 0;
  if (o.modelId != null) n++;
  if (o.proxyId != null) n++;
  if (o.version != null) n++;
  if (o.configOverride && Object.keys(o.configOverride).length > 0) n++;
  return n;
}
