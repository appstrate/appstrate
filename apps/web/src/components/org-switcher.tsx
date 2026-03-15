import { useState } from "react";
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
  Upload,
  Wrench,
  Puzzle,
  Layers,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useOrg } from "../hooks/use-org";
import { Spinner } from "./spinner";
import { ImportModal } from "./import-modal";
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
  const [importOpen, setImportOpen] = useState(false);

  if (loading) {
    return <Spinner />;
  }

  if (!currentOrg) {
    return null;
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-muted-foreground max-w-[180px] px-2"
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
            <Link to="/flows" className="flex items-center gap-2">
              <Layers size={14} />
              {t("orgSwitcher.flows")}
            </Link>
          </DropdownMenuItem>
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
            <Link to="/skills" className="flex items-center gap-2">
              <Wrench size={14} />
              {t("orgSwitcher.skills")}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link to="/tools" className="flex items-center gap-2">
              <Puzzle size={14} />
              {t("orgSwitcher.tools")}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link to="/providers" className="flex items-center gap-2">
              <Plug size={14} />
              {t("orgSwitcher.connectors")}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => setImportOpen(true)}
            className="flex items-center gap-2"
          >
            <Upload size={14} />
            {t("orgSwitcher.import")}
          </DropdownMenuItem>
          {isOrgAdmin && (
            <DropdownMenuItem asChild>
              <Link to="/org-settings" className="flex items-center gap-2">
                <Settings size={14} />
                {t("orgSwitcher.settings")}
              </Link>
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link
              to="/onboarding/create"
              state={{ fromSwitcher: true }}
              className="flex items-center gap-2 text-primary"
            >
              <Plus size={14} />
              {t("orgSwitcher.create")}
            </Link>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} />
    </>
  );
}
