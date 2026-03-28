import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Coins } from "lucide-react";
import { useAppConfig } from "../hooks/use-app-config";
import { useBilling, getUsageBarColor } from "../hooks/use-billing";
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
} from "@/components/ui/sidebar";
import { TooltipContent } from "@/components/ui/tooltip";

export function SidebarBilling() {
  const { t } = useTranslation();
  const { features } = useAppConfig();
  const { data: billing } = useBilling({ enabled: features.billing });

  if (!billing) return null;

  const tooltipContent = (
    <div className="space-y-2 min-w-36">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{t("nav.credits")}</span>
        <span className="font-medium">
          {billing.creditsUsed.toLocaleString()} / {billing.creditQuota.toLocaleString()}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-border overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${getUsageBarColor(billing.usagePercent)}`}
          style={{ width: `${Math.min(billing.usagePercent, 100)}%` }}
        />
      </div>
    </div>
  );

  return (
    <SidebarGroup className="mt-auto">
      {/* Collapsed view: icon with color indicator + tooltip */}
      <SidebarMenu className="hidden group-data-[collapsible=icon]:flex">
        <SidebarMenuItem className="relative">
          <SidebarMenuButton
            asChild
            tooltip={{
              children: tooltipContent,
            } as React.ComponentProps<typeof TooltipContent>}
          >
            <Link to="/org-settings#billing">
              <Coins size={16} />
            </Link>
          </SidebarMenuButton>
          <span
            className={`pointer-events-none absolute top-1 right-1 size-2 rounded-full ring-2 ring-sidebar ${getUsageBarColor(billing.usagePercent)}`}
          />
        </SidebarMenuItem>
      </SidebarMenu>

      {/* Expanded view: full credit bar */}
      <div className="group-data-[collapsible=icon]:hidden">
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
      </div>
    </SidebarGroup>
  );
}
