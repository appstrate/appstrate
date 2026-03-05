import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useFlowDetailContext } from "../../contexts/flow-detail-context";
import { getServiceStatusDisplay, computeServicesSummary } from "../../lib/service-status";

function ServiceIcon({ status, t }: { status: string; t: TFunction }) {
  const { statusDotClass, statusLabel, statusIcon } = getServiceStatusDisplay(status, t);
  return (
    <span className={`status-icon ${statusDotClass}`} aria-label={statusLabel}>
      {statusIcon}
    </span>
  );
}

export function FlowServicesSection() {
  const { t } = useTranslation(["flows", "common"]);
  const ctx = useFlowDetailContext();
  const {
    detail,
    isOrgAdmin,
    connectMutation,
    bindAdmin,
    unbindAdmin,
    disconnectMutation,
    getServiceAuthMode,
    isCredentialAuth,
    setApiKeyService,
    setCustomCredService,
    pParam,
  } = ctx;

  const summary = computeServicesSummary(detail.requires.services, t);

  return (
    <>
      {summary && (
        <div className="services-summary">
          {summary.connectedCount > 0 &&
            t("detail.servicesSummaryOk", { connected: summary.connectedCount })}
          {summary.connectedCount > 0 && summary.actionCount > 0 && " — "}
          {summary.actionCount > 0 && (
            <span className="summary-action">
              {t("detail.servicesSummaryAction", { count: summary.actionCount })}
            </span>
          )}
        </div>
      )}
      <div className="services">
        {detail.requires.services.map((svc) => {
          const isConnected = svc.status === "connected";
          const isAdminMode = svc.connectionMode === "admin";
          const authMode = getServiceAuthMode(svc);
          const effectiveStatus =
            isConnected && svc.scopesSufficient === false ? "needs_reconnection" : svc.status;

          if (isAdminMode) {
            const handleBind = async () => {
              try {
                await bindAdmin.mutateAsync(svc.id);
              } catch (err) {
                const msg = err instanceof Error ? err.message : "";
                if (!msg.includes("connexion active")) {
                  alert(t("error.prefix", { message: msg }));
                  return;
                }
                try {
                  if (authMode === "API_KEY") {
                    setApiKeyService({ provider: svc.provider, id: svc.id, bindAfter: true });
                    return;
                  }
                  if (isCredentialAuth(svc.provider)) {
                    setCustomCredService({
                      provider: svc.provider,
                      id: svc.id,
                      name: svc.name,
                      bindAfter: true,
                    });
                    return;
                  }
                  await connectMutation.mutateAsync({
                    provider: svc.provider,
                    scopes: svc.scopesRequired,
                  });
                  await bindAdmin.mutateAsync(svc.id);
                } catch (retryErr) {
                  const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
                  alert(t("error.prefix", { message: retryMsg }));
                }
              }
            };

            if (svc.adminProvided && isConnected) {
              return (
                <div key={svc.id} className="service admin-provided" title={svc.description}>
                  <ServiceIcon status="connected" t={t} />
                  {svc.name || svc.id}
                  <span className="admin-service-badge">{t("admin")}</span>
                  {isOrgAdmin && (
                    <button
                      type="button"
                      className="btn-unbind"
                      onClick={() => unbindAdmin.mutate(svc.id)}
                      disabled={unbindAdmin.isPending}
                    >
                      {t("detail.unbind")}
                    </button>
                  )}
                </div>
              );
            }
            return (
              <div key={svc.id} className="service admin-pending" title={svc.description}>
                <ServiceIcon status="not_connected" t={t} />
                {svc.name || svc.id}
                {isOrgAdmin ? (
                  <button
                    type="button"
                    className="btn-bind"
                    onClick={handleBind}
                    disabled={bindAdmin.isPending || connectMutation.isPending}
                  >
                    {t("detail.bindAccount")}
                  </button>
                ) : (
                  <span className="admin-service-badge pending">{t("detail.pending")}</span>
                )}
              </div>
            );
          }

          const needsReconnection = svc.status === "needs_reconnection";
          const handleServiceConnect = () => {
            if (authMode === "API_KEY") {
              setApiKeyService({ provider: svc.provider, id: svc.id });
            } else if (isCredentialAuth(svc.provider)) {
              setCustomCredService({
                provider: svc.provider,
                id: svc.id,
                name: svc.name,
              });
            } else {
              connectMutation.mutate({
                provider: svc.provider,
                scopes: svc.scopesRequired,
                ...pParam,
              });
            }
          };
          const hasScopeIssue = isConnected && svc.scopesSufficient === false;

          if (needsReconnection) {
            return (
              <div key={svc.id} className="service needs-reconnection" title={svc.description}>
                <ServiceIcon status="needs_reconnection" t={t} />
                {svc.name || svc.id}
                <button
                  type="button"
                  className="btn-scope-upgrade"
                  onClick={handleServiceConnect}
                  disabled={connectMutation.isPending}
                >
                  {t("detail.reconnect", { defaultValue: "Reconnect" })}
                </button>
              </div>
            );
          }
          if (isConnected) {
            return (
              <div
                key={svc.id}
                className={`service${hasScopeIssue ? " scope-warning" : ""}`}
                title={svc.description}
              >
                <ServiceIcon status={effectiveStatus} t={t} />
                {svc.name || svc.id}
                {hasScopeIssue && svc.scopesMissing && (
                  <button
                    type="button"
                    className="btn-scope-upgrade"
                    onClick={handleServiceConnect}
                    disabled={connectMutation.isPending}
                    title={`Missing: ${svc.scopesMissing.join(", ")}`}
                  >
                    {t("detail.updatePermissions", { defaultValue: "Update permissions" })}
                  </button>
                )}
                <button
                  type="button"
                  className="btn-unbind"
                  onClick={() => {
                    if (confirm(t("detail.disconnectConfirm", { name: svc.name || svc.id }))) {
                      disconnectMutation.mutate({
                        provider: svc.provider,
                        ...pParam,
                      });
                    }
                  }}
                  disabled={disconnectMutation.isPending}
                >
                  {t("detail.disconnect")}
                </button>
              </div>
            );
          }
          return (
            <button
              key={svc.id}
              type="button"
              className="service not-connected"
              onClick={handleServiceConnect}
              title={svc.description}
            >
              <ServiceIcon status="not_connected" t={t} />
              {svc.name || svc.id}
              {` (${t("detail.connect")})`}
            </button>
          );
        })}
      </div>
    </>
  );
}
