import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import {
  Users,
  ChevronDown,
  Check,
  Activity,
  Calendar,
  ShoppingBag,
  Plug,
  Settings,
  Plus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useOrg } from "../hooks/use-org";
import { Spinner } from "./spinner";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

export function OrgSwitcher() {
  const { t } = useTranslation();
  const { currentOrg, orgs, switchOrg, loading, isOrgAdmin } = useOrg();

  if (loading) {
    return <Spinner />;
  }

  if (!currentOrg) {
    return null;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="gap-1.5 text-muted-foreground max-w-[180px]"
          aria-label={t("orgSwitcher.ariaLabel")}
        >
          <Users size={16} className="flex-shrink-0" />
          <span className="text-ellipsis">{currentOrg.name}</span>
          <ChevronDown size={10} strokeWidth={2.5} className="flex-shrink-0 opacity-50" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end">
        {orgs.map((org) => {
          const isActive = org.id === currentOrg.id;
          return (
            <DropdownMenuItem
              key={org.id}
              className="flex items-center justify-between gap-2"
              onSelect={() => {
                if (!isActive) switchOrg(org.id);
              }}
            >
              <span className="truncate">{org.name}</span>
              {isActive && <Check size={14} strokeWidth={2.5} className="flex-shrink-0" />}
            </DropdownMenuItem>
          );
        })}

        <DropdownMenuSeparator />

        <DropdownMenuItem asChild>
          <Link to="/executions" className="flex items-center gap-2">
            <Activity size={14} />
            {t("orgSwitcher.executions")}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/schedules" className="flex items-center gap-2">
            <Calendar size={14} />
            {t("orgSwitcher.schedules")}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/marketplace" className="flex items-center gap-2">
            <ShoppingBag size={14} />
            {t("orgSwitcher.marketplace")}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/#providers" className="flex items-center gap-2">
            <Plug size={14} />
            {t("orgSwitcher.connectors")}
          </Link>
        </DropdownMenuItem>
        {isOrgAdmin && (
          <DropdownMenuItem asChild>
            <Link to="/org-settings" className="flex items-center gap-2">
              <Settings size={14} />
              {t("orgSwitcher.settings")}
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem asChild>
          <Link to="/create-org" className="flex items-center gap-2 text-primary">
            <Plus size={14} />
            {t("orgSwitcher.create")}
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
