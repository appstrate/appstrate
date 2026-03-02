import { useState } from "react";
import { useParams, Link, Navigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ExternalLink } from "lucide-react";
import {
  useOrgSkillDetail,
  useOrgExtensionDetail,
  useDeleteSkill,
  useDeleteExtension,
} from "../hooks/use-library";
import { useOrg } from "../hooks/use-org";
import { TypeBadge } from "../components/type-badge";
import { PublishModal } from "../components/publish-modal";
import { LoadingState } from "../components/page-states";
import { marketplacePath } from "../lib/strings";

export function PackageDetailPage() {
  const { t } = useTranslation(["settings", "flows", "common"]);
  const { packageId } = useParams<{ packageId: string }>();
  const { isOrgAdmin } = useOrg();

  // Try both skill and extension detail queries
  const skillQuery = useOrgSkillDetail(packageId);
  const extQuery = useOrgExtensionDetail(packageId);
  const deleteSkill = useDeleteSkill();
  const deleteExtension = useDeleteExtension();

  const [publishOpen, setPublishOpen] = useState(false);

  const isLoading = skillQuery.isLoading || extQuery.isLoading;
  const detail = skillQuery.data || extQuery.data;
  const isSkill = !!skillQuery.data;

  if (isLoading) return <LoadingState />;
  if (!detail) return <Navigate to="/" replace />;

  const type = isSkill ? "skill" : "extension";
  const deleteMutation = isSkill ? deleteSkill : deleteExtension;
  const isBuiltIn = detail.source === "built-in";
  const hasFlows = detail.flows.length > 0;

  const handleDelete = () => {
    if (!packageId) return;
    const name = detail.name || detail.id;
    const msg = isSkill
      ? t("library.deleteSkill", { name })
      : t("library.deleteExtension", { name });
    if (!confirm(msg)) return;
    deleteMutation.mutate(packageId, {
      onError: (err) => alert(err instanceof Error ? err.message : t("library.deleteDependedOn")),
    });
  };

  return (
    <>
      <nav className="breadcrumb">
        <Link to={`/?tab=${type}s`}>
          {isSkill ? t("library.tabSkills") : t("library.tabExtensions")}
        </Link>
        <span className="separator">/</span>
        <span className="current">{detail.name || detail.id}</span>
      </nav>

      <div className="flow-detail-header">
        <div className="header-row">
          <h2>{detail.name || detail.id}</h2>
          <div className="flow-card-badges">
            <TypeBadge type={type} />
            {isBuiltIn && <span className="source-badge">{t("library.sourceBuiltIn")}</span>}
          </div>
        </div>
        {detail.description && <p className="description">{detail.description}</p>}
        <code className="detail-id">{detail.id}</code>
        {detail.lastPublishedVersion && (
          <span className="badge badge-success">
            {t("publish.badge", { version: detail.lastPublishedVersion, ns: "flows" })}
          </span>
        )}
      </div>

      {marketplacePath(detail) && (
        <div className="actions">
          <Link to={marketplacePath(detail)!} className="btn-sm">
            <ExternalLink size={14} />
            {t("library.viewOnMarketplace")}
          </Link>
        </div>
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
        <pre className="state-json">{detail.content}</pre>
      </div>

      {isOrgAdmin && !isBuiltIn && (
        <div className="actions">
          <button onClick={() => setPublishOpen(true)}>
            {t("publish.publish", { ns: "flows" })}
          </button>
          {!hasFlows && (
            <button
              className="btn-danger"
              onClick={handleDelete}
              disabled={deleteMutation.isPending}
            >
              {t("btn.delete")}
            </button>
          )}
        </div>
      )}

      <PublishModal
        open={publishOpen}
        onClose={() => setPublishOpen(false)}
        packageId={packageId!}
      />
    </>
  );
}
