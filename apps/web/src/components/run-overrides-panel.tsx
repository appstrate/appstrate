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
import { LazySchemaForm as SchemaForm } from "./lazy-schema-form";
import { useSchemaFormLabels } from "../hooks/use-schema-form-labels";
import { uploadClient } from "../api/uploads";
import type { JSONSchemaObject, SchemaWrapper } from "@appstrate/core/form";
import { useModels } from "../hooks/use-models";
import { useProxies } from "../hooks/use-proxies";
import { useProvidersRegistry } from "../hooks/use-model-provider-credentials";
import { getModelIcon } from "./icons";
import { useIntegrationDetail } from "../hooks/use-integrations";
import { connectableAuthKeysForAgent } from "@appstrate/core/integration";
import { IntegrationConnectionPicker } from "./integration-connect/integration-connection-picker";

const INHERIT = "__inherit__";
const NONE = "__none__";

export interface RunOverridesValue {
  /** Override delta — deep-merged with persisted config on the server. */
  config_override?: Record<string, unknown>;
  /** Per-run model id override. */
  model_id_override?: string;
  /** Per-run proxy id override. */
  proxy_id_override?: string;
  /**
   * Per-integration connection picks — frozen at schedule create/edit so
   * every fire uses the same row. Loses to admin pins; beats
   * schedule-less fallback + per-run overrides on the actor. Flat map:
   * `{ "@scope/integration": "<connection_id>" }`. The chosen connection
   * carries its own `auth_key`; the picker UI surfaces one row per
   * declared authKey for readability but writes one value per integration
   * (last write wins per integration — matches the wire format).
   */
  connection_overrides?: Record<string, string>;
}

interface AgentIntegrationRef {
  id: string;
  tools?: string[] | "*";
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
  /**
   * Version selector (#770) forwarded to the integration connection pickers so
   * their per-integration readiness verdict matches the run for a pinned
   * version. Omitted → draft (the schedule editor passes nothing).
   */
  version?: string;
}

/**
 * Override editor for the agent's resolution defaults — model, proxy, config,
 * and integration connections. Shared by the schedule editor and the run
 * launcher, where these four carry identical semantics ("inherit" = the agent
 * default). Emits a delta payload (`onChange`): each field is present only when
 * it differs from the persisted default, so the caller never re-implements diff
 * detection.
 *
 * Version is deliberately NOT here — its semantics are context-specific (a
 * schedule inherits/pins; a run defaults to `draft` and applies every pick), so
 * each caller composes {@link AgentVersionField} itself.
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
  agentIntegrations,
  value,
  onChange,
  version,
}: RunOverridesPanelProps) {
  const { t } = useTranslation(["agents", "settings"]);
  const { data: orgModels } = useModels();
  const { data: orgProxies } = useProxies();
  const { data: registry } = useProvidersRegistry();
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

  const orgDefaultModel = orgModels?.find((m) => m.is_default && m.enabled);
  const orgDefaultProxy = orgProxies?.find((p) => p.is_default && p.enabled);

  const modelSelectValue = value.model_id_override ?? persistedModelId ?? INHERIT;
  const proxySelectValue = value.proxy_id_override ?? persistedProxyId ?? INHERIT;

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
                const MIcon = getModelIcon(m, registry ?? []);
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
          agentPackageId={packageId}
          integrations={agentIntegrations}
          version={version}
          value={value.connection_overrides ?? {}}
          onChange={(next) => {
            // Drop falsy entries — empty string === "Inherit", which is
            // the absence of an override; sending it would be a spurious
            // pick the resolver would have to disambiguate.
            const compacted: Record<string, string> = {};
            for (const [intId, connId] of Object.entries(next)) {
              if (connId) compacted[intId] = connId;
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
 * Renders the shared `IntegrationConnectionPicker` (one dropdown per
 * integration) in `override` mode: selecting writes the pick into the
 * flat `connection_overrides` map, "inherit" clears it. The pick freezes
 * into the schedule row on save (cascade layer 4 — below admin pins,
 * above member pins).
 *
 * Identical UX to the agent page's connection picker — same candidate
 * list, scope/lock verdicts and inline connect flow — only the
 * persistence target differs (transient form value vs. member pin).
 */
function ScheduleConnectionOverridesSection({
  agentPackageId,
  integrations,
  version,
  value,
  onChange,
}: {
  agentPackageId: string;
  integrations: AgentIntegrationRef[];
  version?: string;
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}) {
  const { t } = useTranslation(["agents"]);
  return (
    <div className="space-y-2">
      <Label>{t("schedule.connectionOverrides.label")}</Label>
      <p className="text-muted-foreground text-xs">{t("schedule.connectionOverrides.hint")}</p>
      <div className="border-border bg-card space-y-3 rounded-md border p-3">
        {integrations.map((integ) => (
          <IntegrationOverrideRow
            key={integ.id}
            agentPackageId={agentPackageId}
            integration={integ}
            version={version}
            value={value[integ.id] ?? ""}
            onChange={(connId) => {
              const next = { ...value };
              if (connId) next[integ.id] = connId;
              else delete next[integ.id];
              onChange(next);
            }}
          />
        ))}
      </div>
    </div>
  );
}

function IntegrationOverrideRow({
  agentPackageId,
  integration,
  version,
  value,
  onChange,
}: {
  agentPackageId: string;
  integration: AgentIntegrationRef;
  version?: string;
  /** Currently-picked connection id; empty = inherit. */
  value: string;
  onChange: (next: string) => void;
}) {
  const { data: detail } = useIntegrationDetail(integration.id);
  const displayName = detail?.manifest.display_name ?? integration.id;

  // Gate the row on whether the agent can connect this integration at all
  // (declared auth the actor can start a flow on, given its tool selection).
  // Mirrors the run-time `integration_not_active`/no-auth gates so the
  // schedule editor never offers an override for an unconnectable integration.
  if (!detail) return null;
  if (connectableAuthKeysForAgent(detail.manifest, integration.tools).length === 0) return null;

  return (
    <div className="space-y-1.5" data-testid={`schedule-conn-row-${integration.id}`}>
      <div className="text-xs font-medium">{displayName}</div>
      <IntegrationConnectionPicker
        integrationId={integration.id}
        agentPackageId={agentPackageId}
        manifest={detail.manifest}
        authStatuses={detail.auths}
        displayName={displayName}
        agentTools={integration.tools}
        agentScopes={undefined}
        persistence={{ mode: "override", value, onChange }}
        version={version}
      />
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
