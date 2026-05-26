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
import { useProvidersRegistry } from "../hooks/use-model-provider-credentials";
import { findProviderByApiShapeAndBaseUrl } from "../lib/provider-registry-helpers";
import { getProviderIcon } from "./icons";
import { useIntegrationDetail, useIntegrationConnections } from "../hooks/use-integrations";
import { requiredAuthKeysForAgent } from "@appstrate/core/integration";
import { connectionDisplayLabel } from "./integration-connect/connection-label";

const INHERIT = "__inherit__";
const NONE = "__none__";

export interface RunOverridesValue {
  /** Override delta — deep-merged with persisted config on the server. */
  config_override?: Record<string, unknown>;
  /** Per-run model id override. */
  model_id_override?: string;
  /** Per-run proxy id override. */
  proxy_id_override?: string;
  /** Per-run version label or dist-tag override. */
  version_override?: string;
  /**
   * Per-(integration, authKey) connection picks — frozen at schedule
   * create/edit so every fire uses the same row. Loses to admin pins;
   * beats schedule-less fallback + per-run overrides on the actor.
   * Shape: `{ "@scope/integration": { "<authKey>": "<connection_id>" } }`.
   */
  connection_overrides?: Record<string, Record<string, string>>;
}

interface AgentIntegrationRef {
  id: string;
  tools?: string[];
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
  /**
   * Agent's declared integration dependencies — drives the
   * connectionOverrides picker. Pass an empty array to hide the section
   * (e.g. for agents without integrations). The caller is responsible
   * for reading `dependencies.integrations` off the agent manifest.
   */
  agentIntegrations?: AgentIntegrationRef[];
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
  agentIntegrations,
  value,
  onChange,
}: RunOverridesPanelProps) {
  const { t } = useTranslation(["agents", "settings"]);
  const { data: orgModels } = useModels();
  const { data: orgProxies } = useProxies();
  const { data: registry } = useProvidersRegistry();
  const { data: versions } = usePackageVersions("agent", packageId);
  const labels = useSchemaFormLabels();

  // Local form state for the SchemaForm. Initialised with the resolved
  // config the user would otherwise run with (persisted ∪ current
  // override) so the form reflects the merged starting point.
  const [configValues, setConfigValues] = useState<Record<string, unknown>>(() => ({
    ...persistedConfig,
    ...(value.config_override ?? {}),
  }));

  const wrapper: SchemaWrapper | null = useMemo(
    () => (configSchema ? { schema: configSchema } : null),
    [configSchema],
  );

  const hasConfigFields =
    !!configSchema?.properties && Object.keys(configSchema.properties).length > 0;

  const setModel = (next: string) => {
    if (next === INHERIT || next === persistedModelId) {
      const { model_id_override: _omit, ...rest } = value;
      void _omit;
      onChange(rest);
    } else {
      onChange({ ...value, model_id_override: next });
    }
  };

  const setProxy = (next: string) => {
    if (next === INHERIT || next === (persistedProxyId ?? INHERIT)) {
      const { proxy_id_override: _omit, ...rest } = value;
      void _omit;
      onChange(rest);
    } else {
      onChange({ ...value, proxy_id_override: next });
    }
  };

  const setVersion = (next: string) => {
    if (next === INHERIT || next === (persistedVersion ?? "latest")) {
      const { version_override: _omit, ...rest } = value;
      void _omit;
      onChange(rest);
    } else {
      onChange({ ...value, version_override: next });
    }
  };

  const setConfigForm = (formData: Record<string, unknown>) => {
    setConfigValues(formData);
    const delta = computeConfigDelta(persistedConfig, formData);
    if (delta === null) {
      const { config_override: _omit, ...rest } = value;
      void _omit;
      onChange(rest);
    } else {
      onChange({ ...value, config_override: delta });
    }
  };

  const orgDefaultModel = orgModels?.find((m) => m.isDefault && m.enabled);
  const orgDefaultProxy = orgProxies?.find((p) => p.isDefault && p.enabled);

  const modelSelectValue = value.model_id_override ?? persistedModelId ?? INHERIT;
  const proxySelectValue = value.proxy_id_override ?? persistedProxyId ?? INHERIT;
  const versionSelectValue = value.version_override ?? persistedVersion ?? INHERIT;

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
                const mp = findProviderByApiShapeAndBaseUrl(m.apiShape, m.baseUrl, registry ?? []);
                const MIcon = getProviderIcon(mp);
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
          <Label>{t("run.overrides.version_label", { ns: "agents" })}</Label>
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

      {agentIntegrations && agentIntegrations.length > 0 && (
        <ScheduleConnectionOverridesSection
          integrations={agentIntegrations}
          value={value.connection_overrides ?? {}}
          onChange={(next) => {
            const compacted: Record<string, Record<string, string>> = {};
            for (const [intId, perAuth] of Object.entries(next)) {
              const cleaned: Record<string, string> = {};
              for (const [authKey, connId] of Object.entries(perAuth)) {
                if (connId) cleaned[authKey] = connId;
              }
              if (Object.keys(cleaned).length > 0) compacted[intId] = cleaned;
            }
            if (Object.keys(compacted).length === 0) {
              const { connection_overrides: _omit, ...rest } = value;
              void _omit;
              onChange(rest);
            } else {
              onChange({ ...value, connection_overrides: compacted });
            }
          }}
        />
      )}
    </div>
  );
}

/**
 * Per-integration picker section that drives `value.connection_overrides`.
 * Renders one select per (integration, required authKey) listing the
 * actor's accessible (own + shared) connections. "Inherit" leaves the
 * resolver's default cascade in charge (admin pin → user fallback at
 * fire time). Each pick freezes the choice into the schedule row.
 */
function ScheduleConnectionOverridesSection({
  integrations,
  value,
  onChange,
}: {
  integrations: AgentIntegrationRef[];
  value: Record<string, Record<string, string>>;
  onChange: (next: Record<string, Record<string, string>>) => void;
}) {
  const { t } = useTranslation(["agents"]);
  return (
    <div className="space-y-2">
      <Label>{t("schedule.connection_overrides.label")}</Label>
      <p className="text-muted-foreground text-xs">{t("schedule.connection_overrides.hint")}</p>
      <div className="border-border bg-card space-y-3 rounded-md border p-3">
        {integrations.map((integ) => (
          <IntegrationOverrideRow
            key={integ.id}
            integration={integ}
            value={value[integ.id] ?? {}}
            onChange={(authValues) => onChange({ ...value, [integ.id]: authValues })}
          />
        ))}
      </div>
    </div>
  );
}

function IntegrationOverrideRow({
  integration,
  value,
  onChange,
}: {
  integration: AgentIntegrationRef;
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}) {
  const { t } = useTranslation(["agents"]);
  const { data: detail } = useIntegrationDetail(integration.id);
  const { data: connections } = useIntegrationConnections(integration.id);
  const displayName = detail?.manifest.display_name ?? integration.id;
  const requiredAuthKeys = detail
    ? requiredAuthKeysForAgent(detail.manifest, integration.tools)
    : [];

  if (requiredAuthKeys.length === 0) return null;

  return (
    <div className="space-y-1.5" data-testid={`schedule-conn-row-${integration.id}`}>
      <div className="text-xs font-medium">{displayName}</div>
      {requiredAuthKeys.map((authKey) => {
        const candidates = (connections ?? []).filter((c) => c.auth_key === authKey);
        if (candidates.length === 0) {
          return (
            <div
              key={authKey}
              className="text-muted-foreground flex items-center gap-2 text-[0.7rem]"
            >
              <span className="bg-muted rounded px-1.5 py-0.5 font-mono text-[10px]">
                {authKey}
              </span>
              <span>{t("schedule.connection_overrides.noCandidate")}</span>
            </div>
          );
        }
        const current = value[authKey] ?? "";
        return (
          <div key={authKey} className="flex items-center gap-2">
            <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 font-mono text-[10px]">
              {authKey}
            </span>
            <select
              value={current}
              onChange={(e) => {
                const next = { ...value };
                if (e.target.value === "") delete next[authKey];
                else next[authKey] = e.target.value;
                onChange(next);
              }}
              className="border-border bg-background flex-1 rounded border px-2 py-1 text-xs"
              data-testid={`schedule-conn-select-${integration.id}-${authKey}`}
              aria-label={t("schedule.connection_overrides.selectAria", { authKey })}
            >
              <option value="">{t("schedule.connection_overrides.inherit")}</option>
              {candidates.map((c) => {
                const display = connectionDisplayLabel(c);
                return (
                  <option key={c.id} value={c.id}>
                    {c.shared_with_org
                      ? t("schedule.connection_overrides.sharedSuffix", { label: display })
                      : display}
                  </option>
                );
              })}
            </select>
          </div>
        );
      })}
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
