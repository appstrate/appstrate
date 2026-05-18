// SPDX-License-Identifier: Apache-2.0

import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { CheckCircle2, AlertTriangle, XCircle, Loader2, Puzzle, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  useIntegrationDetail,
  useIntegrationConnections,
  type IntegrationManifestView,
} from "../../hooks/use-integrations";

interface AgentIntegrationEntry {
  id: string;
  version: string;
  tools?: string[];
  scopes?: string[];
}

interface AgentIntegrationsBlockProps {
  entries: AgentIntegrationEntry[];
}

/**
 * Phase B.1 — connection-status block for every integration declared in the
 * agent manifest. Mirrors the provider block: one card per dependency, three
 * states (OK / action-required / not-connected), CTA jumps to the
 * integration detail page where the actor can connect / re-consent.
 *
 * Status derivation matches the backend gate (validateAgentIntegrations):
 *   ❌ not_connected         — no connection on any required auth
 *   ⚠️ needs_reconnection    — connection flagged for re-consent
 *   ⚠️ insufficient_scopes   — granted ⊉ required (oauth2 only)
 *   ✅ ok
 *
 * Per-tool scope inference (required = ⋃ tools.{t}.requiredScopes for selected
 * tools, filtered by requiredAuthKey) is recomputed client-side so the badge
 * never lags the agent's editor state. The exact same logic powers the 412
 * server-side; the modal (Phase C) is the recovery path when this block is
 * stale or the actor hits Run before refreshing.
 */
export function AgentIntegrationsBlock({ entries }: AgentIntegrationsBlockProps) {
  if (entries.length === 0) return null;

  return (
    <div className="space-y-2">
      {entries.map((entry) => (
        <IntegrationConnectionCard key={entry.id} packageId={entry.id} agentTools={entry.tools} />
      ))}
    </div>
  );
}

interface IntegrationConnectionCardProps {
  packageId: string;
  agentTools: string[] | undefined;
}

function IntegrationConnectionCard({ packageId, agentTools }: IntegrationConnectionCardProps) {
  const { t } = useTranslation(["agents"]);
  const { data: detail, isPending: detailPending } = useIntegrationDetail(packageId);
  const { data: connections, isPending: connsPending } = useIntegrationConnections(packageId);

  const detailPath = toDetailPath(packageId);
  const displayName = detail?.manifest.displayName ?? packageId;
  const isLoading = detailPending || connsPending;

  if (isLoading || !detail) {
    return (
      <CardShell
        icon={<Loader2 className="text-muted-foreground size-4 animate-spin" />}
        title={displayName}
        subtitle={packageId}
      />
    );
  }

  const status = deriveIntegrationStatus({
    manifest: detail.manifest,
    connections: connections ?? [],
    agentTools,
  });

  const { icon, subtitle } = renderStatus(status, t);

  return (
    <CardShell icon={icon} title={displayName} subtitle={subtitle}>
      <Button asChild size="sm" variant={status.kind === "ok" ? "outline" : "default"}>
        <Link to={detailPath}>
          {status.kind === "ok"
            ? t("detail.integrationManage")
            : status.kind === "not_connected"
              ? t("detail.integrationConnect")
              : t("detail.integrationFix")}
          <ExternalLink className="ml-1 size-3" />
        </Link>
      </Button>
    </CardShell>
  );
}

function CardShell({
  icon,
  title,
  subtitle,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="border-border bg-card flex items-center justify-between gap-3 rounded-md border px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <Puzzle className="text-muted-foreground size-4 shrink-0" />
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{title}</div>
          <div className="text-muted-foreground flex items-center gap-1.5 truncate text-xs">
            {icon}
            <span className="truncate">{subtitle}</span>
          </div>
        </div>
      </div>
      {children}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Status derivation — mirrors apps/api/services/dependency-validation.ts
// (`checkOne`). Kept in lockstep so the badge and the 412 agree on what
// counts as "connected" at any moment.
// ───────────────────────────────────────────────────────────────────────────

type IntegrationStatus =
  | { kind: "ok" }
  | { kind: "not_connected" }
  | { kind: "needs_reconnection"; authKey: string }
  | { kind: "insufficient_scopes"; authKey: string; missing: string[] };

function deriveIntegrationStatus(input: {
  manifest: IntegrationManifestView;
  connections: { authKey: string; scopesGranted: string[]; needsReconnection: boolean }[];
  agentTools: string[] | undefined;
}): IntegrationStatus {
  const { manifest, connections, agentTools } = input;
  const auths = manifest.auths ?? {};
  const declaredAuthKeys = Object.keys(auths);
  if (declaredAuthKeys.length === 0) return { kind: "ok" };

  const requiredAuthKeys = requiredAuthKeysForAgent(manifest, agentTools);

  // Group by auth (multi-account → union scopes, OR needsReconnection)
  const byAuth = new Map<string, { scopesGranted: string[]; needsReconnection: boolean }>();
  for (const conn of connections) {
    const existing = byAuth.get(conn.authKey);
    if (!existing) {
      byAuth.set(conn.authKey, {
        scopesGranted: [...conn.scopesGranted],
        needsReconnection: conn.needsReconnection,
      });
    } else {
      for (const s of conn.scopesGranted) {
        if (!existing.scopesGranted.includes(s)) existing.scopesGranted.push(s);
      }
      existing.needsReconnection = existing.needsReconnection || conn.needsReconnection;
    }
  }

  const connected = requiredAuthKeys.filter((k) => byAuth.has(k));
  if (connected.length === 0) return { kind: "not_connected" };

  for (const authKey of connected) {
    const conn = byAuth.get(authKey)!;
    const auth = auths[authKey];
    if (!auth) continue;

    if (conn.needsReconnection) {
      return { kind: "needs_reconnection", authKey };
    }

    if (auth.type !== "oauth2") continue;

    const required = scopesContributedByTools({
      manifest,
      authKey,
      agentTools,
    });
    if (required.length === 0) continue;
    const granted = new Set(conn.scopesGranted);
    const missing = required.filter((s) => !granted.has(s));
    if (missing.length > 0) {
      return { kind: "insufficient_scopes", authKey, missing };
    }
  }

  return { kind: "ok" };
}

function requiredAuthKeysForAgent(
  manifest: IntegrationManifestView,
  agentTools: string[] | undefined,
): string[] {
  const declared = manifest.auths ? Object.keys(manifest.auths) : [];
  if (declared.length === 0) return [];
  if (agentTools === undefined) return declared;
  if (declared.length === 1) return declared;
  const tools = manifest.tools ?? {};
  const out = new Set<string>();
  for (const t of agentTools) {
    const meta = tools[t];
    if (meta?.requiredAuthKey && declared.includes(meta.requiredAuthKey)) {
      out.add(meta.requiredAuthKey);
    }
  }
  return out.size === 0 ? declared : [...out];
}

function scopesContributedByTools(input: {
  manifest: IntegrationManifestView;
  authKey: string;
  agentTools: string[] | undefined;
}): string[] {
  const toolsRecord = input.manifest.tools ?? {};
  const authKeys = input.manifest.auths ? Object.keys(input.manifest.auths) : [];
  const isSingleAuth = authKeys.length === 1;
  const effective = input.agentTools ?? Object.keys(toolsRecord);
  const out = new Set<string>();
  for (const name of effective) {
    const tool = toolsRecord[name];
    if (!tool?.requiredScopes?.length) continue;
    if (isSingleAuth) {
      if (authKeys[0] !== input.authKey) continue;
    } else if (tool.requiredAuthKey !== input.authKey) continue;
    for (const s of tool.requiredScopes) out.add(s);
  }
  return [...out];
}

function renderStatus(
  status: IntegrationStatus,
  t: (k: string, opts?: Record<string, unknown>) => string,
): { icon: React.ReactNode; subtitle: string } {
  switch (status.kind) {
    case "ok":
      return {
        icon: <CheckCircle2 className="size-3 text-emerald-500" />,
        subtitle: t("detail.integrationConnected"),
      };
    case "not_connected":
      return {
        icon: <XCircle className="text-destructive size-3" />,
        subtitle: t("detail.integrationNotConnected"),
      };
    case "needs_reconnection":
      return {
        icon: <AlertTriangle className="size-3 text-amber-500" />,
        subtitle: t("detail.integrationNeedsReconnection", { authKey: status.authKey }),
      };
    case "insufficient_scopes":
      return {
        icon: <AlertTriangle className="size-3 text-amber-500" />,
        subtitle: t("detail.integrationMissingScopes", {
          scopes: status.missing.join(", "),
        }),
      };
  }
}

function toDetailPath(packageId: string): string {
  // packageId is `@scope/name`; the route is `/integrations/:scope/:name`.
  const slash = packageId.indexOf("/", 1);
  if (slash < 0) return `/integrations/${encodeURIComponent(packageId)}`;
  return `/integrations/${encodeURIComponent(packageId.slice(0, slash))}/${encodeURIComponent(packageId.slice(slash + 1))}`;
}
