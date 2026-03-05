import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Upload } from "lucide-react";
import { useRegistryStatus } from "../hooks/use-registry";
import {
  useFlows,
  usePackageList,
  usePackageVersions,
  type VersionListItem,
} from "../hooks/use-packages";
import { usePublishPlanModal } from "../hooks/use-publish-plan-modal";
import { RegistrySettings } from "../components/registry-settings";
import { LoadingState, EmptyState } from "../components/page-states";
import { TypeBadge } from "../components/type-badge";
import { Spinner } from "../components/spinner";
import { PublishPlanModal } from "../components/publish-plan-modal";

interface PublishableItem {
  id: string;
  type: "flow" | "skill" | "extension";
  displayName: string;
  version?: string | null;
}

function PublishItemCard({
  item,
  fetchingPlan,
  onPublish,
}: {
  item: PublishableItem;
  fetchingPlan: boolean;
  onPublish: (packageId: string, selectedVersion?: string) => void;
}) {
  const { t } = useTranslation(["settings", "flows"]);
  const { data: versions } = usePackageVersions(item.type, item.id);
  const [selectedVersion, setSelectedVersion] = useState<string>("");

  // Filter out yanked versions, newest first (already sorted by API)
  const availableVersions = versions?.filter((v: VersionListItem) => !v.yanked) ?? [];

  // Default value: empty string means "use draft version"
  const effectiveVersion = selectedVersion || undefined;

  return (
    <div className="service-card">
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
        {availableVersions.length > 0 && (
          <select
            value={selectedVersion}
            onChange={(e) => setSelectedVersion(e.target.value)}
            disabled={fetchingPlan}
          >
            <option value="">
              {item.version ? `v${item.version}` : t("marketplace.versionLabel")}
            </option>
            {availableVersions
              .filter((v: VersionListItem) => v.version !== item.version)
              .map((v: VersionListItem) => (
                <option key={v.id} value={v.version}>
                  v{v.version}
                </option>
              ))}
          </select>
        )}
        <button onClick={() => onPublish(item.id, effectiveVersion)} disabled={fetchingPlan}>
          {fetchingPlan ? <Spinner /> : t("publish.publish", { ns: "flows" })}
        </button>
      </div>
    </div>
  );
}

export function MarketplacePublishPage() {
  const { t } = useTranslation(["settings", "flows", "common"]);
  const { data: registryStatus, isLoading: statusLoading } = useRegistryStatus();
  const publishPlan = usePublishPlanModal();

  const handlePublish = (packageId: string, selectedVersion?: string) => {
    publishPlan.open(packageId, selectedVersion);
  };

  const { data: flows, isLoading: flowsLoading } = useFlows();
  const { data: skills, isLoading: skillsLoading } = usePackageList("skill");
  const { data: extensions, isLoading: extensionsLoading } = usePackageList("extension");

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
                <PublishItemCard
                  key={item.id}
                  item={item}
                  fetchingPlan={publishPlan.isFetching}
                  onPublish={handlePublish}
                />
              ))}
            </div>
          )}

          <RegistrySettings />
        </>
      )}

      {publishPlan.hasPlan && <PublishPlanModal {...publishPlan.modalProps} />}
    </div>
  );
}
