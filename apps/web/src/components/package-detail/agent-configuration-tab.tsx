// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CircleSlash2 } from "lucide-react";
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
  MODEL_REASONING_LEVELS,
  reconcileModelGenerationSettings,
  type ModelGenerationSettings,
  type ModelReasoningLevel,
} from "@appstrate/core/model-generation";
import { JsonView } from "../json-view";

function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="max-w-2xl py-4">
      <div>
        <h3 className="text-sm font-medium">{label}</h3>
        <p className="text-muted-foreground mt-1 text-xs leading-relaxed">{description}</p>
      </div>
      <div className="mt-3 max-w-md">{children}</div>
    </div>
  );
}

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
  const [hasEdited, setHasEdited] = useState(false);
  const initialized = useRef(false);
  const labels = useSchemaFormLabels();
  const upload = useUploadClient();

  useEffect(() => {
    if (!detail || initialized.current) return;
    initialized.current = true;
    setValues(detail.config.current ?? {});
  }, [detail]);

  useEffect(() => {
    if (!hasEdited || isHistorical) return;
    const timeout = window.setTimeout(() => {
      setHasEdited(false);
      mutation.mutate(values);
    }, 650);
    return () => window.clearTimeout(timeout);
  }, [hasEdited, isHistorical, mutation, values]);

  if (!schema?.properties || Object.keys(schema.properties).length === 0) return null;

  return (
    <div className="max-w-2xl space-y-3 py-4">
      <p className="text-muted-foreground text-sm">{t("detail.configuration.inputsDescription")}</p>
      <SchemaForm
        wrapper={wrapper}
        formData={values}
        upload={upload}
        labels={labels}
        onChange={(e) => {
          setValues(e.formData as Record<string, unknown>);
          setHasEdited(true);
        }}
      />
      <SaveFeedback
        pending={mutation.isPending}
        success={mutation.isSuccess}
        error={mutation.isError}
      />
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
  const { t } = useTranslation(["settings", "agents"]);
  const { data: registry } = useProvidersRegistry();
  const setAgentModel = useSetAgentModel(packageId);
  const [modelId, setModelId] = useState<string | null>(initialModelId);
  const [generation, setGeneration] = useState<ModelGenerationSettings>(initialGeneration);

  // Unfiltered on purpose — see the same call in `run-overrides-panel.tsx`:
  // the inherited default must be named even when it is unusable.
  const orgDefaultModel = orgModels.find((m) => m.is_default);
  const resolvedModel = modelId ? orgModels.find((m) => m.id === modelId) : orgDefaultModel;
  const temperatureUnsupported = resolvedModel?.generation?.temperature === "unsupported";
  const supportedReasoningLevels = MODEL_REASONING_LEVELS.filter(
    (level) => resolvedModel?.generation?.reasoning.levels[level] === "supported",
  );
  const reasoningUnsupported =
    resolvedModel?.generation?.reasoning.supported === "unsupported" ||
    supportedReasoningLevels.length === 0;

  const temperatureOptions: Array<{ value: string; label: string }> = [
    { value: "__inherit__", label: t("models.generation.inherit", { ns: "settings" }) },
    { value: "0", label: t("detail.configuration.temperature.precise", { ns: "agents" }) },
    { value: "0.2", label: t("detail.configuration.temperature.focused", { ns: "agents" }) },
    { value: "0.5", label: t("detail.configuration.temperature.balanced", { ns: "agents" }) },
    { value: "0.8", label: t("detail.configuration.temperature.creative", { ns: "agents" }) },
    { value: "1", label: t("detail.configuration.temperature.exploratory", { ns: "agents" }) },
  ];

  const reasoningLabel = (level: ModelReasoningLevel) => {
    if (level === "off") return t("models.generation.levels.off", { ns: "settings" });
    if (level === "minimal") return t("models.generation.levels.minimal", { ns: "settings" });
    if (level === "low") return t("models.generation.levels.low", { ns: "settings" });
    if (level === "medium") return t("models.generation.levels.medium", { ns: "settings" });
    if (level === "high") return t("models.generation.levels.high", { ns: "settings" });
    if (level === "xhigh") return t("models.generation.levels.xhigh", { ns: "settings" });
    return t("models.generation.levels.max", { ns: "settings" });
  };

  const withoutTemperature = () => {
    const { temperature: _temperature, ...rest } = generation;
    void _temperature;
    return rest;
  };
  const withoutReasoning = () => {
    const { reasoningLevel: _reasoningLevel, ...rest } = generation;
    void _reasoningLevel;
    return rest;
  };
  const save = (nextModelId: string | null, nextGeneration: ModelGenerationSettings) => {
    setAgentModel.mutate({
      modelId: nextModelId,
      generation: Object.keys(nextGeneration).length > 0 ? nextGeneration : null,
    });
  };

  return (
    <>
      <SettingRow
        label={t("detail.configuration.modelChoice", { ns: "agents" })}
        description={t("detail.configuration.modelDescription", { ns: "agents" })}
      >
        <Select
          value={modelId ?? "__inherit__"}
          onValueChange={(value) => {
            const nextModelId = value === "__inherit__" ? null : value;
            const nextModel = nextModelId
              ? orgModels.find((model) => model.id === nextModelId)
              : orgDefaultModel;
            const nextGeneration = reconcileModelGenerationSettings(
              generation,
              nextModel?.generation,
            );
            setModelId(nextModelId);
            setGeneration(nextGeneration);
            save(nextModelId, nextGeneration);
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
      </SettingRow>

      <SettingRow
        label={t("models.generation.temperature", { ns: "settings" })}
        description={
          temperatureUnsupported
            ? t("models.generation.unsupported", { ns: "settings" })
            : t("models.generation.temperatureHint", { ns: "settings" })
        }
      >
        <Select
          value={
            temperatureUnsupported
              ? "__unsupported__"
              : generation.temperature == null
                ? "__inherit__"
                : String(generation.temperature)
          }
          disabled={setAgentModel.isPending || temperatureUnsupported}
          onValueChange={(value) => {
            const nextGeneration =
              value === "__inherit__"
                ? withoutTemperature()
                : { ...generation, temperature: Number(value) };
            setGeneration(nextGeneration);
            save(modelId, nextGeneration);
          }}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {temperatureUnsupported ? (
              <SelectItem value="__unsupported__">
                <span className="inline-flex items-center gap-2">
                  <CircleSlash2 className="size-3.5" />
                  {t("models.generation.unsupportedShort", { ns: "settings" })}
                </span>
              </SelectItem>
            ) : (
              temperatureOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>
      </SettingRow>

      <SettingRow
        label={t("models.generation.reasoning", { ns: "settings" })}
        description={
          reasoningUnsupported
            ? t("models.generation.unsupported", { ns: "settings" })
            : t("models.generation.reasoningHint", { ns: "settings" })
        }
      >
        <Select
          value={
            reasoningUnsupported ? "__unsupported__" : (generation.reasoningLevel ?? "__inherit__")
          }
          disabled={setAgentModel.isPending || reasoningUnsupported}
          onValueChange={(value) => {
            const nextGeneration =
              value === "__inherit__"
                ? withoutReasoning()
                : { ...generation, reasoningLevel: value as ModelReasoningLevel };
            setGeneration(nextGeneration);
            save(modelId, nextGeneration);
          }}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {reasoningUnsupported ? (
              <SelectItem value="__unsupported__">
                <span className="inline-flex items-center gap-2">
                  <CircleSlash2 className="size-3.5" />
                  {t("models.generation.unsupportedShort", { ns: "settings" })}
                </span>
              </SelectItem>
            ) : (
              <>
                <SelectItem value="__inherit__">
                  {t("models.generation.inherit", { ns: "settings" })}
                </SelectItem>
                {supportedReasoningLevels.map((level) => (
                  <SelectItem key={level} value={level}>
                    {reasoningLabel(level)}
                  </SelectItem>
                ))}
              </>
            )}
          </SelectContent>
        </Select>
      </SettingRow>
      <SaveFeedback
        pending={setAgentModel.isPending}
        success={setAgentModel.isSuccess}
        error={setAgentModel.isError}
      />
    </>
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
    <>
      <SettingRow
        label={t("detail.configuration.proxyRoute")}
        description={t("detail.configuration.proxyDescription")}
      >
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
      </SettingRow>
      <SaveFeedback
        pending={setAgentProxy.isPending}
        success={setAgentProxy.isSuccess}
        error={setAgentProxy.isError}
      />
    </>
  );
}

function SaveFeedback({
  pending,
  success,
  error,
}: {
  pending: boolean;
  success: boolean;
  error: boolean;
}) {
  const { t } = useTranslation("agents");
  return (
    <p className="text-muted-foreground min-h-5 text-xs" aria-live="polite">
      {pending
        ? t("detail.configuration.saving")
        : error
          ? t("detail.configuration.saveError")
          : success
            ? t("detail.configuration.saved")
            : ""}
    </p>
  );
}

// ─── Main Tab ───────────────────────────────────────────────────────

export function AgentConfigurationTab({
  packageId,
  configSchemaOverride,
  isHistorical,
  section,
}: {
  packageId: string;
  configSchemaOverride?: JSONSchemaObject;
  isHistorical?: boolean;
  section: "model" | "proxy" | "inputs";
}) {
  const { t } = useTranslation(["agents"]);
  const { data: detail } = usePackageDetail("agent", packageId);

  const schema = isHistorical
    ? configSchemaOverride
    : (configSchemaOverride ?? detail?.config?.schema);
  const hasConfigSchema = !!(schema?.properties && Object.keys(schema.properties).length > 0);

  if (isHistorical) {
    return (
      <div className="space-y-4">
        <p className="text-muted-foreground text-sm">
          {t("detail.configuration.historicalDefaultsUnavailable")}
        </p>
        {hasConfigSchema && schema && (
          <div className="rounded-lg border p-4">
            <h3 className="mb-3 text-sm font-medium">{t("detail.bundle.inputSchema")}</h3>
            <JsonView data={schema} />
          </div>
        )}
      </div>
    );
  }

  if (section === "model") return <ModelSection packageId={packageId} />;
  if (section === "proxy") return <ProxySection packageId={packageId} />;
  if (!hasConfigSchema || !schema) {
    return <p className="text-muted-foreground text-sm">{t("detail.emptyConfig")}</p>;
  }
  return <ConfigSection packageId={packageId} schema={schema} isHistorical={isHistorical} />;
}
