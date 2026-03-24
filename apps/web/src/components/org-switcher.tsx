import { useState, type ReactNode } from "react";
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
  LayoutGrid,
} from "lucide-react";
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

// ---------------------------------------------------------------------------
// Shared SwitcherDropdown — reused by OrgSwitcher and AppSwitcher
// ---------------------------------------------------------------------------

interface SwitcherItem {
  id: string;
  label: string;
  badge?: ReactNode;
}

interface SwitcherDropdownProps {
  icon: ReactNode;
  label: string;
  ariaLabel: string;
  items: SwitcherItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
  footer?: ReactNode;
}

function SwitcherDropdown({
  icon,
  label,
  ariaLabel,
  items,
  activeId,
  onSelect,
  footer,
}: SwitcherDropdownProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="inline-flex items-center gap-1 max-w-[150px] px-1.5 py-0.5 rounded text-xs text-muted-foreground hover:text-muted-foreground hover:bg-accent/50 transition-colors"
          aria-label={ariaLabel}
        >
          {icon}
          <span className="truncate">{label}</span>
          <ChevronDown size={8} strokeWidth={2.5} className="flex-shrink-0 opacity-40" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end">
        {items.map((item) => {
          const isActive = item.id === activeId;
          return (
            <DropdownMenuItem
              key={item.id}
              className="flex items-center justify-between gap-2"
              onSelect={() => {
                if (!isActive) onSelect(item.id);
              }}
            >
              <span className="truncate flex items-center gap-1.5">
                {item.label}
                {item.badge}
              </span>
              {isActive && <Check size={14} strokeWidth={2.5} className="flex-shrink-0" />}
            </DropdownMenuItem>
          );
        })}
        {footer && (
          <>
            <DropdownMenuSeparator />
            {footer}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---------------------------------------------------------------------------
// NavMenu — grid button dropdown with all navigation links
// ---------------------------------------------------------------------------

export function NavMenu() {
  const { t } = useTranslation();
  const { isOrgAdmin } = useOrg();
  const { data: applications } = useApplications();
  const currentAppId = useCurrentApplicationId();
  const currentApp = applications?.find((a) => a.id === currentAppId) ?? null;
  const [importOpen, setImportOpen] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <div
            role="button"
            tabIndex={0}
            className="inline-flex items-center justify-center size-8 shrink-0 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer"
            aria-label={t("nav.ariaLabel")}
          >
            <LayoutGrid size={18} />
          </div>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="end">
          <DropdownMenuLabel className="text-xs text-muted-foreground uppercase tracking-wider">
            {t("nav.orgSection")}
          </DropdownMenuLabel>
          <DropdownMenuItem asChild>
            <Link to="/flows" className="flex items-center gap-2">
              <Layers size={14} />
              {t("nav.flows")}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link to="/executions" className="flex items-center gap-2">
              <Activity size={14} />
              {t("nav.executions")}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link to="/schedules" className="flex items-center gap-2">
              <Calendar size={14} />
              {t("nav.schedules")}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link to="/skills" className="flex items-center gap-2">
              <Wrench size={14} />
              {t("nav.skills")}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link to="/tools" className="flex items-center gap-2">
              <Puzzle size={14} />
              {t("nav.tools")}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link to="/providers" className="flex items-center gap-2">
              <Plug size={14} />
              {t("nav.connectors")}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => setImportOpen(true)}
            className="flex items-center gap-2"
          >
            <Upload size={14} />
            {t("nav.import")}
          </DropdownMenuItem>
          {isOrgAdmin && (
            <DropdownMenuItem asChild>
              <Link to="/org-settings" className="flex items-center gap-2">
                <Settings size={14} />
                {t("nav.settings")}
              </Link>
            </DropdownMenuItem>
          )}

          {isOrgAdmin && currentApp && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs text-muted-foreground uppercase tracking-wider">
                {t("nav.appSection")}
              </DropdownMenuLabel>
              <DropdownMenuItem asChild>
                <Link to="/end-users" className="flex items-center gap-2">
                  <Users size={14} />
                  {t("nav.endUsers")}
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link to="/api-keys" className="flex items-center gap-2">
                  <KeyRound size={14} />
                  {t("nav.apiKeys")}
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link to="/webhooks" className="flex items-center gap-2">
                  <Webhook size={14} />
                  {t("nav.webhooks")}
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link to="/app-settings" className="flex items-center gap-2">
                  <Settings size={14} />
                  {t("nav.appSettings")}
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

// ---------------------------------------------------------------------------
// OrgSwitcher — org / app breadcrumb switcher
// ---------------------------------------------------------------------------

export function OrgSwitcher() {
  const { t } = useTranslation();
  const { currentOrg, orgs, switchOrg, loading, isOrgAdmin } = useOrg();
  const { data: applications } = useApplications();
  const currentAppId = useCurrentApplicationId();

  if (loading) return <Spinner />;
  if (!currentOrg) return null;

  const orgItems: SwitcherItem[] = orgs.map((org) => ({ id: org.id, label: org.name }));

  const appItems: SwitcherItem[] = (applications ?? []).map((app) => ({
    id: app.id,
    label: app.name,
    badge: app.isDefault ? (
      <Star size={12} className="text-amber-500 fill-amber-500 flex-shrink-0" />
    ) : undefined,
  }));

  const currentApp = applications?.find((a) => a.id === currentAppId) ?? null;

  return (
    <>
      {/* Org Switcher */}
      <SwitcherDropdown
        icon={<Users size={14} className="flex-shrink-0" />}
        label={currentOrg.name}
        ariaLabel={t("switcher.orgAriaLabel")}
        items={orgItems}
        activeId={currentOrg.id}
        onSelect={switchOrg}
        footer={
          <DropdownMenuItem asChild>
            <Link
              to="/onboarding/create"
              state={{ fromSwitcher: true }}
              className="flex items-center gap-2 text-primary"
            >
              <Plus size={14} />
              {t("switcher.createOrg")}
            </Link>
          </DropdownMenuItem>
        }
      />

      {/* Breadcrumb separator */}
      <span className="text-muted-foreground/30 text-xs select-none">/</span>

      {/* App Switcher */}
      <SwitcherDropdown
        icon={<AppWindow size={14} className="flex-shrink-0" />}
        label={currentApp?.name ?? t("switcher.noApp")}
        ariaLabel={t("switcher.appAriaLabel")}
        items={appItems}
        activeId={currentAppId}
        onSelect={setCurrentApplicationId}
        footer={
          isOrgAdmin ? (
            <DropdownMenuItem asChild>
              <Link to="/applications" className="flex items-center gap-2 text-primary">
                <Settings size={14} />
                {t("switcher.manageApps")}
              </Link>
            </DropdownMenuItem>
          ) : undefined
        }
      />
    </>
  );
}
