import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Upload } from "lucide-react";
import { useRegistryStatus, usePublishPackage } from "../hooks/use-registry";
import { useFlows, useLibraryList } from "../hooks/use-packages";
import { RegistrySettings } from "../components/registry-settings";
import { LoadingState, EmptyState } from "../components/page-states";
import { TypeBadge } from "../components/type-badge";
import { Spinner } from "../components/spinner";

interface PublishableItem {
  id: string;
  type: "flow" | "skill" | "extension";
  displayName: string;
  version?: string | null;
}

export function MarketplacePublishPage() {
  const { t } = useTranslation(["settings", "flows", "common"]);
  const { data: registryStatus, isLoading: statusLoading } = useRegistryStatus();
  const publishMutation = usePublishPackage();

  const { data: flows, isLoading: flowsLoading } = useFlows();
  const { data: skills, isLoading: skillsLoading } = useLibraryList("skill");
  const { data: extensions, isLoading: extensionsLoading } = useLibraryList("extension");

  const isLoading = statusLoading || flowsLoading || skillsLoading || extensionsLoading;

  // Build publishable items list (exclude built-in)
  const publishableItems: PublishableItem[] = [];

  if (flows) {
    for (const f of flows) {
      if (f.source !== "built-in") {
        publishableItems.push({
          id: f.id,
          type: "flow",
          displayName: f.displayName || f.id,
          version: f.version,
        });
      }
    }
  }

  if (skills) {
    for (const s of skills) {
      if (s.source !== "built-in") {
        publishableItems.push({
          id: s.id,
          type: "skill",
          displayName: s.name || s.id,
        });
      }
    }
  }

  if (extensions) {
    for (const e of extensions) {
      if (e.source !== "built-in") {
        publishableItems.push({
          id: e.id,
          type: "extension",
          displayName: e.name || e.id,
        });
      }
    }
  }

  if (isLoading) {
    return (
      <div className="marketplace-page">
        <LoadingState />
      </div>
    );
  }

  return (
    <div className="marketplace-page">
      <Link to="/marketplace" className="breadcrumb">
        <ArrowLeft size={14} />
        <span>{t("marketplace.backToMarketplace")}</span>
      </Link>

      <div className="page-header">
        <h2>{t("marketplace.publishTitle")}</h2>
        <p className="description">{t("marketplace.publishDesc")}</p>
      </div>

      {!registryStatus?.connected ? (
        <RegistrySettings />
      ) : (
        <>
          {publishableItems.length === 0 ? (
            <EmptyState
              icon={Upload}
              message={t("marketplace.noPublishable")}
              hint={t("marketplace.publishableHint")}
            />
          ) : (
            <div className="services-grid">
              {publishableItems.map((item) => (
                <div key={item.id} className="service-card">
                  <div className="service-card-header">
                    <div className="service-info">
                      <h3>{item.displayName}</h3>
                      <span className="service-provider">
                        <TypeBadge type={item.type} />
                        {item.version && ` · v${item.version}`}
                      </span>
                    </div>
                  </div>
                  <div className="service-card-actions">
                    <button
                      onClick={() => publishMutation.mutate({ packageId: item.id })}
                      disabled={publishMutation.isPending}
                    >
                      {publishMutation.isPending ? (
                        <Spinner />
                      ) : (
                        t("publish.publish", { ns: "flows" })
                      )}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <RegistrySettings />
        </>
      )}
    </div>
  );
}
