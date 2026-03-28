import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Coins } from "lucide-react";
import { useAppConfig } from "../hooks/use-app-config";
import { useBilling, getUsageBarColor } from "../hooks/use-billing";
import { SidebarGroup } from "@/components/ui/sidebar";

export function SidebarBilling() {
  const { t } = useTranslation();
  const { features } = useAppConfig();
  const { data: billing } = useBilling({ enabled: features.billing });

  if (!billing) return null;

  return (
    <SidebarGroup className="group-data-[collapsible=icon]:hidden mt-auto">
      <Link
        to="/org-settings#billing"
        className="block rounded-md px-2 py-2 hover:bg-sidebar-accent transition-colors"
      >
        <div className="flex items-center justify-between text-xs mb-1.5">
          <span className="flex items-center gap-1.5 text-sidebar-foreground/70">
            <Coins size={13} />
            {t("nav.credits")}
          </span>
          <span className="font-medium text-sidebar-foreground">
            {billing.creditsUsed.toLocaleString()} / {billing.creditQuota.toLocaleString()}
          </span>
        </div>
        <div
          className="h-1.5 rounded-full bg-sidebar-border overflow-hidden"
          role="progressbar"
          aria-valuenow={Math.min(billing.usagePercent, 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={t("nav.credits")}
        >
          <div
            className={`h-full rounded-full transition-all ${getUsageBarColor(billing.usagePercent)}`}
            style={{ width: `${Math.min(billing.usagePercent, 100)}%` }}
          />
        </div>
      </Link>
    </SidebarGroup>
  );
}
