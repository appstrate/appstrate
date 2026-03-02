import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Download, ExternalLink, Scale, CheckCircle, ArrowUpCircle } from "lucide-react";
import {
  useMarketplacePackage,
  useInstallPackage,
  useUpdatePackage,
} from "../hooks/use-marketplace";
import { useRegistryStatus, useRegistryScopes } from "../hooks/use-registry";
import { LoadingState, ErrorState } from "../components/page-states";
import { TypeBadge } from "../components/type-badge";
import { Spinner } from "../components/spinner";

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

  if (isLoading) {
    return (
      <div className="marketplace-page">
        <LoadingState />
      </div>
    );
  }

  if (error || !pkg) {
    return (
      <div className="marketplace-page">
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

  const handleUpdate = () => {
    if (!scope || !name) return;
    update.mutate(
      { scope, name },
      {
        onError: (err) => alert(t("error.prefix", { message: err.message })),
      },
    );
  };

  return (
    <div className="marketplace-page">
      <Link to="/marketplace" className="breadcrumb">
        <ArrowLeft size={14} />
        <span>{t("marketplace.backToMarketplace")}</span>
      </Link>

      <div className="marketplace-detail-header">
        <div className="marketplace-detail-title">
          <h2>
            {pkg.scope}/{pkg.name}
          </h2>
          <TypeBadge type={pkg.type} />
        </div>
        <p className="marketplace-detail-desc">{pkg.description}</p>

        <div className="marketplace-detail-meta">
          <span className="marketplace-detail-meta-item">
            <Download size={14} />
            {t("marketplace.downloads", { count: pkg.downloads })}
          </span>
          {pkg.license && (
            <span className="marketplace-detail-meta-item">
              <Scale size={14} />
              {pkg.license}
            </span>
          )}
          {pkg.repositoryUrl && (
            <a
              href={pkg.repositoryUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="marketplace-detail-meta-item marketplace-detail-link"
            >
              <ExternalLink size={14} />
              {t("marketplace.repository")}
            </a>
          )}
          {registryStatus?.connected && registryScopes?.some((s) => s.name === scope) && (
            <span className="marketplace-detail-meta-item">
              <CheckCircle size={14} />
              {t("marketplace.ownedByYou")}
            </span>
          )}
        </div>
      </div>

      <div className="marketplace-detail-actions">
        {isInstalled ? (
          <div className="marketplace-detail-install-row">
            <span className="marketplace-installed-badge">
              <CheckCircle size={14} />
              {t("marketplace.installedVersion", { version: pkg.installedVersion })}
            </span>
            {hasUpdate ? (
              <>
                <span className="marketplace-update-badge">
                  <ArrowUpCircle size={14} />
                  {t("marketplace.updateAvailable", { version: latestVersion })}
                </span>
                <button className="btn-install" onClick={handleUpdate} disabled={update.isPending}>
                  {update.isPending ? <Spinner /> : t("marketplace.update")}
                </button>
              </>
            ) : (
              <span className="marketplace-uptodate">{t("marketplace.upToDate")}</span>
            )}
          </div>
        ) : (
          <div className="marketplace-detail-install-row">
            {pkg.versions.length > 0 && (
              <select
                className="marketplace-version-select"
                value={selectedVersion ?? pkg.versions[0]?.version ?? ""}
                onChange={(e) => setSelectedVersion(e.target.value)}
              >
                {pkg.versions.map((v) => (
                  <option key={v.id} value={v.version}>
                    v{v.version}
                  </option>
                ))}
              </select>
            )}
            <button
              className="btn-install"
              onClick={handleInstall}
              disabled={install.isPending || pkg.versions.length === 0}
            >
              {install.isPending ? <Spinner /> : t("marketplace.install")}
            </button>
          </div>
        )}
        {install.isSuccess && (
          <p className="marketplace-install-success">
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
          <p className="marketplace-install-success">
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
        <div className="marketplace-detail-section">
          <h3>{t("marketplace.readme")}</h3>
          <div className="marketplace-readme">{pkg.readme}</div>
        </div>
      )}

      {pkg.versions.length > 0 && (
        <div className="marketplace-detail-section">
          <h3>{t("marketplace.versions")}</h3>
          <div className="marketplace-versions">
            {pkg.versions.map((v) => (
              <div key={v.id} className="marketplace-version-row">
                <span className="version-tag">v{v.version}</span>
                <span className="version-size">{formatBytes(v.artifactSize)}</span>
                <span className="version-date">{new Date(v.createdAt).toLocaleDateString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {pkg.keywords.length > 0 && (
        <div className="marketplace-detail-section">
          <h3>{t("marketplace.keywords")}</h3>
          <div className="marketplace-keywords">
            {pkg.keywords.map((kw) => (
              <span key={kw} className="marketplace-keyword">
                {kw}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
