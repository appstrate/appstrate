// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Label } from "@appstrate/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@appstrate/ui/components/select";
import { useModels } from "../hooks/use-models";
import { isModelSelectable } from "../lib/model-selectability";
import { ModelUnselectableNote } from "./model-availability-badge";
import { useProxies } from "../hooks/use-proxies";
import { useProvidersRegistry } from "../hooks/use-model-provider-credentials";
import { getModelIcon } from "./icons";
import { useIntegrationDetail } from "../hooks/use-integrations";
import { connectableAuthKeysForAgent } from "@appstrate/core/integration";
import { IntegrationConnectionPicker } from "./integration-connect/integration-connection-picker";
import { ModelGenerationFields } from "./model-generation-fields";
import {
  reconcileModelGenerationSettings,
  type ModelGenerationSettings,
} from "@appstrate/core/model-generation";

const INHERIT = "__inherit__";
// Wire value the server recognizes as "no proxy" (distinct from INHERIT =
// "use the org default"). Emitting it verbatim — rather than an internal
// `__none__` sentinel each caller has to translate — means both the run
// launcher and the schedule form send the right value, so a scheduled run
// with "None" selected is no longer silently routed through the org-default
// proxy.
const NONE = "none";

export interface RunOverridesValue {
  /** Per-run model id override. */
  model_id_override?: string;
  /** Per-run/schedule generation layer. */
  generation_config_override?: ModelGenerationSettings;
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
  /** Persisted model id (or null = inherit org default). */
  persistedModelId: string | null;
  /** Persisted generation defaults shown as the inherit baseline. */
  persistedGenerationConfig?: ModelGenerationSettings | null;
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
 * Override editor for the agent's resolution defaults — model, proxy and
 * integration connections. Shared by the schedule editor and the run launcher,
 * where these three carry identical semantics ("inherit" = the agent default).
 * Emits a delta payload (`onChange`): each field is present only when it
 * differs from the persisted default, so the caller never re-implements diff
 * detection.
 *
 * Agent parameters are deliberately NOT here — they are the agent's single
 * `input` schema, rendered by {@link AgentInputForm} at the top of every launch
 * surface, not an override layer.
 *
 * Version is deliberately NOT here either — its semantics are context-specific
 * (a schedule inherits/pins; a run defaults to `draft` and applies every pick),
 * so each caller composes {@link AgentVersionField} itself.
 */
export function RunOverridesPanel({
  packageId,
  persistedModelId,
  persistedGenerationConfig,
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

  // The inherited row stays visible even when the default is unavailable, so
  // users can still clear an override and see which model will be resolved.
  const orgDefaultModel = orgModels?.find((model) => model.is_default);
  const orgDefaultProxy = orgProxies?.find((proxy) => proxy.is_default && proxy.enabled);

  const setModel = (next: string) => {
    const nextModelId = next === INHERIT ? persistedModelId : next;
    const nextModel =
      orgModels?.find((model) => model.id === nextModelId) ??
      (nextModelId === null ? orgDefaultModel : undefined);
    const generation = reconcileModelGenerationSettings(
      value.generation_config_override ?? {},
      nextModel?.generation,
    );
    const nextValue = { ...value };

    if (Object.keys(generation).length === 0) {
      delete nextValue.generation_config_override;
    } else {
      nextValue.generation_config_override = generation;
    }

    if (next === INHERIT || next === persistedModelId) {
      delete nextValue.model_id_override;
    } else {
      nextValue.model_id_override = next;
    }
    onChange(nextValue);
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

  const modelSelectValue = value.model_id_override ?? persistedModelId ?? INHERIT;
  const selectedModel =
    orgModels?.find((model) => model.id === (value.model_id_override ?? persistedModelId)) ??
    orgDefaultModel;
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
              {/* "Inherit" stays selectable even when the default is dead: it
                  is the absence of an override, so disabling it would trap a
                  user who wants to clear one. */}
              <SelectItem value={INHERIT}>
                <span className="inline-flex items-center gap-1.5">
                  {orgDefaultModel
                    ? t("run.overrides.modelInheritWithDefault", {
                        ns: "agents",
                        name: orgDefaultModel.label,
                      })
                    : t("run.overrides.modelInherit", { ns: "agents" })}
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
        </div>
      )}

      {orgModels && orgModels.length > 0 && (
        <ModelGenerationFields
          value={value.generation_config_override ?? {}}
          capabilities={selectedModel?.generation}
          onChange={(generation) => {
            if (Object.keys(generation).length === 0) {
              const { generation_config_override: _omit, ...rest } = value;
              void _omit;
              onChange(rest);
            } else {
              onChange({ ...value, generation_config_override: generation });
            }
          }}
        />
      )}

      {persistedGenerationConfig && Object.keys(persistedGenerationConfig).length > 0 && (
        <p className="text-muted-foreground text-xs">
          {t("run.overrides.generationInheritHint", { ns: "agents" })}
        </p>
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
        agentTools={integration.tools}
        agentScopes={undefined}
        persistence={{ mode: "override", value, onChange }}
        version={version}
      />
    </div>
  );
}
