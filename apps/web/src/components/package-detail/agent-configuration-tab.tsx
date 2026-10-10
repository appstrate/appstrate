// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
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
import { isModelPinUnavailable, isModelSelectable } from "../../lib/model-selectability";
import { ModelUnselectableNote } from "../model-availability-badge";
import { useProxies, useAgentProxy, useSetAgentProxy } from "../../hooks/use-proxies";
import { usePackageDetail } from "../../hooks/use-packages";
import { useSaveInputSettings } from "../../hooks/use-mutations";
import { authorDefaults, getOrderedKeys, type SchemaWrapper } from "@appstrate/core/form";
import { formatInputValue, hasInputFields, subsetWrapper } from "../../lib/agent-input";
import {
  reconcileModelGenerationSettings,
  type ModelGenerationSettings,
} from "@appstrate/core/model-generation";
import { JsonView } from "../json-view";
import { SettingRow } from "../settings/setting-row";
import { GenerationSettingRows } from "../model-generation-rows";

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
 *
 * It saves itself, like the rest of the redesigned settings: a pause after the
 * last change sends the whole pair, and the line under the form says so.
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
  const [hasEdited, setHasEdited] = useState(false);

  useEffect(() => {
    if (!hasEdited || isHistorical) return;
    const timeout = window.setTimeout(() => {
      setHasEdited(false);
      mutation.mutate({ values, locked_fields: locked });
    }, 650);
    return () => window.clearTimeout(timeout);
  }, [hasEdited, isHistorical, mutation, values, locked]);

  const defaults = authorDefaults(wrapper.schema);
  const keys = getOrderedKeys(wrapper.schema, wrapper.property_order);

  const setFieldValue = (key: string, next: unknown) => {
    setValues((prev) => {
      const out = { ...prev };
      if (next === undefined) delete out[key];
      else out[key] = next;
      return out;
    });
    setHasEdited(true);
  };

  const toggleLock = (key: string, on: boolean) => {
    setLocked((prev) => (on ? [...prev, key] : prev.filter((k) => k !== key)));
    setHasEdited(true);
  };

  return (
    <div className="space-y-3 py-4">
      {showDescription && (
        <p className="text-muted-foreground text-sm">{t("detail.inputSettings.hint")}</p>
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
      <SaveFeedback
        pending={mutation.isPending}
        success={mutation.isSuccess}
        error={mutation.isError}
      />
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
  return (
    <InputFieldRow
      fieldKey={fieldKey}
      wrapper={wrapper}
      value={value}
      disabled={disabled}
      labels={labels}
      upload={upload}
      onValueChange={onValueChange}
      hint={
        authorDefault !== undefined
          ? t("detail.inputSettings.authorDefault", { value: formatInputValue(authorDefault) })
          : undefined
      }
      control={
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
      }
    />
  );
}

/**
 * One input as a settings row: its field, then under it what the value is
 * (left) and what can be done to it (right): a note is text, a control acts. The agent's Entrées (with
 * "Verrouiller") and a schedule's Entrées share it.
 */
export function InputFieldRow({
  fieldKey,
  wrapper,
  value,
  disabled,
  labels,
  upload,
  onValueChange,
  hint,
  control,
}: {
  fieldKey: string;
  wrapper: SchemaWrapper;
  value: unknown;
  disabled?: boolean;
  labels: ReturnType<typeof useSchemaFormLabels>;
  upload: ReturnType<typeof useUploadClient>;
  onValueChange: (next: unknown) => void;
  hint?: ReactNode;
  control?: ReactNode;
}) {
  const subset = subsetWrapper(wrapper, [fieldKey]);
  if (!subset) return null;
  // `required` is dropped exactly as the server drops it: an empty value here
  // means "not decided — ask at launch", not "invalid".
  const fieldSchema = { ...subset.schema };
  delete fieldSchema.required;
  const fieldWrapper: SchemaWrapper = { ...subset, schema: fieldSchema };

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
        {hint ? (
          <p className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">{hint}</p>
        ) : (
          <span />
        )}
        {control}
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
    generation.reasoning_level ?? "inherit",
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
        description={
          <>
            {t("detail.configuration.modelDescription", { ns: "agents" })}
            {isModelPinUnavailable(orgModels, modelId) && (
              <span className="text-warning block" data-testid="agent-model-pin-unavailable">
                {t("input.modelPinUnavailable", { ns: "agents" })}
              </span>
            )}
          </>
        }
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

      <GenerationSettingRows
        model={resolvedModel}
        generation={generation}
        disabled={setAgentModel.isPending}
        onChange={(nextGeneration) => {
          setGeneration(nextGeneration);
          save(modelId, nextGeneration);
        }}
      />
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

export function SaveFeedback({
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
      <div className="space-y-4">
        <p className="text-muted-foreground text-sm">
          {t("detail.configuration.historicalDefaultsUnavailable")}
        </p>
        {showInputSettings && wrapper && (
          <div className="rounded-lg border p-4">
            <h3 className="mb-3 text-sm font-medium">{t("detail.bundle.inputSchema")}</h3>
            <JsonView data={wrapper.schema} />
          </div>
        )}
      </div>
    );
  }

  if (!detail) return null;
  if (!showInputSettings || !wrapper) {
    return <p className="text-muted-foreground text-sm">{t("detail.emptyConfig")}</p>;
  }

  return (
    <InputSettingsSection
      // Not remounted when the saved settings change: the form saves itself,
      // so its local state IS what was written, and a remount would take the
      // focus away mid-typing.
      packageId={packageId}
      wrapper={wrapper}
      initialValues={detail.input.values}
      initialLocked={detail.input.locked_fields}
      isHistorical={isHistorical}
      showDescription={showSectionDescription}
    />
  );
}
