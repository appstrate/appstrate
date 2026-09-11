// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { CircleSlash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@appstrate/ui/components/button";
import { Checkbox } from "@appstrate/ui/components/checkbox";
import { Label } from "@appstrate/ui/components/label";
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
import { useSaveInputSettings } from "../../hooks/use-mutations";
import { authorDefaults, getOrderedKeys, type SchemaWrapper } from "@appstrate/core/form";
import { formatInputValue, hasInputFields, subsetWrapper } from "../../lib/agent-input";
import {
  MODEL_REASONING_LEVELS,
  reconcileModelGenerationSettings,
  type ModelGenerationSettings,
  type ModelReasoningLevel,
} from "@appstrate/core/model-generation";
import { SettingRow } from "../settings/setting-row";

// ─── Input Settings Section ─────────────────────────────────────────

/**
 * The editor layer of input resolution, for one space: the value each
 * parameter takes when the caller does not supply one, and whether the caller
 * may supply one at all.
 *
 * Both halves are FULL replacements on the wire (`PUT .../input-settings` with
 * `{ values, locked_fields }`), which is why the whole section saves at once
 * rather than per field — a partial write would silently clear the rest.
 *
 * Values are validated server-side against `input.schema` with `required`
 * dropped, and the form mirrors that: leaving a required field empty here is
 * legitimate and means "ask it at launch". Locking a required field with
 * nothing behind it is the one refused combination (400
 * `locked_required_field_empty`), surfaced as a toast naming the field.
 */
/** Exported so the visual map can mount the same settings form in a dialog. */
export function InputSettingsSection({
  packageId,
  wrapper,
  initialValues,
  initialLocked,
  isHistorical,
  showDescription = true,
}: {
  packageId: string;
  wrapper: SchemaWrapper;
  initialValues: Record<string, unknown>;
  initialLocked: string[];
  isHistorical?: boolean;
  showDescription?: boolean;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const mutation = useSaveInputSettings(packageId);
  const labels = useSchemaFormLabels();
  const upload = useUploadClient();
  const [values, setValues] = useState<Record<string, unknown>>(initialValues);
  const [locked, setLocked] = useState<string[]>(initialLocked);

  const defaults = authorDefaults(wrapper.schema);
  const keys = getOrderedKeys(wrapper.schema, wrapper.property_order);

  const setFieldValue = (key: string, next: unknown) => {
    setValues((prev) => {
      const out = { ...prev };
      if (next === undefined) delete out[key];
      else out[key] = next;
      return out;
    });
  };

  const toggleLock = (key: string, on: boolean) =>
    setLocked((prev) => (on ? [...prev, key] : prev.filter((k) => k !== key)));

  return (
    <div className="border-border bg-card space-y-3 rounded-lg border p-4">
      <h3 className="text-sm font-medium">{t("detail.inputSettings.title")}</h3>
      {showDescription && (
        <p className="text-muted-foreground text-xs">{t("detail.inputSettings.hint")}</p>
      )}
      <div className="space-y-4">
        {keys.map((key) => (
          <InputSettingRow
            key={key}
            fieldKey={key}
            wrapper={wrapper}
            value={values[key]}
            authorDefault={defaults[key]}
            locked={locked.includes(key)}
            disabled={isHistorical}
            labels={labels}
            upload={upload}
            onValueChange={(next) => setFieldValue(key, next)}
            onLockChange={(on) => toggleLock(key, on)}
          />
        ))}
      </div>
      <div className="flex justify-end pt-2">
        <Button
          onClick={() => mutation.mutate({ values, locked_fields: locked })}
          disabled={mutation.isPending || isHistorical}
          size="sm"
        >
          {mutation.isPending ? "..." : t("btn.save")}
        </Button>
      </div>
    </div>
  );
}

function InputSettingRow({
  fieldKey,
  wrapper,
  value,
  authorDefault,
  locked,
  disabled,
  labels,
  upload,
  onValueChange,
  onLockChange,
}: {
  fieldKey: string;
  wrapper: SchemaWrapper;
  value: unknown;
  authorDefault: unknown;
  locked: boolean;
  disabled?: boolean;
  labels: ReturnType<typeof useSchemaFormLabels>;
  upload: ReturnType<typeof useUploadClient>;
  onValueChange: (next: unknown) => void;
  onLockChange: (locked: boolean) => void;
}) {
  const { t } = useTranslation(["agents"]);
  const subset = subsetWrapper(wrapper, [fieldKey]);
  if (!subset) return null;
  // `required` is dropped exactly as the server drops it: an empty value here
  // means "not decided — ask at launch", not "invalid".
  const fieldWrapper: SchemaWrapper = {
    ...subset,
    schema: { type: "object", properties: subset.schema.properties },
  };

  return (
    <div className="space-y-1.5" data-testid={`input-setting-${fieldKey}`}>
      <SchemaForm
        wrapper={fieldWrapper}
        formData={value === undefined ? {} : { [fieldKey]: value }}
        upload={upload}
        labels={labels}
        disabled={disabled}
        onChange={(e) => onValueChange((e.formData as Record<string, unknown>)[fieldKey])}
      />
      <div className="flex items-center justify-between gap-3">
        {authorDefault !== undefined ? (
          <p className="text-muted-foreground text-xs">
            {t("detail.inputSettings.authorDefault", { value: formatInputValue(authorDefault) })}
          </p>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-1.5">
          <Checkbox
            id={`lock-${fieldKey}`}
            checked={locked}
            onCheckedChange={(checked) => onLockChange(Boolean(checked))}
            disabled={disabled}
          />
          <Label
            htmlFor={`lock-${fieldKey}`}
            className="text-muted-foreground cursor-pointer text-xs font-normal whitespace-nowrap"
            title={t("detail.inputSettings.lockHint")}
          >
            {t("detail.inputSettings.lock")}
          </Label>
        </div>
      </div>
    </div>
  );
}

// ─── Model Section ──────────────────────────────────────────────────

/** Exported so the visual map can mount the same picker in a dialog. */
export function ModelSection({ packageId }: { packageId: string }) {
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

/** Shared with the visual map so both surfaces edit the same proxy setting. */
export function ProxySection({ packageId }: { packageId: string }) {
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
  inputWrapperOverride,
  isHistorical,
  section,
  showSectionDescription = true,
}: {
  packageId: string;
  /** The pinned version's input wrapper — the schema a historical view edits against. */
  inputWrapperOverride?: SchemaWrapper;
  isHistorical?: boolean;
  /** One section per settings entry: the rail decides which, this renders it. */
  section: "model" | "proxy" | "inputs";
  showSectionDescription?: boolean;
}) {
  const { t } = useTranslation(["agents"]);
  const { data: detail } = usePackageDetail("agent", packageId);

  const wrapper = inputWrapperOverride ?? detail?.input;
  const showInputSettings = hasInputFields(wrapper);

  if (section === "model") return <ModelSection packageId={packageId} />;
  if (section === "proxy") return <ProxySection packageId={packageId} />;

  // section === "inputs" — a pinned version has no editable defaults: the
  // settings belong to the installation, not to the frozen bundle.
  if (isHistorical) {
    return (
      <p className="text-muted-foreground text-sm">
        {t("detail.configuration.historicalDefaultsUnavailable")}
      </p>
    );
  }

  if (!showInputSettings || !wrapper || !detail) return null;

  return (
    <InputSettingsSection
      // Remounted when the saved settings change, so the editor's local
      // state restarts from what the server now holds rather than from a
      // stale snapshot taken before the write.
      key={JSON.stringify([detail.input.values, detail.input.locked_fields])}
      packageId={packageId}
      wrapper={wrapper}
      initialValues={detail.input.values}
      initialLocked={detail.input.locked_fields}
      isHistorical={isHistorical}
      showDescription={showSectionDescription}
    />
  );
}
