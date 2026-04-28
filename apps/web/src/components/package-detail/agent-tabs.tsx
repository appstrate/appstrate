// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { usePackageDetail } from "../../hooks/use-packages";
import { MemoryPanel } from "../persistence/memory-panel";
import { useSchedules } from "../../hooks/use-schedules";
import { useApiKeys } from "../../hooks/use-api-keys";
import { useAgentReadiness } from "../../hooks/use-agent-readiness";
import {
  isFileField,
  schemaHasFileFields,
  type JSONSchemaObject,
  type JSONSchema7,
} from "@appstrate/core/form";
import { useOrg } from "../../hooks/use-org";
import { AgentProvidersSection } from "./agent-providers-section";
import { RunList } from "../run-list";
import { ScheduleCard } from "../schedule-card";
import { RunAgentButton } from "../run-agent-button";
import { ApiKeyCreateModal } from "../api-key-create-modal";
import { Ban, CalendarClock, Play } from "lucide-react";
import { EmptyState } from "../page-states";

export function AgentRunsTab({
  packageId,
  resolvedVersion,
  configSchemaOverride,
}: {
  packageId: string;
  resolvedVersion: string | undefined;
  configSchemaOverride?: JSONSchemaObject;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const { data: detail } = usePackageDetail("agent", packageId);
  const readiness = useAgentReadiness(detail, undefined, undefined, configSchemaOverride);

  if (!detail) return null;

  const { hasRequiredConfig, hasPrompt, hasRequiredSkills, hasRequiredTools } = readiness;
  const runDisabled = !hasPrompt || !hasRequiredSkills || !hasRequiredTools || !hasRequiredConfig;

  return (
    <RunList
      packageId={packageId}
      pageSize={12}
      hideAgentName
      emptyState={
        <EmptyState message={t("detail.emptyRuns")} icon={Play} compact>
          <RunAgentButton
            packageId={packageId}
            detail={detail}
            version={resolvedVersion}
            disabled={runDisabled}
            showLabel
          />
        </EmptyState>
      }
    />
  );
}

export function AgentSchedulesTab({ packageId }: { packageId: string }) {
  const { t } = useTranslation(["agents", "common"]);
  const { data: detail } = usePackageDetail("agent", packageId);
  const { data: schedules } = useSchedules(packageId);

  if (!detail) return null;

  if (schemaHasFileFields(detail.input?.schema)) {
    return <EmptyState message={t("schedule.fileInputBlocked")} icon={Ban} compact />;
  }

  return (
    <>
      {!schedules || schedules.length === 0 ? (
        <EmptyState message={t("detail.emptySchedule")} icon={CalendarClock} compact>
          <Button asChild>
            <Link to="/schedules/new">{t("btn.add")}</Link>
          </Button>
        </EmptyState>
      ) : (
        <div className="space-y-2">
          {schedules.map((sched) => (
            <ScheduleCard key={sched.id} schedule={sched} />
          ))}
        </div>
      )}
    </>
  );
}

export function AgentConnectorsTab({
  packageId,
  detail,
}: {
  packageId: string;
  detail?: import("@appstrate/shared-types").AgentDetail;
}) {
  return <AgentProvidersSection packageId={packageId} detail={detail} />;
}

export function AgentMemoryTab({ packageId }: { packageId: string }) {
  return <MemoryPanel packageId={packageId} />;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function buildInputExample(properties?: Record<string, JSONSchema7>): Record<string, unknown> {
  if (!properties) return {};
  const example: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(properties)) {
    if (isFileField(prop)) continue;
    if (prop.default !== undefined) {
      example[key] = prop.default;
    } else if (prop.enum && prop.enum.length > 0) {
      example[key] = prop.enum[0];
    } else if (prop.type === "number" || prop.type === "integer") {
      example[key] = 0;
    } else if (prop.type === "boolean") {
      example[key] = false;
    } else {
      example[key] = "";
    }
  }
  return example;
}

interface CurlParams {
  packageId: string;
  orgId: string;
  authToken: string;
  inputSchema?: JSONSchemaObject;
  baseUrl: string;
}

function buildCurlExample(params: CurlParams): string {
  const { packageId, orgId, authToken, inputSchema, baseUrl } = params;
  const url = `${baseUrl}/api/agents/${packageId}/run`;

  const inputExample = buildInputExample(inputSchema?.properties);
  const hasInput = Object.keys(inputExample).length > 0;
  const body = hasInput ? JSON.stringify({ input: inputExample }, null, 2) : "{}";

  const lines = [
    `curl -X POST "${url}" \\`,
    `  -H "Authorization: Bearer ${authToken}" \\`,
    `  -H "X-Org-Id: ${orgId}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '${body}'`,
  ];

  return lines.join("\n");
}

function buildCurlMultipartExample(params: CurlParams): string {
  const { packageId, orgId, authToken, inputSchema, baseUrl } = params;
  const url = `${baseUrl}/api/agents/${packageId}/run`;

  const properties = inputSchema?.properties ?? {};
  const inputExample = buildInputExample(properties);
  const hasInput = Object.keys(inputExample).length > 0;

  const lines = [
    `curl -X POST "${url}" \\`,
    `  -H "Authorization: Bearer ${authToken}" \\`,
    `  -H "X-Org-Id: ${orgId}" \\`,
  ];

  if (hasInput) {
    lines.push(`  -F 'input=${JSON.stringify(inputExample)}' \\`);
  }

  for (const [key, prop] of Object.entries(properties)) {
    if (!isFileField(prop)) continue;
    lines.push(`  -F '${key}=@/path/to/${key}.pdf' \\`);
  }

  // Remove trailing backslash from the last line
  const last = lines.length - 1;
  lines[last] = lines[last]!.replace(/ \\$/, "");

  return lines.join("\n");
}

// ─── Agent API Tab ─────────────────────────────────────────────────────

export function AgentApiTab({ packageId }: { packageId: string }) {
  const { t } = useTranslation(["agents", "common"]);
  const { data: detail } = usePackageDetail("agent", packageId);
  const { data: apiKeys, isLoading: keysLoading } = useApiKeys();
  const { currentOrg } = useOrg();

  const [rawKey, setRawKey] = useState<string | null>(null);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  if (!detail || !currentOrg) return null;

  const firstKey = apiKeys?.[0] ?? null;
  const baseUrl = window.location.origin;

  // Determine the auth token to show in the curl
  let authToken: string;
  if (rawKey) {
    authToken = rawKey;
  } else if (firstKey) {
    authToken = `${firstKey.keyPrefix}${"•".repeat(44)}`;
  } else {
    authToken = "<your-api-key>";
  }

  const curlParams: CurlParams = {
    packageId,
    orgId: currentOrg.id,
    authToken,
    inputSchema: detail.input?.schema,
    baseUrl,
  };

  const schema = detail.input?.schema;
  const fileKeys = schema?.properties
    ? Object.entries(schema.properties)
        .filter(([, p]) => isFileField(p))
        .map(([k]) => k)
    : [];
  const hasFileInput = fileKeys.length > 0;
  const hasRequiredFile = hasFileInput && fileKeys.some((k) => schema?.required?.includes(k));

  const curlExample = buildCurlExample(curlParams);
  const curlMultipart = hasFileInput ? buildCurlMultipartExample(curlParams) : null;

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleKeyCreated = (key: string) => {
    setRawKey(key);
  };

  return (
    <div className="border-border bg-card space-y-5 rounded-lg border p-5">
      <h3 className="text-foreground text-sm font-medium">{t("api.title")}</h3>

      {/* API Key section */}
      {keysLoading ? (
        <div className="text-muted-foreground text-sm">{t("loading", { ns: "common" })}</div>
      ) : !firstKey && !rawKey ? (
        <div className="border-warning/30 bg-warning/5 rounded-md border px-4 py-3">
          <p className="text-warning text-sm">{t("api.noKey")}</p>
          <p className="text-muted-foreground mt-1 text-xs">{t("api.noKeyHint")}</p>
          <Button size="sm" className="mt-2" onClick={() => setCreateModalOpen(true)}>
            {t("api.createKey")}
          </Button>
        </div>
      ) : (
        <div className="space-y-2 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground shrink-0">{t("api.selectKey")} :</span>
            {rawKey ? (
              <code className="truncate rounded bg-emerald-500/10 px-2 py-0.5 font-mono text-xs text-emerald-400">
                {rawKey.slice(0, 12)}
                {"•".repeat(20)}
              </code>
            ) : firstKey ? (
              <code className="bg-muted/50 text-foreground truncate rounded px-2 py-0.5 font-mono text-xs">
                {firstKey.keyPrefix}
                {"•".repeat(44)}
              </code>
            ) : null}
            {!rawKey && (
              <span className="text-muted-foreground shrink-0 text-xs">{t("api.keyMasked")}</span>
            )}
          </div>
          <Link to="/org-settings/app/api-keys" className="text-primary text-xs hover:underline">
            {t("api.manageKeys")}
          </Link>
        </div>
      )}

      {/* Key just created banner */}
      {rawKey && (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-4 py-3">
          <p className="text-sm text-emerald-400">{t("api.keyCreated")}</p>
        </div>
      )}

      {/* curl example — JSON (hidden when files are required) */}
      {!hasRequiredFile && (
        <div>
          <div className="mb-2 flex items-center justify-between">
            <h4 className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
              {t("api.curlTitle")}
              {curlMultipart && <span className="ml-1 tracking-normal normal-case">— JSON</span>}
            </h4>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => handleCopy(curlExample)}
            >
              {copied ? t("api.copied") : t("api.copy")}
            </Button>
          </div>
          <pre className="text-foreground bg-muted/50 border-border overflow-x-auto rounded-md border p-4 font-mono text-xs whitespace-pre-wrap">
            {curlExample}
          </pre>
        </div>
      )}

      {/* curl example — multipart (when agent has file inputs) */}
      {curlMultipart && (
        <div>
          <div className="mb-2 flex items-center justify-between">
            <h4 className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
              {t("api.curlTitle")}
              <span className="ml-1 tracking-normal normal-case">— multipart/form-data</span>
            </h4>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => handleCopy(curlMultipart)}
            >
              {copied ? t("api.copied") : t("api.copy")}
            </Button>
          </div>
          <pre className="text-foreground bg-muted/50 border-border overflow-x-auto rounded-md border p-4 font-mono text-xs whitespace-pre-wrap">
            {curlMultipart}
          </pre>
        </div>
      )}

      {/* Response example */}
      <div>
        <h4 className="text-muted-foreground mb-2 text-xs font-medium tracking-wider uppercase">
          {t("api.responseTitle")}
        </h4>
        <pre className="text-foreground bg-muted/50 border-border overflow-x-auto rounded-md border p-4 font-mono text-xs whitespace-pre-wrap">
          {JSON.stringify({ runId: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" }, null, 2)}
        </pre>
        <p className="text-muted-foreground mt-2 text-xs">{t("api.responseHint")}</p>
      </div>

      {/* Docs link */}
      <a
        href="/api/docs"
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary inline-flex items-center gap-1 text-sm hover:underline"
      >
        {t("api.docsLink")} &rarr;
      </a>

      {/* Create API Key Modal */}
      <ApiKeyCreateModal
        open={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        onKeyCreated={handleKeyCreated}
      />
    </div>
  );
}
