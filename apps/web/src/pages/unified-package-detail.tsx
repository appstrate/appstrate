import { useState, useEffect } from "react";
import { useParams, Link, Navigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useTabWithHash } from "../hooks/use-tab-with-hash";
import type { FlowDetail } from "@appstrate/shared-types";
import {
  useFlowDetail,
  usePackageDetail,
  useVersionDetail,
  usePackageDownload,
  useDeletePackage,
  type PackageType,
} from "../hooks/use-packages";
import { useOrg } from "../hooks/use-org";
import { useProxies, useFlowProxy, useSetFlowProxy } from "../hooks/use-proxies";
import { LoadingState } from "../components/page-states";
import { getVersionRedirect } from "../lib/version-helpers";

// Shared components
import { SharedHeader } from "../components/package-detail/shared-header";
import { VersionBanners } from "../components/version-banners";
import { VersionHistory } from "../components/version-history";
import { DraftDiffView } from "../components/draft-diff-view";
import { CreateVersionModal } from "../components/create-version-modal";
import { ProfileSelector } from "../components/profile-selector";

// Flow-specific components
import { FlowDetailProvider } from "../contexts/flow-detail-context";
import { FlowServicesSection } from "../components/package-detail/flow-services-section";
import { FlowActions } from "../components/package-detail/flow-actions";
import {
  FlowExecutionsTab,
  FlowSchedulesTab,
  FlowMemoriesTab,
} from "../components/package-detail/flow-tabs";
import { FlowModals } from "../components/package-detail/flow-modals";

type DetailTab =
  | "executions"
  | "schedules"
  | "memories"
  | "versions"
  | "changes"
  | "content"
  | "usedBy";

// ─── Flow Header Extras ─────────────────────────────────────────────

function FlowHeaderExtras({ packageId }: { packageId: string }) {
  const { t } = useTranslation("settings");
  const { isOrgAdmin } = useOrg();
  const { data: orgProxies } = useProxies();
  const { data: flowProxy } = useFlowProxy(packageId);
  const setFlowProxy = useSetFlowProxy(packageId);

  return (
    <>
      {isOrgAdmin && orgProxies && orgProxies.length > 0 && (
        <div className="flex items-center gap-2">
          <Label className="text-muted-foreground whitespace-nowrap">
            {t("proxies.flow.label")}
          </Label>
          <Select
            value={flowProxy?.proxyId ?? "__inherit__"}
            onValueChange={(val) => setFlowProxy.mutate(val === "__inherit__" ? null : val)}
            disabled={setFlowProxy.isPending}
          >
            <SelectTrigger className="w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__inherit__">{t("proxies.flow.inherit")}</SelectItem>
              <SelectItem value="none">{t("proxies.flow.none")}</SelectItem>
              {orgProxies.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      <ProfileSelector />
    </>
  );
}

// ─── Main Page ──────────────────────────────────────────────────────

export function UnifiedPackageDetailPage({ type }: { type: "flow" | "skill" | "extension" }) {
  const { t } = useTranslation(["flows", "settings", "common"]);
  const {
    scope,
    name,
    version: versionParam,
  } = useParams<{ scope: string; name: string; version?: string }>();
  const packageId = `${scope}/${name}`;
  const { isOrgAdmin } = useOrg();
  const isVersionView = !!versionParam;

  // ── Data loading (type-specific) ──
  const flowQuery = useFlowDetail(type === "flow" ? packageId : undefined);
  const pkgQuery = usePackageDetail(
    type === "flow" ? "skill" : (type as PackageType),
    type !== "flow" ? packageId : undefined,
  );
  const isLoading = type === "flow" ? flowQuery.isLoading : pkgQuery.isLoading;
  const error = type === "flow" ? flowQuery.error : pkgQuery.error;

  // Unified detail values
  const flowDetail = flowQuery.data;
  const pkgDetail = pkgQuery.data;

  const displayName =
    type === "flow" ? (flowDetail?.displayName ?? "") : (pkgDetail?.name ?? pkgDetail?.id ?? "");
  const source = type === "flow" ? flowDetail?.source : pkgDetail?.source;
  const version = type === "flow" ? flowDetail?.version : pkgDetail?.version;
  const versionCount = type === "flow" ? flowDetail?.versionCount : pkgDetail?.versionCount;
  const hasUnpublishedChanges =
    type === "flow" ? flowDetail?.hasUnpublishedChanges : pkgDetail?.hasUnpublishedChanges;

  const { data: versionDetail, isLoading: versionLoading } = useVersionDetail(
    type,
    packageId,
    versionParam,
  );

  const hasDraftChanges = source !== "built-in" && !!hasUnpublishedChanges;
  const { data: latestVersionForDiff } = useVersionDetail(
    type,
    packageId,
    hasDraftChanges ? "latest" : undefined,
  );

  const downloadPackage = usePackageDownload(scope, name);
  const deletePkgMutation = useDeletePackage(type === "flow" ? "skill" : (type as PackageType));

  // ── State ──
  const allValidTabs: DetailTab[] = [
    "executions",
    "schedules",
    "memories",
    "versions",
    "changes",
    "content",
    "usedBy",
  ];
  const defaultTab: DetailTab = type === "flow" ? "executions" : "content";
  const [tab, setTab] = useTabWithHash<DetailTab>(allValidTabs, defaultTab);
  // Reset tab if it becomes invalid (e.g. #changes when draft is published)
  useEffect(() => {
    if (tab === "changes" && (!hasDraftChanges || isVersionView)) setTab(defaultTab);
    if (tab === "versions" && source === "built-in") setTab(defaultTab);
  }, [tab, hasDraftChanges, isVersionView, source, defaultTab, setTab]);

  const [createVersionOpen, setCreateVersionOpen] = useState(false);
  const [diffTabOverride, setDiffTab] = useState<"prompt" | "manifest" | "content" | null>(null);

  // ── Loading / Error ──
  if (isLoading || (isVersionView && versionLoading)) return <LoadingState />;
  if (error || (type === "flow" && !flowDetail) || (type !== "flow" && !pkgDetail)) {
    return <Navigate to="/" replace />;
  }

  // ── Version redirect ──
  const versionResult = getVersionRedirect({
    type,
    packageId,
    versionParam,
    versionDetail,
    liveVersion: version,
  });
  if ("redirect" in versionResult) {
    return <Navigate to={versionResult.redirect} replace />;
  }
  const { isHistoricalVersion } = versionResult;

  const downloadVersion = isHistoricalVersion ? versionDetail?.version : version;

  // ── Unified detail for SharedHeader ──
  const unifiedForHeader = {
    id: packageId,
    displayName,
    description: type === "flow" ? flowDetail!.description : (pkgDetail?.description ?? ""),
    source: source ?? ("local" as const),
    type,
    version,
    versionCount,
    hasUnpublishedChanges,
  };

  // ── Diff tab logic ──
  const currentManifest = type === "flow" ? flowDetail?.manifest : pkgDetail?.manifest;

  const hasPromptChanges = type === "flow" && flowDetail?.prompt !== latestVersionForDiff?.prompt;
  const hasManifestChanges =
    JSON.stringify(currentManifest ?? {}) !== JSON.stringify(latestVersionForDiff?.manifest ?? {});
  const hasContentChanges =
    type !== "flow" &&
    latestVersionForDiff?.content != null &&
    pkgDetail?.content != null &&
    latestVersionForDiff.content !== pkgDetail.content;

  const diffTab = (() => {
    if (type === "flow") {
      const preferred = diffTabOverride ?? "manifest";
      if (preferred === "prompt" && !hasPromptChanges && hasManifestChanges) return "manifest";
      if (preferred === "manifest" && !hasManifestChanges && hasPromptChanges) return "prompt";
      return preferred;
    }
    // Skills/Extensions: manifest + content tabs
    const preferred = diffTabOverride ?? "manifest";
    if (preferred === "content" && !hasContentChanges && hasManifestChanges) return "manifest";
    if (preferred === "manifest" && !hasManifestChanges && hasContentChanges) return "content";
    return preferred;
  })();

  // ── Render ──
  const isBuiltIn = source === "built-in";
  const flowForProvider = flowDetail as FlowDetail;

  // Determine available tabs based on type
  const flowTabs: Array<{ id: DetailTab; label: string; badge?: string }> = [
    { id: "executions", label: t("detail.tabExecutions") },
    {
      id: "schedules",
      label: t("detail.tabSchedules"),
    },
    {
      id: "memories",
      label: t("detail.tabMemories"),
    },
  ];

  const pkgTabs: Array<{ id: DetailTab; label: string }> = [
    { id: "content", label: t("packages.content") },
    { id: "usedBy", label: t("packages.usedBy") },
  ];

  const tabDefs = type === "flow" ? flowTabs : pkgTabs;

  const resolvedVersion = isHistoricalVersion ? versionDetail?.version : undefined;

  const renderContent = () => (
    <>
      <SharedHeader
        detail={unifiedForHeader}
        packageId={packageId}
        versionParam={versionParam}
        hasDraftChanges={hasDraftChanges}
        isVersionView={isVersionView}
        isHistoricalVersion={isHistoricalVersion}
        headerExtras={type === "flow" ? <FlowHeaderExtras packageId={packageId} /> : undefined}
      />

      <VersionBanners isHistorical={isHistoricalVersion} versionDetail={versionDetail} />

      {/* Flow: Services section */}
      {type === "flow" && <FlowServicesSection />}

      {/* Actions */}
      {type === "flow" ? (
        <FlowActions
          isOrgAdmin={isOrgAdmin}
          isHistoricalVersion={isHistoricalVersion}
          hasDraftChanges={hasDraftChanges}
          resolvedVersion={resolvedVersion}
          downloadVersion={downloadVersion ?? undefined}
          downloadPackage={downloadPackage}
          onCreateVersion={() => setCreateVersionOpen(true)}
        />
      ) : (
        isOrgAdmin &&
        !isBuiltIn &&
        !isHistoricalVersion && (
          <div className="flex items-center gap-2 flex-wrap mb-4">
            {downloadVersion && (
              <Button
                variant="ghost"
                size="sm"
                title={t("btn.download", { ns: "common" })}
                onClick={() => downloadPackage(downloadVersion)}
              >
                <Download size={14} /> {t("btn.download", { ns: "common" })}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCreateVersionOpen(true)}
              disabled={!hasDraftChanges}
            >
              {t("version.createVersion")}
            </Button>
            <Link to={`/${type}s/${packageId}/edit`}>
              <Button variant="outline" size="sm">
                {t("btn.edit")}
              </Button>
            </Link>
            {pkgDetail && pkgDetail.flows.length === 0 && (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => {
                  const nameStr = pkgDetail.name || pkgDetail.id;
                  const typeLabel = t(`packages.type.${type}`, { ns: "settings" });
                  if (
                    !confirm(
                      t("packages.deleteConfirm", {
                        type: typeLabel,
                        name: nameStr,
                        ns: "settings",
                      }),
                    )
                  )
                    return;
                  deletePkgMutation.mutate(packageId, {
                    onError: (err) =>
                      alert(
                        err instanceof Error
                          ? err.message
                          : t("packages.deleteDependedOn", { ns: "settings" }),
                      ),
                  });
                }}
                disabled={deletePkgMutation.isPending}
              >
                {t("btn.delete")}
              </Button>
            )}
          </div>
        )
      )}

      {/* Tab bar */}
      <Tabs value={tab} onValueChange={(v) => setTab(v as DetailTab)} className="mb-4">
        <TabsList>
          {tabDefs.map((td) => (
            <TabsTrigger key={td.id} value={td.id}>
              {td.label}
            </TabsTrigger>
          ))}
          {!isBuiltIn && (
            <TabsTrigger value="versions">
              {t("version.history")}
              {versionCount ? ` (${versionCount})` : ""}
            </TabsTrigger>
          )}
          {hasDraftChanges && !isVersionView && (
            <TabsTrigger value="changes">{t("version.diff")}</TabsTrigger>
          )}
        </TabsList>
      </Tabs>

      {/* Tab content */}
      {type === "flow" && tab === "executions" && (
        <FlowExecutionsTab isOrgAdmin={isOrgAdmin} resolvedVersion={resolvedVersion} />
      )}
      {type === "flow" && tab === "schedules" && <FlowSchedulesTab />}
      {type === "flow" && tab === "memories" && <FlowMemoriesTab isOrgAdmin={isOrgAdmin} />}

      {type !== "flow" && tab === "content" && pkgDetail && (
        <div className="rounded-lg border border-border bg-card p-4">
          <pre className="whitespace-pre-wrap text-xs font-mono text-muted-foreground bg-muted/50 rounded-md p-3 overflow-x-auto">
            {isHistoricalVersion && versionDetail?.content != null
              ? versionDetail.content
              : pkgDetail.content}
          </pre>
        </div>
      )}

      {type !== "flow" && tab === "usedBy" && pkgDetail && (
        <div className="rounded-lg border border-border bg-card p-4">
          {pkgDetail.flows.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              {t("packages.noFlows")}
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {pkgDetail.flows.map((f) => (
                <Link
                  key={f.id}
                  to={`/flows/${f.id}`}
                  className="inline-flex items-center rounded-md border border-border px-2.5 py-1 text-sm hover:border-primary transition-colors no-underline text-foreground"
                >
                  {f.displayName || f.id}
                </Link>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === "versions" && (
        <VersionHistory packageId={packageId} type={type} isAdmin={isOrgAdmin} />
      )}

      {tab === "changes" && hasDraftChanges && !isVersionView && (
        <>
          {type === "flow" && latestVersionForDiff && (
            <>
              <Tabs
                value={diffTab}
                onValueChange={(v) => setDiffTab(v as "prompt" | "manifest" | "content")}
                className="mb-4"
              >
                <TabsList>
                  {hasManifestChanges && (
                    <TabsTrigger value="manifest">{t("version.diffManifest")}</TabsTrigger>
                  )}
                  {hasPromptChanges && (
                    <TabsTrigger value="prompt">{t("version.diffPrompt")}</TabsTrigger>
                  )}
                </TabsList>
              </Tabs>
              {diffTab === "manifest" && hasManifestChanges && (
                <DraftDiffView
                  original={JSON.stringify(latestVersionForDiff.manifest ?? {}, null, 2)}
                  modified={JSON.stringify(flowDetail?.manifest ?? {}, null, 2)}
                  language="json"
                />
              )}
              {diffTab === "prompt" &&
                hasPromptChanges &&
                flowDetail?.prompt != null &&
                latestVersionForDiff.prompt != null && (
                  <DraftDiffView
                    original={latestVersionForDiff.prompt}
                    modified={flowDetail.prompt}
                    language="markdown"
                  />
                )}
            </>
          )}
          {type !== "flow" && latestVersionForDiff && pkgDetail && (
            <>
              <Tabs
                value={diffTab}
                onValueChange={(v) => setDiffTab(v as "prompt" | "manifest" | "content")}
                className="mb-4"
              >
                <TabsList>
                  {hasManifestChanges && (
                    <TabsTrigger value="manifest">{t("version.diffManifest")}</TabsTrigger>
                  )}
                  {hasContentChanges && (
                    <TabsTrigger value="content">{t("packages.content")}</TabsTrigger>
                  )}
                </TabsList>
              </Tabs>
              {diffTab === "manifest" && hasManifestChanges && (
                <DraftDiffView
                  original={JSON.stringify(latestVersionForDiff.manifest ?? {}, null, 2)}
                  modified={JSON.stringify(pkgDetail.manifest ?? {}, null, 2)}
                  language="json"
                />
              )}
              {diffTab === "content" && hasContentChanges && (
                <DraftDiffView
                  original={latestVersionForDiff.content!}
                  modified={pkgDetail.content}
                />
              )}
              {!hasManifestChanges && !hasContentChanges && (
                <p className="text-sm text-muted-foreground py-4 text-center">
                  {t("version.noDiff")}
                </p>
              )}
            </>
          )}
        </>
      )}

      <CreateVersionModal
        open={createVersionOpen}
        onClose={() => setCreateVersionOpen(false)}
        type={type}
        packageId={packageId}
      />

      {/* Flow modals */}
      {type === "flow" && <FlowModals resolvedVersion={resolvedVersion} />}
    </>
  );

  // Wrap flow pages with FlowDetailProvider
  if (type === "flow" && flowDetail) {
    return (
      <FlowDetailProvider detail={flowForProvider} packageId={packageId} isOrgAdmin={isOrgAdmin}>
        {renderContent()}
      </FlowDetailProvider>
    );
  }

  return renderContent();
}
