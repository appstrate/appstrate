// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@appstrate/ui/components/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@appstrate/ui/components/select";
import { LazySchemaForm as SchemaForm } from "../lazy-schema-form";
import { useSchemaFormLabels } from "../../hooks/use-schema-form-labels";
import { useUploadClient } from "../../hooks/use-upload";
import { getModelIcon } from "../icons";
import { useProvidersRegistry } from "../../hooks/use-model-provider-credentials";
import {
  useModels,
  useAgentModel,
  useSetAgentModel,
  type OrgModelInfo,
} from "../../hooks/use-models";
import { isModelSelectable } from "../../lib/model-selectability";
import { ModelUnselectableNote } from "../model-availability-badge";
import { useProxies, useAgentProxy, useSetAgentProxy } from "../../hooks/use-proxies";
import { usePackageDetail } from "../../hooks/use-packages";
import { useSaveConfig } from "../../hooks/use-mutations";
import type { JSONSchemaObject, SchemaWrapper } from "@appstrate/core/form";
import {
  reconcileModelGenerationSettings,
  type ModelGenerationSettings,
} from "@appstrate/core/model-generation";
import { ModelGenerationFields } from "../model-generation-fields";

// ─── Config Section ─────────────────────────────────────────────────

function ConfigSection({
  packageId,
  schema,
  isHistorical,
}: {
  packageId: string;
  schema: JSONSchemaObject;
  isHistorical?: boolean;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const { data: detail } = usePackageDetail("agent", packageId);

  const current = detail?.config?.current ?? {};
  const mutation = useSaveConfig(detail?.id ?? "");
  const wrapper: SchemaWrapper = { schema };

  const [values, setValues] = useState<Record<string, unknown>>(() => current);
  const labels = useSchemaFormLabels();
  const upload = useUploadClient();

  if (!schema?.properties || Object.keys(schema.properties).length === 0) return null;

  const handleSave = () => {
    mutation.mutate(values);
  };

  return (
    <div className="border-border bg-card space-y-3 rounded-lg border p-4">
      <h3 className="text-sm font-medium">{t("editor.configTitle")}</h3>
      <SchemaForm
        wrapper={wrapper}
        formData={values}
        upload={upload}
        labels={labels}
        onChange={(e) => setValues(e.formData as Record<string, unknown>)}
      />
      <div className="flex justify-end pt-2">
        <Button onClick={handleSave} disabled={mutation.isPending || isHistorical} size="sm">
          {mutation.isPending ? "..." : t("btn.save")}
        </Button>
      </div>
    </div>
  );
}

// ─── Model Section ──────────────────────────────────────────────────

function ModelSection({ packageId }: { packageId: string }) {
  const { data: orgModels } = useModels();
  const { data: agentModel } = useAgentModel(packageId);
  if (!orgModels || orgModels.length === 0 || !agentModel) return null;

  const generation = agentModel.generation ?? {};
  const editorKey = [
    agentModel.modelId ?? "inherit",
    generation.temperature ?? "inherit",
    generation.reasoningLevel ?? "inherit",
  ].join(":");

  return (
    <ModelSectionEditor
      key={editorKey}
      packageId={packageId}
      orgModels={orgModels}
      initialModelId={agentModel.modelId}
      initialGeneration={generation}
    />
  );
}

function ModelSectionEditor({
  packageId,
  orgModels,
  initialModelId,
  initialGeneration,
}: {
  packageId: string;
  orgModels: OrgModelInfo[];
  initialModelId: string | null;
  initialGeneration: ModelGenerationSettings;
}) {
  const { t } = useTranslation(["settings"]);
  const { data: registry } = useProvidersRegistry();
  const setAgentModel = useSetAgentModel(packageId);
  const [modelId, setModelId] = useState<string | null>(initialModelId);
  const [generation, setGeneration] = useState<ModelGenerationSettings>(initialGeneration);

  // Unfiltered on purpose — see the same call in `run-overrides-panel.tsx`:
  // the inherited default must be named even when it is unusable.
  const orgDefaultModel = orgModels.find((m) => m.is_default);
  const resolvedModel = modelId ? orgModels.find((m) => m.id === modelId) : orgDefaultModel;

  return (
    <div className="border-border bg-card space-y-3 rounded-lg border p-4">
      <h3 className="text-sm font-medium">{t("models.tabTitle", { ns: "settings" })}</h3>
      <Select
        value={modelId ?? "__inherit__"}
        onValueChange={(value) => {
          const nextModelId = value === "__inherit__" ? null : value;
          const nextModel = nextModelId
            ? orgModels.find((model) => model.id === nextModelId)
            : orgDefaultModel;
          setModelId(nextModelId);
          setGeneration((current) =>
            reconcileModelGenerationSettings(current, nextModel?.generation),
          );
        }}
        disabled={setAgentModel.isPending}
      >
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__inherit__">
            <span className="inline-flex items-center gap-1.5">
              {orgDefaultModel
                ? t("models.agent.inherit", { ns: "settings", name: orgDefaultModel.label })
                : t("models.agent.inheritNoDefault", { ns: "settings" })}
              {orgDefaultModel && <ModelUnselectableNote model={orgDefaultModel} />}
            </span>
          </SelectItem>
          {orgModels.map((m) => {
            const MIcon = getModelIcon(m, registry ?? []);
            return (
              <SelectItem key={m.id} value={m.id} disabled={!isModelSelectable(m)}>
                <span className="inline-flex items-center gap-1.5">
                  {MIcon && <MIcon className="size-3.5" />}
                  {m.label}
                  <ModelUnselectableNote model={m} />
                </span>
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
      <ModelGenerationFields
        value={generation}
        capabilities={resolvedModel?.generation}
        onChange={setGeneration}
        disabled={setAgentModel.isPending}
      />
      <div className="flex justify-end">
        <Button
          size="sm"
          disabled={setAgentModel.isPending}
          onClick={() =>
            setAgentModel.mutate({
              modelId,
              generation: Object.keys(generation).length > 0 ? generation : null,
            })
          }
        >
          {t("models.generation.save")}
        </Button>
      </div>
    </div>
  );
}

// ─── Proxy Section ──────────────────────────────────────────────────

function ProxySection({ packageId }: { packageId: string }) {
  const { t } = useTranslation(["agents", "settings"]);
  const { data: orgProxies } = useProxies();
  const { data: agentProxy } = useAgentProxy(packageId);
  const setAgentProxy = useSetAgentProxy(packageId);
  if (!orgProxies || orgProxies.length === 0) return null;

  const agentProxyId = agentProxy?.proxyId;
  const orgDefaultProxy = orgProxies.find((p) => p.is_default && p.enabled);

  return (
    <div className="border-border bg-card space-y-3 rounded-lg border p-4">
      <h3 className="text-sm font-medium">{t("detail.configSectionProxy")}</h3>
      <Select
        value={agentProxyId ?? "__inherit__"}
        onValueChange={(v) => setAgentProxy.mutate(v === "__inherit__" ? null : v)}
        disabled={setAgentProxy.isPending}
      >
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__inherit__">
            {orgDefaultProxy
              ? t("proxies.agent.inherit", { ns: "settings", name: orgDefaultProxy.label })
              : t("proxies.agent.inheritNoDefault", { ns: "settings" })}
          </SelectItem>
          <SelectItem value="none">{t("proxies.agent.none", { ns: "settings" })}</SelectItem>
          {orgProxies.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

// ─── Main Tab ───────────────────────────────────────────────────────

export function AgentConfigurationTab({
  packageId,
  configSchemaOverride,
  isHistorical,
}: {
  packageId: string;
  configSchemaOverride?: JSONSchemaObject;
  isHistorical?: boolean;
}) {
  const { t } = useTranslation(["agents"]);
  const { data: detail } = usePackageDetail("agent", packageId);

  const schema = isHistorical
    ? configSchemaOverride
    : (configSchemaOverride ?? detail?.config?.schema);
  const hasConfigSchema = !!(schema?.properties && Object.keys(schema.properties).length > 0);

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">{t("detail.tabConfigurationHint")}</p>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <ModelSection packageId={packageId} />
        <ProxySection packageId={packageId} />
      </div>
      {hasConfigSchema && schema && (
        <ConfigSection packageId={packageId} schema={schema} isHistorical={isHistorical} />
      )}
    </div>
  );
}
