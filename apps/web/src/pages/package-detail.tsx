import { useState, useMemo } from "react";
import { useParams, Link, Navigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Check, Download } from "lucide-react";
import type { OrgPackageItemDetail } from "@appstrate/shared-types";
import {
  usePackageDetail,
  useDeletePackage,
  useUpdatePackageMetadata,
  useVersionDetail,
  usePackageDownload,
  type PackageType,
} from "../hooks/use-packages";
import { useOrg } from "../hooks/use-org";

import { TypeBadge } from "../components/type-badge";
import { VersionSelector } from "../components/version-selector";
import { VersionBanners } from "../components/version-banners";
import { Spinner } from "../components/spinner";
import { LoadingState } from "../components/page-states";
import { getVersionRedirect } from "../lib/version-helpers";

const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const SCOPED_NAME_RE = /^@[a-z0-9-]+\/[a-z0-9-]+$/;

function PackageMetadataEditor({
  detail,
  packageId,
  type,
}: {
  detail: OrgPackageItemDetail;
  packageId: string;
  type: PackageType;
}) {
  const { t } = useTranslation("flows");
  const updateMutation = useUpdatePackageMetadata(type);

  const initVersion = detail.version ?? "0.0.0";
  const initDisplayName = detail.name ?? "";
  const initDescription = detail.description ?? "";
  const initScopedName = detail.manifestName ?? detail.id ?? "";

  const [metaVersion, setMetaVersion] = useState(initVersion);
  const [metaDisplayName, setMetaDisplayName] = useState(initDisplayName);
  const [metaDescription, setMetaDescription] = useState(initDescription);
  const [metaScopedName, setMetaScopedName] = useState(initScopedName);
  const [saved, setSaved] = useState(false);

  const versionError = metaVersion && !SEMVER_RE.test(metaVersion);
  const scopedNameError = metaScopedName && !SCOPED_NAME_RE.test(metaScopedName);

  const hasChanges = useMemo(
    () =>
      metaVersion !== initVersion ||
      metaDisplayName !== initDisplayName ||
      metaDescription !== initDescription ||
      metaScopedName !== initScopedName,
    [
      metaVersion,
      metaDisplayName,
      metaDescription,
      metaScopedName,
      initVersion,
      initDisplayName,
      initDescription,
      initScopedName,
    ],
  );

  const handleSave = () => {
    if (versionError || scopedNameError) return;
    const data: Record<string, string> = {};
    if (metaVersion !== initVersion) data.version = metaVersion;
    if (metaDisplayName !== initDisplayName) data.name = metaDisplayName;
    if (metaDescription !== initDescription) data.description = metaDescription;
    if (metaScopedName !== initScopedName) data.scopedName = metaScopedName;

    updateMutation.mutate(
      { id: packageId, ...data },
      {
        onSuccess: () => {
          setSaved(true);
          setTimeout(() => setSaved(false), 2000);
        },
      },
    );
  };

  return (
    <div className="detail-section pkg-metadata-section">
      <h3>{t("packages.metadata")}</h3>
      <div className="pkg-metadata-grid">
        <div className="form-group">
          <label>{t("packages.version")}</label>
          <input
            type="text"
            value={metaVersion}
            onChange={(e) => setMetaVersion(e.target.value)}
            placeholder="0.0.0"
          />
          {versionError && (
            <span className="pkg-metadata-error">{t("packages.versionInvalid")}</span>
          )}
        </div>
        <div className="form-group">
          <label>{t("packages.displayName")}</label>
          <input
            type="text"
            value={metaDisplayName}
            onChange={(e) => setMetaDisplayName(e.target.value)}
          />
        </div>
        <div className="form-group">
          <label>{t("packages.description")}</label>
          <textarea
            value={metaDescription}
            onChange={(e) => setMetaDescription(e.target.value)}
            rows={2}
          />
        </div>
        <div className="form-group">
          <label>{t("packages.scopedName")}</label>
          <input
            type="text"
            value={metaScopedName}
            onChange={(e) => setMetaScopedName(e.target.value)}
            placeholder="@scope/name"
          />
          <span className="pkg-metadata-hint">{t("packages.scopedNameDesc")}</span>
          {scopedNameError && (
            <span className="pkg-metadata-error">{t("packages.scopedNameInvalid")}</span>
          )}
        </div>
      </div>
      <div className="pkg-metadata-actions">
        <button
          onClick={handleSave}
          disabled={!hasChanges || !!versionError || !!scopedNameError || updateMutation.isPending}
        >
          {updateMutation.isPending ? (
            <Spinner />
          ) : saved ? (
            <>
              <Check size={14} />
              {t("packages.saved")}
            </>
          ) : (
            t("packages.save")
          )}
        </button>
      </div>
    </div>
  );
}

export function PackageDetailPage({ type }: { type: "skill" | "extension" }) {
  const { t } = useTranslation(["settings", "flows", "common"]);
  const {
    scope,
    name,
    version: versionParam,
  } = useParams<{
    scope: string;
    name: string;
    version?: string;
  }>();
  const packageId = scope && name ? `${scope}/${name}` : undefined;
  const { isOrgAdmin } = useOrg();
  const isVersionView = !!versionParam;

  const { isLoading, data: detail } = usePackageDetail(type, packageId);
  const { data: versionDetail, isLoading: versionLoading } = useVersionDetail(
    type,
    packageId,
    versionParam,
  );
  const deleteMutation = useDeletePackage(type);
  const downloadPackage = usePackageDownload(scope, name);

  if (isLoading || (isVersionView && versionLoading)) return <LoadingState />;
  if (!detail) return <Navigate to="/" replace />;

  const versionResult = getVersionRedirect({
    type,
    packageId: packageId!,
    versionParam,
    versionCount: detail.versionCount,
    versionDetail,
    liveVersion: detail.version,
  });

  if ("redirect" in versionResult) {
    return <Navigate to={versionResult.redirect} replace />;
  }

  const { isHistoricalVersion } = versionResult;

  const isBuiltIn = detail.source === "built-in";
  const hasFlows = detail.flows.length > 0;

  const downloadVersion = isHistoricalVersion ? versionDetail?.version : detail.version;

  const handleDelete = () => {
    if (!packageId) return;
    const name = detail.name || detail.id;
    const typeLabel = t(`packages.type.${type}`);
    if (!confirm(t("packages.deleteConfirm", { type: typeLabel, name }))) return;
    deleteMutation.mutate(packageId, {
      onError: (err) => alert(err instanceof Error ? err.message : t("packages.deleteDependedOn")),
    });
  };

  return (
    <>
      <nav className="breadcrumb">
        <Link to={`/?tab=${type}s`}>{t(`packages.type.${type}s`)}</Link>
        <span className="separator">/</span>
        <span className="current">{detail.name || detail.id}</span>
      </nav>

      <div className="flow-detail-header">
        <div className="header-row">
          <h2>{detail.name || detail.id}</h2>
          <div className="flow-card-badges">
            <TypeBadge type={type} />
            {isBuiltIn && <span className="source-badge">{t("packages.sourceBuiltIn")}</span>}
            {isHistoricalVersion && (
              <span className="version-readonly-badge">
                {t("version.readOnly", { ns: "flows" })}
              </span>
            )}
          </div>
          {packageId && detail.versionCount && detail.versionCount > 0 && (
            <VersionSelector packageId={packageId} currentVersion={versionParam} type={type} />
          )}
          {downloadVersion && packageId && (
            <button
              className="btn-icon"
              title={t("btn.download", { ns: "common" })}
              onClick={() => downloadPackage(downloadVersion)}
            >
              <Download size={14} />
            </button>
          )}
        </div>
        {detail.description && <p className="description">{detail.description}</p>}
        <code className="detail-id">{detail.id}</code>
      </div>

      <VersionBanners isHistorical={isHistoricalVersion} versionDetail={versionDetail} />

      {isOrgAdmin && !isBuiltIn && packageId && !isHistoricalVersion && (
        <PackageMetadataEditor
          key={detail.updatedAt}
          detail={detail}
          packageId={packageId}
          type={type}
        />
      )}

      <div className="detail-section">
        <h3>{t("packages.usedBy", { ns: "flows" })}</h3>
        {!hasFlows ? (
          <p className="detail-empty">{t("packages.noFlows", { ns: "flows" })}</p>
        ) : (
          <div className="detail-flows">
            {detail.flows.map((f) => (
              <Link key={f.id} to={`/flows/${f.id}`} className="detail-flow-badge">
                {f.displayName || f.id}
              </Link>
            ))}
          </div>
        )}
      </div>

      <div className="detail-section">
        <h3>{t("packages.content", { ns: "flows" })}</h3>
        <pre className="state-json">
          {isHistoricalVersion && versionDetail?.content != null
            ? versionDetail.content
            : detail.content}
        </pre>
      </div>

      {isOrgAdmin && !isBuiltIn && !hasFlows && !isHistoricalVersion && (
        <div className="actions">
          <button className="btn-danger" onClick={handleDelete} disabled={deleteMutation.isPending}>
            {t("btn.delete")}
          </button>
        </div>
      )}
    </>
  );
}
