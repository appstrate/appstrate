import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Modal } from "./modal";
import { Button } from "@/components/ui/button";
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
  const hasVersionBehind = items.some((i) => i.status === "version_behind");
  const allUpToDate = items.every((i) => i.status === "published" || i.status === "system");
  const isBlocked = !!circular || hasNoVersion || hasVersionBehind || allUpToDate;
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

    const toPublish = items.filter((i) => i.status !== "published" && i.status !== "system");

    // The root package is the last item (topological sort puts it last)
    const rootPackageId = items.length > 0 ? items[items.length - 1].packageId : null;

    // Initialize all as pending
    const initial = new Map<string, ItemStatus>();
    for (const item of items) {
      initial.set(
        item.packageId,
        item.status === "published" || item.status === "system" ? "skipped" : "pending",
      );
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
    if (item.status === "system") return t("publishPlan.status.system");

    // Pre-publish status labels
    switch (item.status) {
      case "unpublished":
        return t("publishPlan.status.unpublished");
      case "outdated":
        return t("publishPlan.status.outdated");
      case "no_version":
        return t("publishPlan.status.no_version");
      case "version_behind":
        return t("publishPlan.status.version_behind");
      default:
        return t("publishPlan.status.pending");
    }
  };

  const statusClassName = (item: PublishPlanItem) => {
    const base = "text-xs font-medium shrink-0";
    const s = statuses.get(item.packageId);
    if (s === "done" || s === "skipped" || item.status === "published" || item.status === "system")
      return `${base} text-success`;
    if (s === "failed" || item.status === "no_version" || item.status === "version_behind")
      return `${base} text-destructive`;
    if (s === "publishing") return `${base} text-primary`;
    if (item.status === "unpublished") return `${base} text-warning`;
    if (item.status === "outdated") return `${base} text-warning`;
    return `${base} text-muted-foreground`;
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={isSingleItem ? t("publishPlan.titleSingle") : t("publishPlan.title")}
      actions={
        <>
          {!publishing && (
            <Button variant="outline" onClick={handleClose}>
              {t("common:cancel", "Annuler")}
            </Button>
          )}
          <Button onClick={handlePublishAll} disabled={isBlocked || publishing}>
            {publishing ? (
              <Spinner />
            ) : isSingleItem ? (
              t("publishPlan.publishOne")
            ) : (
              t("publishPlan.publishAll")
            )}
          </Button>
        </>
      }
    >
      <p className="text-sm text-muted-foreground mb-4">
        {isSingleItem ? t("publishPlan.descriptionSingle") : t("publishPlan.description")}
      </p>

      {circular && (
        <div className="rounded-md bg-destructive/15 text-destructive text-sm px-3 py-2 mb-3">
          {t("publishPlan.circularWarning")}
        </div>
      )}

      {hasNoVersion && !circular && (
        <div className="rounded-md bg-warning/15 text-warning text-sm px-3 py-2 mb-3">
          {t("publishPlan.noVersionWarning")}
        </div>
      )}

      {hasVersionBehind && !circular && (
        <div className="rounded-md bg-warning/15 text-warning text-sm px-3 py-2 mb-3">
          {t("publishPlan.versionBehindWarning")}
        </div>
      )}

      {allUpToDate && !circular && (
        <div className="rounded-md bg-success/15 text-success text-sm px-3 py-2 mb-3">
          {t("publishPlan.allUpToDate")}
        </div>
      )}

      <div className="space-y-1">
        {items.map((item) => (
          <div
            key={item.packageId}
            className="flex items-center justify-between gap-2 py-2 px-2 rounded-md hover:bg-accent/50"
          >
            <div className="flex items-center gap-2 min-w-0">
              <span className="w-5 text-center shrink-0">
                {statuses.get(item.packageId) === "publishing" ? (
                  <Spinner />
                ) : (
                  statusIcon(statuses.get(item.packageId) ?? "pending")
                )}
              </span>
              <TypeBadge type={item.type} />
              <span className="font-medium text-sm truncate">{item.displayName}</span>
              {item.version && (
                <span className="text-xs text-muted-foreground">v{item.version}</span>
              )}
            </div>
            <span className={statusClassName(item)}>{statusLabel(item)}</span>
          </div>
        ))}
      </div>

      {errorMessage && (
        <div className="rounded-md bg-destructive/15 text-destructive text-sm px-3 py-2 mt-3">
          {errorMessage}
        </div>
      )}
    </Modal>
  );
}
