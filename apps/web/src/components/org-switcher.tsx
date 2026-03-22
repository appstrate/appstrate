import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import {
  Users,
  ChevronDown,
  Check,
  Activity,
  Calendar,
  Plug,
  Settings,
  Plus,
  Upload,
  Wrench,
  Puzzle,
  Layers,
  AppWindow,
  Webhook,
  KeyRound,
  Star,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useOrg } from "../hooks/use-org";
import { useApplications } from "../hooks/use-applications";
import { useCurrentApplicationId, setCurrentApplicationId } from "../hooks/use-current-application";
import { Spinner } from "./spinner";
import { ImportModal } from "./import-modal";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";

export function OrgSwitcher() {
  const { t } = useTranslation();
  const { currentOrg, orgs, switchOrg, loading, isOrgAdmin } = useOrg();
  const { data: applications } = useApplications();
  const currentAppId = useCurrentApplicationId();
  const [importOpen, setImportOpen] = useState(false);

  if (loading) {
    return <Spinner />;
  }

  if (!currentOrg) {
    return null;
  }

  const currentApp = applications?.find((a) => a.id === currentAppId) ?? null;

  return (
    <>
      {/* Org Switcher */}
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

          {/* Org Shared section */}
          <DropdownMenuLabel className="text-xs text-muted-foreground uppercase tracking-wider">
            {t("orgSwitcher.orgShared")}
          </DropdownMenuLabel>
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

          {/* App Context section */}
          {isOrgAdmin && currentApp && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs text-muted-foreground uppercase tracking-wider">
                {t("orgSwitcher.appContext")}
              </DropdownMenuLabel>
              <DropdownMenuItem asChild>
                <Link to="/end-users" className="flex items-center gap-2">
                  <Users size={14} />
                  {t("orgSwitcher.endUsers")}
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link to="/api-keys" className="flex items-center gap-2">
                  <KeyRound size={14} />
                  {t("orgSwitcher.apiKeys")}
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link to="/webhooks" className="flex items-center gap-2">
                  <Webhook size={14} />
                  {t("orgSwitcher.webhooks")}
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link to="/app-settings" className="flex items-center gap-2">
                  <Settings size={14} />
                  {t("orgSwitcher.appSettings")}
                </Link>
              </DropdownMenuItem>
            </>
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

      {/* Breadcrumb separator */}
      <span className="text-muted-foreground/50 text-sm select-none">/</span>

      {/* App Switcher */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-muted-foreground max-w-[180px] px-2"
            aria-label={t("orgSwitcher.appSwitcherAriaLabel")}
          >
            <AppWindow size={16} className="flex-shrink-0" />
            <span className="text-ellipsis">{currentApp?.name ?? t("orgSwitcher.noApp")}</span>
            <ChevronDown size={10} strokeWidth={2.5} className="flex-shrink-0 opacity-50" />
          </Button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="end">
          {applications?.map((app) => {
            const isActive = app.id === currentAppId;
            return (
              <DropdownMenuItem
                key={app.id}
                className="flex items-center justify-between gap-2"
                onSelect={() => {
                  if (!isActive) setCurrentApplicationId(app.id);
                }}
              >
                <span className="truncate flex items-center gap-1.5">
                  {app.name}
                  {app.isDefault && (
                    <Star size={12} className="text-amber-500 fill-amber-500 flex-shrink-0" />
                  )}
                </span>
                {isActive && <Check size={14} strokeWidth={2.5} className="flex-shrink-0" />}
              </DropdownMenuItem>
            );
          })}

          {isOrgAdmin && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <Link to="/applications" className="flex items-center gap-2 text-primary">
                  <Settings size={14} />
                  {t("orgSwitcher.manageApps")}
                </Link>
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} />
    </>
  );
}
