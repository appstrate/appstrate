import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useFlowDetailContext } from "../../hooks/use-flow-detail-context";
import { ShareDropdown } from "../share-dropdown";
import { Spinner } from "../spinner";

export function FlowActions({
  isOrgAdmin,
  isHistoricalVersion,
  hasDraftChanges,
  resolvedVersion,
  downloadVersion,
  downloadPackage,
  onCreateVersion,
}: {
  isOrgAdmin: boolean;
  isHistoricalVersion: boolean;
  hasDraftChanges: boolean;
  resolvedVersion: string | undefined;
  downloadVersion: string | undefined;
  downloadPackage: (v: string) => void;
  onCreateVersion: () => void;
}) {
  const { t } = useTranslation(["flows", "common"]);
  const ctx = useFlowDetailContext();
  const {
    detail,
    packageId,
    runFlow,
    deleteFlow,
    allConnected,
    hasReconnectionNeeded,
    hasRequiredConfig,
    hasInputSchema,
    hasConfigSchema,
    setConfigOpen,
    setInputOpen,
    profileId,
  } = ctx;

  const handleRun = () => {
    if (hasInputSchema) {
      setInputOpen(true);
    } else {
      runFlow.mutate({
        profileId: profileId ?? undefined,
        version: resolvedVersion,
      });
    }
  };

  return (
    <div className="flex items-center gap-2 flex-wrap mb-4">
      <Button
        onClick={handleRun}
        disabled={!allConnected || hasReconnectionNeeded || !hasRequiredConfig || runFlow.isPending}
        title={
          hasReconnectionNeeded
            ? t("detail.titleReconnect", { defaultValue: "Reconnect services first" })
            : !allConnected
              ? t("detail.titleConnect")
              : !hasRequiredConfig
                ? t("detail.titleConfig")
                : t("detail.titleRun")
        }
      >
        {runFlow.isPending && <Spinner />} {t("detail.run")}
      </Button>
      <ShareDropdown
        packageId={packageId}
        isAdmin={isOrgAdmin}
        services={detail.requires.services}
      />
      {isOrgAdmin && (
        <div className="flex items-center gap-2 flex-wrap">
          {hasConfigSchema && (
            <Button variant="outline" onClick={() => setConfigOpen(true)}>
              {t("detail.configure")}
            </Button>
          )}
          {downloadVersion && (
            <Button
              variant="outline"
              onClick={() => downloadPackage(downloadVersion)}
              title={t("btn.download", { ns: "common" })}
            >
              <Download size={14} /> {t("btn.download", { ns: "common" })}
            </Button>
          )}
          {detail.source !== "built-in" && !isHistoricalVersion && (
            <>
              <Button variant="outline" onClick={onCreateVersion} disabled={!hasDraftChanges}>
                {t("version.createVersion")}
              </Button>
              <Button variant="outline" asChild>
                <Link to={`/flows/${packageId}/edit`}>{t("btn.edit")}</Link>
              </Button>
            </>
          )}
          {isHistoricalVersion && (
            <span className="inline-flex items-center rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
              {t("version.readOnly")}
            </span>
          )}
          {detail.source !== "built-in" && (
            <Button
              variant="destructive"
              size="sm"
              disabled={detail.runningExecutions > 0 || deleteFlow.isPending}
              title={
                detail.runningExecutions > 0
                  ? t("detail.titleDeleteRunning")
                  : t("detail.titleDelete")
              }
              onClick={() => {
                if (confirm(t("detail.deleteConfirm", { name: detail.displayName }))) {
                  deleteFlow.mutate(detail.id);
                }
              }}
            >
              {t("btn.delete")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
