import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Modal } from "./modal";
import { TypeBadge } from "./type-badge";
import { Spinner } from "./spinner";
import { api, ApiError } from "../api";
import type { PublishPlanItem } from "../hooks/use-registry";

type ItemStatus = "pending" | "publishing" | "done" | "failed" | "skipped";

interface PublishPlanModalProps {
  open: boolean;
  onClose: () => void;
  items: PublishPlanItem[];
  circular: string[] | null;
  rootVersion?: string;
  onComplete: () => void;
}

export function PublishPlanModal({
  open,
  onClose,
  items,
  circular,
  rootVersion,
  onComplete,
}: PublishPlanModalProps) {
  const { t } = useTranslation(["settings"]);
  const qc = useQueryClient();
  const [publishing, setPublishing] = useState(false);
  const [statuses, setStatuses] = useState<Map<string, ItemStatus>>(new Map());
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const hasNoVersion = items.some((i) => i.status === "no_version");
  const isBlocked = !!circular || hasNoVersion;
  const isSingleItem = items.length === 1;

  const handleClose = useCallback(() => {
    if (publishing) return;
    setStatuses(new Map());
    setErrorMessage(null);
    onClose();
  }, [publishing, onClose]);

  const handlePublishAll = useCallback(async () => {
    setPublishing(true);
    setErrorMessage(null);

    const toPublish = items.filter((i) => i.status !== "published");

    // The root package is the last item (topological sort puts it last)
    const rootPackageId = items.length > 0 ? items[items.length - 1].packageId : null;

    // Initialize all as pending
    const initial = new Map<string, ItemStatus>();
    for (const item of items) {
      initial.set(item.packageId, item.status === "published" ? "skipped" : "pending");
    }
    setStatuses(new Map(initial));

    for (const item of toPublish) {
      setStatuses((prev) => new Map(prev).set(item.packageId, "publishing"));

      // Send version in body only for the root package when a specific version was selected
      const isRoot = item.packageId === rootPackageId;
      const body = isRoot && rootVersion ? JSON.stringify({ version: rootVersion }) : undefined;

      try {
        await api(`/packages/${item.packageId}/publish`, {
          method: "POST",
          ...(body && { body }),
        });
        setStatuses((prev) => new Map(prev).set(item.packageId, "done"));
      } catch (err) {
        const message =
          err instanceof ApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : "Unknown error";
        setStatuses((prev) => new Map(prev).set(item.packageId, "failed"));
        setErrorMessage(t("publishPlan.failedAt", { name: item.displayName, message }));
        setPublishing(false);
        return;
      }
    }

    // All succeeded
    setPublishing(false);
    qc.invalidateQueries({ queryKey: ["flow"] });
    qc.invalidateQueries({ queryKey: ["flows"] });
    qc.invalidateQueries({ queryKey: ["packages"] });
    qc.invalidateQueries({ queryKey: ["registry"] });
    qc.invalidateQueries({ queryKey: ["marketplace"] });
    onComplete();
  }, [items, rootVersion, t, qc, onComplete]);

  const statusIcon = (itemStatus: ItemStatus) => {
    switch (itemStatus) {
      case "pending":
        return "⏳";
      case "publishing":
        return null; // will show spinner
      case "done":
        return "✅";
      case "failed":
        return "❌";
      case "skipped":
        return "✓";
      default:
        return "⏳";
    }
  };

  const statusLabel = (item: PublishPlanItem) => {
    const s = statuses.get(item.packageId);
    if (s === "publishing") return t("publishPlan.status.publishing");
    if (s === "done") return t("publishPlan.status.done");
    if (s === "failed") return t("publishPlan.status.failed");
    if (s === "skipped" || item.status === "published") return t("publishPlan.status.published");

    // Pre-publish status labels
    switch (item.status) {
      case "unpublished":
        return t("publishPlan.status.unpublished");
      case "outdated":
        return t("publishPlan.status.outdated");
      case "no_version":
        return t("publishPlan.status.no_version");
      default:
        return t("publishPlan.status.pending");
    }
  };

  const statusClassName = (item: PublishPlanItem) => {
    const s = statuses.get(item.packageId);
    if (s === "done" || s === "skipped" || item.status === "published")
      return "publish-plan-status published";
    if (s === "failed" || item.status === "no_version") return "publish-plan-status error";
    if (s === "publishing") return "publish-plan-status publishing";
    if (item.status === "unpublished") return "publish-plan-status unpublished";
    if (item.status === "outdated") return "publish-plan-status outdated";
    return "publish-plan-status";
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={isSingleItem ? t("publishPlan.titleSingle") : t("publishPlan.title")}
      actions={
        <>
          {!publishing && <button onClick={handleClose}>{t("common:cancel", "Annuler")}</button>}
          <button
            className="btn-primary"
            onClick={handlePublishAll}
            disabled={isBlocked || publishing}
          >
            {publishing ? (
              <Spinner />
            ) : isSingleItem ? (
              t("publishPlan.publishOne")
            ) : (
              t("publishPlan.publishAll")
            )}
          </button>
        </>
      }
    >
      <p className="publish-plan-description">
        {isSingleItem ? t("publishPlan.descriptionSingle") : t("publishPlan.description")}
      </p>

      {circular && (
        <div className="publish-plan-warning publish-plan-warning-error">
          {t("publishPlan.circularWarning")}
        </div>
      )}

      {hasNoVersion && !circular && (
        <div className="publish-plan-warning publish-plan-warning-warn">
          {t("publishPlan.noVersionWarning")}
        </div>
      )}

      <div className="publish-plan-list">
        {items.map((item) => (
          <div key={item.packageId} className="publish-plan-item">
            <div className="publish-plan-item-info">
              <span className="publish-plan-item-icon">
                {statuses.get(item.packageId) === "publishing" ? (
                  <Spinner />
                ) : (
                  statusIcon(statuses.get(item.packageId) ?? "pending")
                )}
              </span>
              <TypeBadge type={item.type} />
              <span className="publish-plan-item-name">{item.displayName}</span>
              {item.version && <span className="publish-plan-item-version">v{item.version}</span>}
            </div>
            <span className={statusClassName(item)}>{statusLabel(item)}</span>
          </div>
        ))}
      </div>

      {errorMessage && <div className="publish-plan-error">{errorMessage}</div>}
    </Modal>
  );
}
