import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { usePackageDetail } from "../../hooks/use-packages";
import { useExecutions } from "../../hooks/use-executions";
import { useFlowMemories } from "../../hooks/use-memories";
import { useSchedules } from "../../hooks/use-schedules";
import { useApiKeys } from "../../hooks/use-api-keys";
import { useDeleteMemory } from "../../hooks/use-mutations";
import { useProfiles } from "../../hooks/use-profiles";
import { useFlowReadiness } from "../../hooks/use-flow-readiness";
import type { JSONSchemaObject } from "@appstrate/shared-types";
import { useOrg } from "../../hooks/use-org";
import { useFlowDetailUI } from "../../stores/flow-detail-ui-store";
import { FlowProvidersSection } from "./flow-providers-section";
import { ExecutionRow } from "../execution-row";
import { ScheduleRow } from "../schedule-row";
import { RunFlowButton } from "../run-flow-button";
import { ApiKeyCreateModal } from "../api-key-create-modal";
import {
  Ban,
  BrainCircuit,
  CalendarClock,
  Check,
  Copy,
  Globe,
  Link2Off,
  Play,
  Plus,
  Trash2,
} from "lucide-react";
import {
  useShareLinks,
  useCreateShareLink,
  useUpdateShareLink,
  useDeleteShareLink,
  type ShareLink,
} from "../../hooks/use-share-links";
import { Modal } from "../modal";
import { EmptyState } from "../page-states";
import { formatDateField } from "../../lib/markdown";

export function FlowExecutionsTab({
  packageId,
  resolvedVersion,
  configSchemaOverride,
}: {
  packageId: string;
  resolvedVersion: string | undefined;
  configSchemaOverride?: JSONSchemaObject;
}) {
  const { t } = useTranslation(["flows", "common"]);
  const { data: detail } = usePackageDetail("flow", packageId);
  const { data: executions } = useExecutions(packageId);
  const profileMap = useProfiles(
    (executions ?? []).map((e) => e.userId).filter((id): id is string => !!id),
  );
  const readiness = useFlowReadiness(detail, undefined, undefined, configSchemaOverride);

  if (!detail) return null;

  const {
    allConnected,
    hasReconnectionNeeded,
    hasRequiredConfig,
    hasPrompt,
    hasRequiredSkills,
    hasRequiredTools,
  } = readiness;
  const runDisabled =
    !hasPrompt ||
    !hasRequiredSkills ||
    !hasRequiredTools ||
    !allConnected ||
    hasReconnectionNeeded ||
    !hasRequiredConfig;

  return (
    <>
      {!executions || executions.length === 0 ? (
        <EmptyState message={t("detail.emptyExec")} icon={Play} compact>
          <RunFlowButton
            packageId={packageId}
            detail={detail}
            version={resolvedVersion}
            disabled={runDisabled}
            showLabel
          />
        </EmptyState>
      ) : (
        <div className="space-y-1">
          {executions.map((exec, index) => (
            <ExecutionRow
              key={exec.id}
              execution={exec}
              executionNumber={executions.length - index}
              userName={exec.userId ? profileMap.get(exec.userId) : undefined}
            />
          ))}
        </div>
      )}
    </>
  );
}

export function FlowSchedulesTab({ packageId }: { packageId: string }) {
  const { t } = useTranslation(["flows", "common"]);
  const { data: detail } = usePackageDetail("flow", packageId);
  const { data: schedules } = useSchedules(packageId);
  const setEditingSchedule = useFlowDetailUI((s) => s.setEditingSchedule);
  const setScheduleOpen = useFlowDetailUI((s) => s.setScheduleOpen);

  if (!detail) return null;

  const hasFileInput =
    detail.input?.schema?.properties &&
    Object.values(detail.input.schema.properties).some((p) => p.type === "file");

  if (hasFileInput) {
    return <EmptyState message={t("schedule.fileInputBlocked")} icon={Ban} compact />;
  }

  return (
    <>
      {!schedules || schedules.length === 0 ? (
        <EmptyState message={t("detail.emptySchedule")} icon={CalendarClock} compact>
          <Button
            onClick={() => {
              setEditingSchedule(null);
              setScheduleOpen(true);
            }}
          >
            {t("btn.add")}
          </Button>
        </EmptyState>
      ) : (
        <div className="space-y-1">
          {schedules.map((sched) => (
            <ScheduleRow
              key={sched.id}
              schedule={sched}
              onClick={() => {
                setEditingSchedule(sched);
                setScheduleOpen(true);
              }}
            />
          ))}
        </div>
      )}
    </>
  );
}

export function FlowConnectorsTab({ packageId }: { packageId: string }) {
  return <FlowProvidersSection packageId={packageId} />;
}

export function FlowMemoriesTab({
  packageId,
  isOrgAdmin,
}: {
  packageId: string;
  isOrgAdmin: boolean;
}) {
  const { t } = useTranslation(["flows", "common"]);
  const { data: memories } = useFlowMemories(packageId);
  const deleteMemory = useDeleteMemory(packageId);

  return (
    <>
      {!memories || memories.length === 0 ? (
        <EmptyState
          message={t("detail.emptyMemories")}
          hint={t("detail.emptyMemoriesHint")}
          icon={BrainCircuit}
          compact
        />
      ) : (
        <div className="space-y-1">
          {memories.map((mem) => (
            <div
              key={mem.id}
              className="flex items-center gap-3 rounded-md border border-border px-3 py-2"
            >
              <span className="flex-1 text-sm text-foreground truncate">{mem.content}</span>
              <span className="text-xs text-muted-foreground whitespace-nowrap">
                {mem.createdAt ? formatDateField(mem.createdAt) : ""}
              </span>
              {isOrgAdmin && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => deleteMemory.mutate(mem.id)}
                  disabled={deleteMemory.isPending}
                >
                  {t("btn.delete")}
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────

function buildInputExample(
  properties?: Record<
    string,
    { type?: string; default?: unknown; enum?: unknown[]; placeholder?: string }
  >,
): Record<string, unknown> {
  if (!properties) return {};
  const example: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(properties)) {
    if (prop.type === "file") continue;
    if (prop.default !== undefined) {
      example[key] = prop.default;
    } else if (prop.enum && prop.enum.length > 0) {
      example[key] = prop.enum[0];
    } else if (prop.type === "number" || prop.type === "integer") {
      example[key] = 0;
    } else if (prop.type === "boolean") {
      example[key] = false;
    } else {
      example[key] = prop.placeholder || "";
    }
  }
  return example;
}

interface CurlParams {
  packageId: string;
  orgId: string;
  authToken: string;
  inputSchema?: {
    properties?: Record<
      string,
      {
        type?: string;
        default?: unknown;
        enum?: unknown[];
        placeholder?: string;
        multiple?: boolean;
      }
    >;
  };
  baseUrl: string;
}

function buildCurlExample(params: CurlParams): string {
  const { packageId, orgId, authToken, inputSchema, baseUrl } = params;
  const url = `${baseUrl}/api/flows/${packageId}/run`;

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
  const url = `${baseUrl}/api/flows/${packageId}/run`;

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
    if (prop.type !== "file") continue;
    lines.push(`  -F '${key}=@/path/to/${key}.pdf' \\`);
  }

  // Remove trailing backslash from the last line
  const last = lines.length - 1;
  lines[last] = lines[last].replace(/ \\$/, "");

  return lines.join("\n");
}

// ─── Flow API Tab ─────────────────────────────────────────────────────

export function FlowApiTab({ packageId, isOrgAdmin }: { packageId: string; isOrgAdmin: boolean }) {
  const { t } = useTranslation(["flows", "common"]);
  const { data: detail } = usePackageDetail("flow", packageId);
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
        .filter(([, p]: [string, { type?: string }]) => p.type === "file")
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
    <div className="rounded-lg border border-border bg-card p-5 space-y-5">
      <h3 className="text-sm font-medium text-foreground">{t("api.title")}</h3>

      {/* API Key section */}
      {keysLoading ? (
        <div className="text-sm text-muted-foreground">{t("btn.loading", { ns: "common" })}</div>
      ) : !firstKey && !rawKey ? (
        <div className="rounded-md border border-warning/30 bg-warning/5 px-4 py-3">
          <p className="text-sm text-warning">{t("api.noKey")}</p>
          <p className="text-xs text-muted-foreground mt-1">
            {isOrgAdmin ? t("api.noKeyHint") : t("api.noKeyNonAdmin")}
          </p>
          {isOrgAdmin && (
            <Button size="sm" className="mt-2" onClick={() => setCreateModalOpen(true)}>
              {t("api.createKey")}
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-2 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground shrink-0">{t("api.selectKey")} :</span>
            {rawKey ? (
              <code className="rounded bg-emerald-500/10 text-emerald-400 px-2 py-0.5 text-xs font-mono truncate">
                {rawKey.slice(0, 12)}
                {"•".repeat(20)}
              </code>
            ) : firstKey ? (
              <code className="rounded bg-muted/50 px-2 py-0.5 text-xs font-mono text-foreground truncate">
                {firstKey.keyPrefix}
                {"•".repeat(44)}
              </code>
            ) : null}
            {!rawKey && (
              <span className="text-xs text-muted-foreground shrink-0">{t("api.keyMasked")}</span>
            )}
          </div>
          <Link to="/org-settings#api-keys" className="text-xs text-primary hover:underline">
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
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              {t("api.curlTitle")}
              {curlMultipart && <span className="normal-case tracking-normal ml-1">— JSON</span>}
            </h4>
            <Button
              variant="ghost"
              size="sm"
              className="text-xs h-7"
              onClick={() => handleCopy(curlExample)}
            >
              {copied ? t("api.copied") : t("api.copy")}
            </Button>
          </div>
          <pre className="whitespace-pre-wrap text-xs font-mono text-foreground bg-muted/50 rounded-md p-4 overflow-x-auto border border-border">
            {curlExample}
          </pre>
        </div>
      )}

      {/* curl example — multipart (when flow has file inputs) */}
      {curlMultipart && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              {t("api.curlTitle")}
              <span className="normal-case tracking-normal ml-1">— multipart/form-data</span>
            </h4>
            <Button
              variant="ghost"
              size="sm"
              className="text-xs h-7"
              onClick={() => handleCopy(curlMultipart)}
            >
              {copied ? t("api.copied") : t("api.copy")}
            </Button>
          </div>
          <pre className="whitespace-pre-wrap text-xs font-mono text-foreground bg-muted/50 rounded-md p-4 overflow-x-auto border border-border">
            {curlMultipart}
          </pre>
        </div>
      )}

      {/* Response example */}
      <div>
        <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
          {t("api.responseTitle")}
        </h4>
        <pre className="whitespace-pre-wrap text-xs font-mono text-foreground bg-muted/50 rounded-md p-4 overflow-x-auto border border-border">
          {JSON.stringify({ executionId: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" }, null, 2)}
        </pre>
        <p className="text-xs text-muted-foreground mt-2">{t("api.responseHint")}</p>
      </div>

      {/* Docs link */}
      <a
        href="/api/docs"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
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

// ─── Share Links Tab ──────────────────────────────────────────

function ShareLinkStatus({ link }: { link: ShareLink }) {
  const { t } = useTranslation(["flows"]);
  const now = new Date();
  const expired = new Date(link.expiresAt) < now;
  const exhausted = link.maxUses !== null && link.usageCount >= link.maxUses;

  if (!link.isActive)
    return (
      <span className="text-xs text-muted-foreground bg-muted rounded px-1.5 py-0.5">
        {t("shareLinks.inactive")}
      </span>
    );
  if (expired)
    return (
      <span className="text-xs text-destructive bg-destructive/10 rounded px-1.5 py-0.5">
        {t("shareLinks.expired")}
      </span>
    );
  if (exhausted)
    return (
      <span className="text-xs text-orange-500 bg-orange-500/10 rounded px-1.5 py-0.5">
        {t("shareLinks.exhausted")}
      </span>
    );
  return (
    <span className="text-xs text-green-500 bg-green-500/10 rounded px-1.5 py-0.5">
      {t("shareLinks.active")}
    </span>
  );
}

function ShareLinkRow({
  link,
  onToggle,
  onDelete,
}: {
  link: ShareLink;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation(["flows", "common"]);
  const [copied, setCopied] = useState(false);

  const copyUrl = () => {
    navigator.clipboard.writeText(`${window.location.origin}/share/${link.token}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const usageLabel =
    link.maxUses !== null ? `${link.usageCount} / ${link.maxUses}` : `${link.usageCount} / ∞`;

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
      <Globe size={16} className="text-muted-foreground shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm truncate">
            {link.label || t("shareLinks.untitled")}
          </span>
          <ShareLinkStatus link={link} />
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
          <span>
            {usageLabel} {t("shareLinks.uses")}
          </span>
          <span>·</span>
          <span>{formatDateField(link.expiresAt)}</span>
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={copyUrl}
          title={t("share.copyLink")}
        >
          {copied ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={onToggle}
          title={link.isActive ? t("shareLinks.deactivate") : t("shareLinks.activate")}
        >
          <Link2Off
            size={14}
            className={link.isActive ? "text-muted-foreground" : "text-green-500"}
          />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-destructive hover:text-destructive"
          onClick={onDelete}
          title={t("btn.delete")}
        >
          <Trash2 size={14} />
        </Button>
      </div>
    </div>
  );
}

export function FlowShareLinksTab({ packageId }: { packageId: string }) {
  const { t } = useTranslation(["flows", "common"]);
  const { data: links } = useShareLinks(packageId);
  const createLink = useCreateShareLink(packageId);
  const updateLink = useUpdateShareLink(packageId);
  const deleteLink = useDeleteShareLink(packageId);
  const [createOpen, setCreateOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [maxUses, setMaxUses] = useState("");
  const [expiresInDays, setExpiresInDays] = useState("7");

  const handleCreate = () => {
    createLink.mutate(
      {
        label: label.trim() || undefined,
        maxUses: maxUses ? parseInt(maxUses) : null,
        expiresInDays: parseInt(expiresInDays) || 7,
      },
      {
        onSuccess: () => {
          setCreateOpen(false);
          setLabel("");
          setMaxUses("");
          setExpiresInDays("7");
        },
      },
    );
  };

  return (
    <>
      {!links || links.length === 0 ? (
        <EmptyState message={t("shareLinks.empty")} icon={Globe} compact>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus size={14} className="mr-1" />
            {t("shareLinks.create")}
          </Button>
        </EmptyState>
      ) : (
        <div className="space-y-1">
          <div className="flex justify-end mb-2">
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus size={14} className="mr-1" />
              {t("shareLinks.create")}
            </Button>
          </div>
          {links.map((link) => (
            <ShareLinkRow
              key={link.id}
              link={link}
              onToggle={() => updateLink.mutate({ id: link.id, isActive: !link.isActive })}
              onDelete={() => deleteLink.mutate(link.id)}
            />
          ))}
        </div>
      )}

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title={t("shareLinks.createTitle")}
      >
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium">{t("shareLinks.labelField")}</label>
            <input
              type="text"
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              placeholder={t("shareLinks.labelPlaceholder")}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={100}
            />
          </div>
          <div>
            <label className="text-sm font-medium">{t("shareLinks.maxUsesField")}</label>
            <input
              type="number"
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              placeholder={t("shareLinks.maxUsesPlaceholder")}
              value={maxUses}
              onChange={(e) => setMaxUses(e.target.value)}
              min={1}
            />
            <p className="text-xs text-muted-foreground mt-1">{t("shareLinks.maxUsesHint")}</p>
          </div>
          <div>
            <label className="text-sm font-medium">{t("shareLinks.expiresField")}</label>
            <input
              type="number"
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={expiresInDays}
              onChange={(e) => setExpiresInDays(e.target.value)}
              min={1}
              max={365}
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              {t("btn.cancel", { ns: "common" })}
            </Button>
            <Button onClick={handleCreate} disabled={createLink.isPending}>
              {createLink.isPending ? t("shareLinks.creating") : t("shareLinks.create")}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
