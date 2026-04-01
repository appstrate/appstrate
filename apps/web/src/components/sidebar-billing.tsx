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
    <div className="min-w-36 space-y-2">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{t("nav.credits")}</span>
        <span className="font-medium">
          {billing.creditsUsed.toLocaleString()} / {billing.creditQuota.toLocaleString()}
        </span>
      </div>
      <div className="bg-border h-1.5 overflow-hidden rounded-full">
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
            tooltip={
              {
                children: tooltipContent,
              } as React.ComponentProps<typeof TooltipContent>
            }
          >
            <Link to="/org-settings#billing">
              <Coins size={16} />
            </Link>
          </SidebarMenuButton>
          <span
            className={`ring-sidebar pointer-events-none absolute top-1 right-1 size-2 rounded-full ring-2 ${getUsageBarColor(billing.usagePercent)}`}
          />
        </SidebarMenuItem>
      </SidebarMenu>

      {/* Expanded view: full credit bar */}
      <div className="group-data-[collapsible=icon]:hidden">
        <Link
          to="/org-settings#billing"
          className="hover:bg-sidebar-accent block rounded-md px-2 py-2 transition-colors"
        >
          <div className="mb-1.5 flex items-center justify-between text-xs">
            <span className="text-sidebar-foreground/70 flex items-center gap-1.5">
              <Coins size={13} />
              {t("nav.credits")}
            </span>
            <span className="text-sidebar-foreground font-medium">
              {billing.creditsUsed.toLocaleString()} / {billing.creditQuota.toLocaleString()}
            </span>
          </div>
          <div
            className="bg-sidebar-border h-1.5 overflow-hidden rounded-full"
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
