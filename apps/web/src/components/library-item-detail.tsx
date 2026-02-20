import { useTranslation } from "react-i18next";
import { useOrgSkillDetail, useOrgExtensionDetail } from "../hooks/use-library";
import { Spinner } from "./spinner";
import { formatDateLong } from "../lib/markdown";

interface LibraryItemDetailProps {
  type: "skill" | "extension";
  itemId: string;
}

export function LibraryItemDetail({ type, itemId }: LibraryItemDetailProps) {
  const { t } = useTranslation(["settings", "common"]);
  const skillQuery = useOrgSkillDetail(type === "skill" ? itemId : undefined);
  const extQuery = useOrgExtensionDetail(type === "extension" ? itemId : undefined);

  const isLoading = type === "skill" ? skillQuery.isLoading : extQuery.isLoading;
  const detail = type === "skill" ? skillQuery.data : extQuery.data;

  if (isLoading) {
    return (
      <div className="empty-state">
        <Spinner />
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="empty-state">
        <p>{t("library.detailNotFound")}</p>
      </div>
    );
  }

  return (
    <div className="library-item-detail">
      <div className="detail-meta">
        <code className="detail-id">{detail.id}</code>
        {detail.createdByName && <span className="detail-creator">{detail.createdByName}</span>}
        <span className="detail-date">{formatDateLong(detail.createdAt)}</span>
      </div>

      {detail.description && (
        <div className="detail-section">
          <div className="detail-label">{t("library.detailDescription")}</div>
          <p>{detail.description}</p>
        </div>
      )}

      <div className="detail-section">
        <div className="detail-label">{t("library.detailFlows")}</div>
        {detail.flows.length === 0 ? (
          <span className="detail-empty">{t("library.detailNone")}</span>
        ) : (
          <div className="detail-flows">
            {detail.flows.map((f) => (
              <span key={f.id} className="detail-flow-badge">
                {f.displayName || f.id}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="detail-section">
        <div className="detail-label">{t("library.detailContent")}</div>
        <pre className="state-json">{detail.content}</pre>
      </div>
    </div>
  );
}
