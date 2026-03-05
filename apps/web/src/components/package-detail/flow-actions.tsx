import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Download } from "lucide-react";
import { useFlowDetailContext } from "../../contexts/flow-detail-context";
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
    <div className="actions">
      <button
        className="primary"
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
      </button>
      <ShareDropdown
        packageId={packageId}
        isAdmin={isOrgAdmin}
        services={detail.requires.services}
      />
      {isOrgAdmin && (
        <div className="actions-admin">
          {hasConfigSchema && (
            <button onClick={() => setConfigOpen(true)}>{t("detail.configure")}</button>
          )}
          {downloadVersion && (
            <button
              onClick={() => downloadPackage(downloadVersion)}
              title={t("btn.download", { ns: "common" })}
            >
              <Download size={14} /> {t("btn.download", { ns: "common" })}
            </button>
          )}
          {detail.source !== "built-in" && !isHistoricalVersion && (
            <>
              <button onClick={onCreateVersion} disabled={!hasDraftChanges}>
                {t("version.createVersion")}
              </button>
              <Link to={`/flows/${packageId}/edit`}>
                <button>{t("btn.edit")}</button>
              </Link>
            </>
          )}
          {isHistoricalVersion && (
            <span className="version-readonly-badge">{t("version.readOnly")}</span>
          )}
          {detail.source !== "built-in" && (
            <button
              className="btn-danger"
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
            </button>
          )}
        </div>
      )}
    </div>
  );
}
