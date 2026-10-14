// SPDX-License-Identifier: Apache-2.0

import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Coins } from "lucide-react";
import { SidebarGroup } from "@appstrate/ui/components/sidebar";
import { useCanReach } from "../hooks/use-can-reach";
import { useBilling } from "../hooks/use-billing";
import { UsageBar } from "./usage-bar";
import { formatNumber } from "../lib/format-number";

/** The organization's credit gauge, at the foot of the navigation. */
export function SidebarCredits() {
  const { t } = useTranslation();
  // The gauge links to the billing tab: fetched and drawn only where that tab
  // opens (the billing module loaded and `billing:read` granted).
  const shown = useCanReach()("/org-settings/billing");
  const { data: billing } = useBilling({ enabled: shown });

  if (!billing) return null;

  return (
    <SidebarGroup className="mt-auto">
      <Link
        to="/org-settings/billing"
        className="hover:bg-sidebar-accent block rounded-md px-2 py-2 transition-colors"
      >
        <div className="mb-1.5 flex items-center justify-between gap-2 text-xs">
          <span className="text-sidebar-foreground/70 flex items-center gap-1.5">
            <Coins className="size-3.5" />
            {t("nav.credits")}
          </span>
          <span className="text-sidebar-foreground font-medium tabular-nums">
            {formatNumber(billing.credits_used)} / {formatNumber(billing.credit_quota)}
          </span>
        </div>
        <UsageBar
          percent={billing.usage_percent}
          label={t("nav.credits")}
          className="bg-sidebar-border h-1.5"
        />
      </Link>
    </SidebarGroup>
  );
}
