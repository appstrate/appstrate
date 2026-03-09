import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useRegistryStatus } from "../hooks/use-registry";
import type { PackageType } from "@appstrate/shared-types";
import {
  useFlows,
  usePackageList,
  usePackageVersions,
  type VersionListItem,
} from "../hooks/use-packages";
import { usePublishPlanModal } from "../hooks/use-publish-plan-modal";
import { LoadingState, EmptyState } from "../components/page-states";
import { TypeBadge } from "../components/type-badge";
import { Spinner } from "../components/spinner";
import { PublishPlanModal } from "../components/publish-plan-modal";

interface PublishableItem {
  id: string;
  type: PackageType;
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

  // Filter out yanked versions, newest first (already sorted by API)
  const availableVersions = versions?.filter((v: VersionListItem) => !v.yanked) ?? [];

  // Default to the latest (first) version — draft publish is not supported
  const [selectedVersion, setSelectedVersion] = useState<string>("");
  const effectiveVersion = selectedVersion || availableVersions[0]?.version;

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-start gap-3 mb-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium">{item.displayName}</h3>
          <span className="flex items-center gap-1 text-xs text-muted-foreground mt-0.5">
            <TypeBadge type={item.type} />
            {item.version && ` · v${item.version}`}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-2 pt-2 border-t border-border">
        {availableVersions.length > 0 ? (
          <Select
            value={selectedVersion || availableVersions[0]?.version || ""}
            onValueChange={setSelectedVersion}
            disabled={fetchingPlan}
          >
            <SelectTrigger className="w-[100px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {availableVersions.map((v: VersionListItem) => (
                <SelectItem key={v.id} value={v.version}>
                  v{v.version}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span className="text-muted-foreground text-xs">{t("marketplace.noVersions")}</span>
        )}
        <Button
          size="sm"
          onClick={() => onPublish(item.id, effectiveVersion)}
          disabled={fetchingPlan || !effectiveVersion}
        >
          {fetchingPlan ? <Spinner /> : t("publish.publish", { ns: "flows" })}
        </Button>
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
  const { data: providers, isLoading: providersLoading } = usePackageList("provider");

  const isLoading =
    statusLoading || flowsLoading || skillsLoading || extensionsLoading || providersLoading;

  // Build publishable items list (exclude system packages)
  const publishableItems: PublishableItem[] = [];

  if (flows) {
    for (const f of flows) {
      if (f.source !== "system") {
        publishableItems.push({
          id: f.id,
          type: "flow",
          displayName: f.displayName || f.id,
          version: f.version,
        });
      }
    }
  }

  const nonFlowData = [
    { items: skills, type: "skill" as const },
    { items: extensions, type: "extension" as const },
    { items: providers, type: "provider" as const },
  ];

  for (const { items, type } of nonFlowData) {
    if (items) {
      for (const item of items) {
        if (item.source !== "system") {
          publishableItems.push({
            id: item.id,
            type,
            displayName: item.name || item.id,
          });
        }
      }
    }
  }

  if (isLoading) {
    return (
      <div className="max-w-[900px]">
        <LoadingState />
      </div>
    );
  }

  return (
    <div className="max-w-[900px]">
      <Link
        to="/marketplace"
        className="flex items-center gap-1.5 text-sm text-muted-foreground mb-4 hover:text-foreground"
      >
        <ArrowLeft size={14} />
        <span>{t("marketplace.backToMarketplace")}</span>
      </Link>

      <div className="mb-6">
        <h2 className="text-lg font-semibold">{t("marketplace.publishTitle")}</h2>
        <p className="text-sm text-muted-foreground">{t("marketplace.publishDesc")}</p>
      </div>

      {!registryStatus?.connected ? (
        <div className="rounded-lg border border-border bg-card p-6 space-y-4">
          <div>
            <p className="text-sm text-muted-foreground">{t("registry.description")}</p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              to="/marketplace/connection"
              className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              {t("registry.connect")}
            </Link>
          </div>
        </div>
      ) : (
        <>
          {publishableItems.length === 0 ? (
            <EmptyState
              icon={Upload}
              message={t("marketplace.noPublishable")}
              hint={t("marketplace.publishableHint")}
            />
          ) : (
            <div className="grid gap-4 grid-cols-1 md:grid-cols-2">
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
        </>
      )}

      {publishPlan.hasPlan && <PublishPlanModal {...publishPlan.modalProps} />}
    </div>
  );
}
