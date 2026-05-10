// SPDX-License-Identifier: Apache-2.0

import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SchemaForm } from "@appstrate/ui/schema-form";
import { useSchemaFormLabels } from "../hooks/use-schema-form-labels";
import { uploadClient } from "../api";
import type { JSONSchemaObject, SchemaWrapper } from "@appstrate/core/form";
import { useModels } from "../hooks/use-models";
import { useProxies } from "../hooks/use-proxies";
import { usePackageVersions } from "../hooks/use-packages";
import { findProviderByApiShapeAndBaseUrl } from "../lib/model-presets";
import { PROVIDER_ICONS } from "./icons";

const INHERIT = "__inherit__";
const NONE = "__none__";

export interface RunOverridesValue {
  /** Override delta — deep-merged with persisted config on the server. */
  configOverride?: Record<string, unknown>;
  /** Per-run model id override. */
  modelIdOverride?: string;
  /** Per-run proxy id override. */
  proxyIdOverride?: string;
  /** Per-run version label or dist-tag override. */
  versionOverride?: string;
}

export interface RunOverridesPanelProps {
  packageId: string;
  /** Agent's config schema; absent when the agent has no configurable fields. */
  configSchema?: JSONSchemaObject;
  /** Persisted application-level config — the merge baseline. */
  persistedConfig: Record<string, unknown>;
  /** Persisted model id (or null = inherit org default). */
  persistedModelId: string | null;
  /** Persisted proxy id (or null = inherit org default). */
  persistedProxyId: string | null;
  /** Persisted version pin (or null = follow latest dist-tag). */
  persistedVersion: string | null;
  /** Current value (controlled). */
  value: RunOverridesValue;
  onChange: (next: RunOverridesValue) => void;
}

/**
 * Per-run override editor — rendered inside the Schedule form. Emits a
 * delta payload (`onChange`): each field is present only when it differs
 * from the persisted default, so the caller never has to re-implement
 * diff detection.
 *
 * Source of truth for the merge semantics:
 * `@appstrate/core/schema-validation` (`deepMergeConfig`), shared with
 * the run pipeline.
 */
export function RunOverridesPanel({
  packageId,
  configSchema,
  persistedConfig,
  persistedModelId,
  persistedProxyId,
  persistedVersion,
  value,
  onChange,
}: RunOverridesPanelProps) {
  const { t } = useTranslation(["agents", "settings"]);
  const { data: orgModels } = useModels();
  const { data: orgProxies } = useProxies();
  const { data: versions } = usePackageVersions("agent", packageId);
  const labels = useSchemaFormLabels();

  // Local form state for the SchemaForm. Initialised with the resolved
  // config the user would otherwise run with (persisted ∪ current
  // override) so the form reflects the merged starting point.
  const [configValues, setConfigValues] = useState<Record<string, unknown>>(() => ({
    ...persistedConfig,
    ...(value.configOverride ?? {}),
  }));

  const wrapper: SchemaWrapper | null = useMemo(
    () => (configSchema ? { schema: configSchema } : null),
    [configSchema],
  );

  const hasConfigFields =
    !!configSchema?.properties && Object.keys(configSchema.properties).length > 0;

  const setModel = (next: string) => {
    if (next === INHERIT || next === persistedModelId) {
      const { modelIdOverride: _omit, ...rest } = value;
      void _omit;
      onChange(rest);
    } else {
      onChange({ ...value, modelIdOverride: next });
    }
  };

  const setProxy = (next: string) => {
    if (next === INHERIT || next === (persistedProxyId ?? INHERIT)) {
      const { proxyIdOverride: _omit, ...rest } = value;
      void _omit;
      onChange(rest);
    } else {
      onChange({ ...value, proxyIdOverride: next });
    }
  };

  const setVersion = (next: string) => {
    if (next === INHERIT || next === (persistedVersion ?? "latest")) {
      const { versionOverride: _omit, ...rest } = value;
      void _omit;
      onChange(rest);
    } else {
      onChange({ ...value, versionOverride: next });
    }
  };

  const setConfigForm = (formData: Record<string, unknown>) => {
    setConfigValues(formData);
    const delta = computeConfigDelta(persistedConfig, formData);
    if (delta === null) {
      const { configOverride: _omit, ...rest } = value;
      void _omit;
      onChange(rest);
    } else {
      onChange({ ...value, configOverride: delta });
    }
  };

  const orgDefaultModel = orgModels?.find((m) => m.isDefault && m.enabled);
  const orgDefaultProxy = orgProxies?.find((p) => p.isDefault && p.enabled);

  const modelSelectValue = value.modelIdOverride ?? persistedModelId ?? INHERIT;
  const proxySelectValue = value.proxyIdOverride ?? persistedProxyId ?? INHERIT;
  const versionSelectValue = value.versionOverride ?? persistedVersion ?? INHERIT;

  return (
    <div className="space-y-4">
      {orgModels && orgModels.length > 0 && (
        <div className="space-y-2">
          <Label>{t("models.tabTitle", { ns: "settings" })}</Label>
          <Select value={modelSelectValue} onValueChange={setModel}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={INHERIT}>
                {orgDefaultModel
                  ? t("run.overrides.modelInheritWithDefault", {
                      ns: "agents",
                      name: orgDefaultModel.label,
                    })
                  : t("run.overrides.modelInherit", { ns: "agents" })}
              </SelectItem>
              {orgModels.map((m) => {
                const mp = findProviderByApiShapeAndBaseUrl(m.apiShape, m.baseUrl);
                const MIcon = mp ? PROVIDER_ICONS[mp.id] : undefined;
                return (
                  <SelectItem key={m.id} value={m.id}>
                    <span className="inline-flex items-center gap-1.5">
                      {MIcon && <MIcon className="size-3.5" />}
                      {m.label}
                    </span>
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </div>
      )}

      {orgProxies && orgProxies.length > 0 && (
        <div className="space-y-2">
          <Label>{t("detail.configSectionProxy", { ns: "agents" })}</Label>
          <Select value={proxySelectValue} onValueChange={setProxy}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={INHERIT}>
                {orgDefaultProxy
                  ? t("run.overrides.proxyInheritWithDefault", {
                      ns: "agents",
                      name: orgDefaultProxy.label,
                    })
                  : t("run.overrides.proxyInherit", { ns: "agents" })}
              </SelectItem>
              <SelectItem value={NONE}>{t("run.overrides.proxyNone", { ns: "agents" })}</SelectItem>
              {orgProxies.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {versions && versions.length > 0 && (
        <div className="space-y-2">
          <Label>{t("run.overrides.versionLabel", { ns: "agents" })}</Label>
          <Select value={versionSelectValue} onValueChange={setVersion}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={INHERIT}>
                {persistedVersion
                  ? t("run.overrides.versionInheritPinned", {
                      ns: "agents",
                      version: persistedVersion,
                    })
                  : t("run.overrides.versionInheritLatest", { ns: "agents" })}
              </SelectItem>
              {versions
                .filter((v) => !v.yanked)
                .map((v) => (
                  <SelectItem key={v.version} value={v.version}>
                    v{v.version}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {hasConfigFields && wrapper && (
        <div className="space-y-2">
          <Label>{t("run.overrides.configLabel", { ns: "agents" })}</Label>
          <p className="text-muted-foreground text-xs">
            {t("run.overrides.configHint", { ns: "agents" })}
          </p>
          <div className="border-border bg-card rounded-md border p-3">
            <SchemaForm
              wrapper={wrapper}
              formData={configValues}
              upload={uploadClient}
              labels={labels}
              onChange={(e) => setConfigForm(e.formData as Record<string, unknown>)}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Walk the form values vs. the persisted baseline and return only the keys
 * whose value differs. Returns `null` when the form values exactly match
 * the persisted config, signalling "no override to send".
 *
 * Detection is shallow on the top-level keys plus a structural compare
 * (JSON stringify) on nested values — sufficient because the SchemaForm
 * always rewrites the entire object on every keystroke, and the server
 * deep-merges on receipt anyway. Replays still work: any key the user
 * touched ends up in the override delta verbatim.
 */
function computeConfigDelta(
  persisted: Record<string, unknown>,
  current: Record<string, unknown>,
): Record<string, unknown> | null {
  const delta: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(current)) {
    const baseline = persisted[key];
    if (!structurallyEqual(baseline, value)) {
      delta[key] = value;
    }
  }
  return Object.keys(delta).length === 0 ? null : delta;
}

function structurallyEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}
