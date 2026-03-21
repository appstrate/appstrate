import { Link } from "react-router-dom";
import { Gauge } from "lucide-react";
import { useAppConfig } from "../hooks/use-app-config";
import { useBilling } from "../hooks/use-billing";

export function UsageBadge() {
  const { features } = useAppConfig();
  const { data: billing } = useBilling({ enabled: features.billing });

  if (!features.billing || !billing) return null;

  return (
    <Link
      to="/org-settings#billing"
      className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
      // TODO(debug): remove raw cents from title before production
      title={`${billing.usagePercent}%${billing.budgetUsedCents != null ? ` (${billing.budgetUsedCents}¢ / ${billing.budgetLimitCents}¢)` : ""}`}
    >
      <Gauge size={14} />
      <span>{billing.usagePercent}%</span>
    </Link>
  );
}
