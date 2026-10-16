// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Globe, Plus } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Checkbox } from "@appstrate/ui/components/checkbox";
import { Label } from "@appstrate/ui/components/label";
import { SelectItem } from "@appstrate/ui/components/select";
import { OptionSelect } from "@/components/app-ui/option-select";
import { useSchemaFormLabels } from "../../hooks/use-schema-form-labels";
import { useUploadClient } from "../../hooks/use-upload";
import {
  useModels,
  useAgentModel,
  useSetAgentModel,
  type OrgModelInfo,
} from "../../hooks/use-models";
import { isModelPinUnavailable } from "../../lib/model-selectability";
import { ModelSelect } from "../model-select";
import { useProxies, useAgentProxy, useSetAgentProxy } from "../../hooks/use-proxies";
import { useCanReach } from "../../hooks/use-can-reach";
import { usePermissions } from "../../hooks/use-permissions";
import { EmptyState } from "../page-states";
import { usePackageDetail } from "../../hooks/use-packages";
import { useSaveInputSettings } from "../../hooks/use-mutations";
import { useSettingDraft } from "../../hooks/use-setting-draft";
import { ManualSave, ManualSetting } from "../settings/manual-save";
import { authorDefaults, getOrderedKeys, type SchemaWrapper } from "@appstrate/core/form";
import { formatInputValue, hasInputFields } from "../../lib/agent-input";
import {
  reconcileModelGenerationSettings,
  type ModelGenerationSettings,
} from "@appstrate/core/model-generation";
import { JsonView } from "../json-view";
import { SettingsSkeleton } from "../loading-skeletons";
import { SettingRow } from "../settings/setting-row";
import { InputFieldRow } from "../settings/input-field-row";
import { ModelGenerationFields } from "../model-generation-fields";

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
 * Save sends the values and locks together after explicit confirmation.
 */
function InputSettingsSection({
  packageId,
  wrapper,
  initialValues,
  initialLocked,
  isHistorical,
}: {
  packageId: string;
  wrapper: SchemaWrapper;
  initialValues: Record<string, unknown>;
  initialLocked: string[];
  isHistorical?: boolean;
}) {
  const mutation = useSaveInputSettings(packageId);
  const labels = useSchemaFormLabels();
  const upload = useUploadClient();
  const draft = useSettingDraft({ values: initialValues, locked_fields: initialLocked });
  const { values, locked_fields: locked } = draft.value;

  const defaults = authorDefaults(wrapper.schema);
  const keys = getOrderedKeys(wrapper.schema, wrapper.property_order);

  const setFieldValue = (key: string, next: unknown) => {
    draft.set((previous) => {
      const values = { ...previous.values };
      if (next === undefined) delete values[key];
      else values[key] = next;
      return { ...previous, values };
    });
  };
  const toggleLock = (key: string, on: boolean) =>
    draft.set((previous) => ({
      ...previous,
      locked_fields: on
        ? [...previous.locked_fields, key]
        : previous.locked_fields.filter((field) => field !== key),
    }));

  return (
    <div className="flex flex-col gap-3 py-4">
      <div className="flex flex-col gap-4">
        {keys.map((key) => (
          <InputSettingRow
            key={key}
            fieldKey={key}
            wrapper={wrapper}
            value={values[key]}
            authorDefault={defaults[key]}
            locked={locked.includes(key)}
            disabled={isHistorical || mutation.isPending}
            labels={labels}
            upload={upload}
            onValueChange={(next) => setFieldValue(key, next)}
            onLockChange={(on) => toggleLock(key, on)}
          />
        ))}
      </div>
      <ManualSave
        dirty={draft.dirty}
        pending={mutation.isPending}
        onDiscard={draft.reset}
        onSave={async () => {
          const sent = draft.value;
          await mutation.mutateAsync(sent);
          draft.accept(sent);
        }}
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

// ─── Model Section ──────────────────────────────────────────────────

function ModelSection({ packageId }: { packageId: string }) {
  const { data: orgModels, isLoading: modelsLoading } = useModels();
  const { data: agentModel, isLoading: agentModelLoading } = useAgentModel(packageId);
  if (modelsLoading || agentModelLoading) return <SettingsSkeleton rows={3} />;
  if (!orgModels || orgModels.length === 0 || !agentModel) return null;

  const generation = agentModel.generation ?? {};

  return (
    <ModelSectionEditor
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
  const setAgentModel = useSetAgentModel(packageId);
  const draft = useSettingDraft({ modelId: initialModelId, generation: initialGeneration });
  const { modelId, generation } = draft.value;

  // Unfiltered on purpose — see the same call in `run-overrides-panel.tsx`:
  // the inherited default must be named even when it is unusable.
  const orgDefaultModel = orgModels.find((m) => m.is_default);
  const resolvedModel = modelId ? orgModels.find((m) => m.id === modelId) : orgDefaultModel;

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
        <ModelSelect
          models={orgModels}
          value={modelId}
          inherit={{
            label: orgDefaultModel
              ? t("models.agent.inherit", { ns: "settings", name: orgDefaultModel.label })
              : t("models.agent.inheritNoDefault", { ns: "settings" }),
            modelId: orgDefaultModel?.id ?? null,
          }}
          onChange={(nextModelId) => {
            const nextModel = nextModelId
              ? orgModels.find((model) => model.id === nextModelId)
              : orgDefaultModel;
            const nextGeneration = reconcileModelGenerationSettings(
              generation,
              nextModel?.generation,
            );
            draft.set({ modelId: nextModelId, generation: nextGeneration });
          }}
          disabled={setAgentModel.isPending}
        />
      </SettingRow>

      <ModelGenerationFields
        model={resolvedModel}
        value={generation}
        disabled={setAgentModel.isPending}
        onChange={(nextGeneration) => {
          draft.set({ modelId, generation: nextGeneration });
        }}
      />
      <ManualSave
        dirty={draft.dirty}
        pending={setAgentModel.isPending}
        onDiscard={draft.reset}
        onSave={async () => {
          const sent = draft.value;
          await setAgentModel.mutateAsync({
            modelId: sent.modelId,
            generation: Object.keys(sent.generation).length ? sent.generation : null,
          });
          draft.accept(sent);
        }}
      />
    </>
  );
}

// ─── Proxy Section ──────────────────────────────────────────────────

/** The organization has no proxy to route through: the button opens the proxy creation itself. */
function NoProxyState() {
  const { t } = useTranslation(["agents", "settings"]);
  const canReach = useCanReach();
  const { can } = usePermissions();
  return (
    <EmptyState
      icon={Globe}
      compact
      message={t("detail.configuration.proxyEmpty")}
      hint={t("detail.configuration.proxyEmptyHint")}
    >
      {canReach("/org-settings/proxies") && can("proxies:write") && (
        <Button asChild variant="outline" size="sm">
          <Link to="/org-settings/proxies?newProxy=1">
            <Plus />
            {t("proxies.add", { ns: "settings" })}
          </Link>
        </Button>
      )}
    </EmptyState>
  );
}

function ProxySection({ packageId }: { packageId: string }) {
  const { t } = useTranslation(["agents", "settings"]);
  const { data: orgProxies, isLoading: orgProxiesLoading } = useProxies();
  const { data: agentProxy, isLoading: agentProxyLoading } = useAgentProxy(packageId);
  const setAgentProxy = useSetAgentProxy(packageId);
  if (orgProxiesLoading || agentProxyLoading) return <SettingsSkeleton rows={1} />;
  if (!orgProxies) return null;
  if (orgProxies.length === 0) return <NoProxyState />;

  const agentProxyId = agentProxy?.proxyId;
  const orgDefaultProxy = orgProxies.find((p) => p.is_default && p.enabled);

  return (
    <>
      <SettingRow
        label={t("detail.configuration.proxyRoute")}
        description={t("detail.configuration.proxyDescription")}
      >
        <ManualSetting
          value={agentProxyId ?? null}
          onSave={(value) => setAgentProxy.mutateAsync(value)}
        >
          {(value, onChange, pending) => (
            <OptionSelect
              value={value ?? "__inherit__"}
              onValueChange={(v) => onChange(v === "__inherit__" ? null : v)}
              disabled={pending}
              leading={
                <>
                  <SelectItem value="__inherit__">
                    {orgDefaultProxy
                      ? t("proxies.agent.inherit", { ns: "settings", name: orgDefaultProxy.label })
                      : t("models.default", { ns: "settings" })}
                  </SelectItem>
                  <SelectItem value="none">
                    {t("proxies.agent.none", { ns: "settings" })}
                  </SelectItem>
                </>
              }
              options={orgProxies.map((p) => ({ value: p.id, label: p.label }))}
            />
          )}
        </ManualSetting>
      </SettingRow>
    </>
  );
}

// ─── Main Tab ───────────────────────────────────────────────────────

export function AgentConfigurationTab({
  packageId,
  inputWrapperOverride,
  isHistorical,
  section,
}: {
  packageId: string;
  /** The pinned version's input wrapper — the schema a historical view edits against. */
  inputWrapperOverride?: SchemaWrapper;
  isHistorical?: boolean;
  /** One section per settings entry: the rail decides which, this renders it. */
  section: "model" | "proxy" | "inputs";
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
      <div className="flex flex-col gap-4">
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
    />
  );
}
