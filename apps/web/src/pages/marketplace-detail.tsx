import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  Download,
  ExternalLink,
  Scale,
  CheckCircle,
  ArrowUpCircle,
  AlertTriangle,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { apiBlob } from "../api";
import {
  useMarketplacePackage,
  useInstallPackage,
  useUpdatePackage,
} from "../hooks/use-marketplace";
import { usePackageVersions } from "../hooks/use-packages";
import { useRegistryStatus, useRegistryScopes } from "../hooks/use-registry";
import { usePublishPlanModal } from "../hooks/use-publish-plan-modal";
import { LoadingState, ErrorState } from "../components/page-states";
import { TypeBadge } from "../components/type-badge";
import { Spinner } from "../components/spinner";
import { PublishPlanModal } from "../components/publish-plan-modal";
import { Markdown, InlineMarkdown } from "../components/markdown";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function MarketplaceDetailPage() {
  const { t } = useTranslation(["settings", "common"]);
  const params = useParams();

  // URL is /marketplace/@scope/name — strip the @ prefix from scope
  const scope = params.scope?.replace(/^@/, "");
  const name = params.name;

  const { data: pkg, isLoading, error } = useMarketplacePackage(scope, name);
  const install = useInstallPackage();
  const update = useUpdatePackage();
  const { data: registryStatus } = useRegistryStatus();
  const { data: registryScopes } = useRegistryScopes();
  const [selectedVersion, setSelectedVersion] = useState<string | undefined>(undefined);
  const publishPlan = usePublishPlanModal();
  const localPackageId = scope && name ? `@${scope}/${name}` : undefined;
  const { data: localVersions } = usePackageVersions(pkg?.type ?? "flow", localPackageId);
  const localIntegrities = new Set(localVersions?.map((v) => v.integrity));

  const handlePublish = () => {
    if (!scope || !name) return;
    // Pass the local version ahead or installed version so we publish from a stored version ZIP
    const versionToPublish = pkg?.localVersionAhead ?? pkg?.installedVersion ?? undefined;
    publishPlan.open(`@${scope}/${name}`, versionToPublish);
  };

  if (isLoading) {
    return (
      <div className="max-w-[900px]">
        <LoadingState />
      </div>
    );
  }

  if (error || !pkg) {
    return (
      <div className="max-w-[900px]">
        <ErrorState message={error?.message} />
      </div>
    );
  }

  const isInstalled = pkg.installedVersion !== null;

  // Determine latest version from distTags or last version in list
  const latestTag = pkg.distTags?.find((t: { tag: string }) => t.tag === "latest");
  const latestVersion = latestTag
    ? (pkg.versions.find((v) => v.id === latestTag.versionId)?.version ?? null)
    : (pkg.versions[pkg.versions.length - 1]?.version ?? null);
  const hasUpdate = isInstalled && !!latestVersion && latestVersion !== pkg.installedVersion;

  const handleInstall = () => {
    if (!scope || !name) return;
    const version = selectedVersion ?? pkg.versions[0]?.version;
    install.mutate(
      { scope, name, version },
      {
        onError: (err) => alert(t("error.prefix", { message: err.message })),
      },
    );
  };

  const handleDownloadVersion = async (version: string) => {
    if (!scope || !name) return;
    try {
      const blob = await apiBlob(`/packages/@${scope}/${name}/${version}/download`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${scope}-${name}-${version}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      // Silently fail — user sees no file downloaded
    }
  };

  const handleUpdate = () => {
    if (!scope || !name) return;
    update.mutate(
      { scope, name },
      {
        onError: (err) => alert(t("error.prefix", { message: err.message })),
      },
    );
  };

  const publishAheadBadge = pkg.localVersionAhead && (
    <>
      <span className="inline-flex items-center gap-1.5 text-xs text-warning">
        <Upload size={14} />
        {t("marketplace.localVersionAhead", { version: pkg.localVersionAhead })}
      </span>
      <Button size="sm" onClick={handlePublish} disabled={publishPlan.isFetching}>
        {publishPlan.isFetching ? <Spinner /> : t("marketplace.publishAction")}
      </Button>
    </>
  );

  return (
    <div className="max-w-[900px]">
      <Link
        to="/marketplace"
        className="flex items-center gap-1.5 text-sm text-muted-foreground mb-4 hover:text-foreground"
      >
        <ArrowLeft size={14} />
        <span>{t("marketplace.backToMarketplace")}</span>
      </Link>

      <div className="flex flex-col gap-2 mb-6">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold">{pkg.displayName || `${pkg.scope}/${pkg.name}`}</h2>
          <TypeBadge type={pkg.type} />
        </div>
        {pkg.description && (
          <InlineMarkdown className="text-sm text-muted-foreground leading-relaxed">
            {pkg.description}
          </InlineMarkdown>
        )}

        <div className="flex items-center gap-4 flex-wrap">
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <Download size={14} />
            {t("marketplace.downloads", { count: pkg.downloads })}
          </span>
          {pkg.license && (
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <Scale size={14} />
              {pkg.license}
            </span>
          )}
          {pkg.repositoryUrl && (
            <a
              href={pkg.repositoryUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-primary no-underline hover:underline"
            >
              <ExternalLink size={14} />
              {t("marketplace.repository")}
            </a>
          )}
          {registryStatus?.connected && registryScopes?.some((s) => s.name === scope) && (
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <CheckCircle size={14} />
              {t("marketplace.ownedByYou")}
            </span>
          )}
        </div>
      </div>

      <div className="mb-6">
        {isInstalled ? (
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs text-success">
              <CheckCircle size={14} />
              {t("marketplace.installedVersion", { version: pkg.installedVersion })}
            </span>
            {pkg.localVersionAhead ? (
              <>{publishAheadBadge}</>
            ) : hasUpdate ? (
              <>
                <span className="inline-flex items-center gap-1.5 text-xs text-warning">
                  <ArrowUpCircle size={14} />
                  {t("marketplace.updateAvailable", { version: latestVersion })}
                </span>
                <Button size="sm" onClick={handleUpdate} disabled={update.isPending}>
                  {update.isPending ? <Spinner /> : t("marketplace.update")}
                </Button>
              </>
            ) : (
              <span className="text-xs text-muted-foreground">{t("marketplace.upToDate")}</span>
            )}
          </div>
        ) : pkg.integrityConflict ? (
          <div className="flex items-center gap-2">
            {pkg.localVersionAhead ? (
              <>{publishAheadBadge}</>
            ) : (
              <>
                <span className="inline-flex items-center gap-1.5 text-xs text-warning">
                  <AlertTriangle size={14} />
                  {t("marketplace.integrityConflict")}
                </span>
                <Button
                  size="sm"
                  disabled={install.isPending}
                  onClick={() => {
                    if (!scope || !name) return;
                    if (!window.confirm(t("marketplace.integrityConflictConfirm"))) return;
                    const version = selectedVersion ?? pkg.versions[0]?.version;
                    install.mutate(
                      { scope, name, version, force: true },
                      {
                        onError: (err) => alert(t("error.prefix", { message: err.message })),
                      },
                    );
                  }}
                >
                  {install.isPending ? <Spinner /> : t("marketplace.install")}
                </Button>
              </>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2">
            {pkg.versions.length > 0 && (
              <Select
                value={selectedVersion ?? pkg.versions[0]?.version ?? ""}
                onValueChange={setSelectedVersion}
              >
                <SelectTrigger className="w-[100px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {pkg.versions.map((v) => (
                    <SelectItem key={v.id} value={v.version}>
                      v{v.version}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Button
              size="sm"
              onClick={handleInstall}
              disabled={install.isPending || pkg.versions.length === 0}
            >
              {install.isPending ? <Spinner /> : t("marketplace.install")}
            </Button>
          </div>
        )}
        {install.isSuccess && (
          <p className="mt-2 text-sm text-success">
            {t("marketplace.installSuccess")}
            {install.data?.autoInstalledDeps && install.data.autoInstalledDeps.length > 0 && (
              <>
                {" "}
                —{" "}
                {t("marketplace.autoInstalledDeps", {
                  count: install.data.autoInstalledDeps.length,
                })}
              </>
            )}
          </p>
        )}
        {update.isSuccess && (
          <p className="mt-2 text-sm text-success">
            {t("marketplace.updateSuccess")}
            {update.data?.autoInstalledDeps && update.data.autoInstalledDeps.length > 0 && (
              <>
                {" "}
                —{" "}
                {t("marketplace.autoInstalledDeps", {
                  count: update.data.autoInstalledDeps.length,
                })}
              </>
            )}
          </p>
        )}
      </div>

      {pkg.readme && (
        <div className="mb-6">
          <h3 className="text-sm font-semibold text-muted-foreground mb-2">
            {t("marketplace.readme")}
          </h3>
          <Markdown className="text-sm leading-relaxed max-w-none">{pkg.readme}</Markdown>
        </div>
      )}

      {pkg.versions.length > 0 && (
        <div className="mb-6">
          <h3 className="text-sm font-semibold text-muted-foreground mb-2">
            {t("marketplace.versions")}
          </h3>
          <div className="flex flex-col gap-1.5">
            {pkg.versions.map((v) => (
              <div
                key={v.id}
                className="flex items-center justify-between rounded-md border border-border bg-card px-3 py-2 text-sm"
              >
                <span className="font-semibold font-mono">{`v${v.version}`}</span>
                {localIntegrities.has(v.integrity) && (
                  <CheckCircle size={14} className="text-success" />
                )}
                <span className="text-xs text-muted-foreground">{formatBytes(v.artifactSize)}</span>
                <span className="text-xs text-muted-foreground">
                  {new Date(v.createdAt).toLocaleDateString()}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  title={t("marketplace.downloadVersion")}
                  onClick={() => handleDownloadVersion(v.version)}
                >
                  <Download size={14} />
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      {pkg.keywords.length > 0 && (
        <div className="mb-6">
          <h3 className="text-sm font-semibold text-muted-foreground mb-2">
            {t("marketplace.keywords")}
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {pkg.keywords.map((kw) => (
              <span
                key={kw}
                className="inline-block rounded border border-border bg-card px-2 py-0.5 text-xs text-muted-foreground"
              >
                {kw}
              </span>
            ))}
          </div>
        </div>
      )}

      {publishPlan.hasPlan && <PublishPlanModal {...publishPlan.modalProps} />}
    </div>
  );
}
