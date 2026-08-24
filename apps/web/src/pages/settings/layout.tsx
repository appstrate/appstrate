// SPDX-License-Identifier: Apache-2.0

/**
 * One settings shell for two API scopes.
 *
 * Organization and workspace are independent menu sections in the rail. Each
 * section owns its selector and navigation; they are deliberately not a shared
 * context block. The pages keep their existing URLs and request headers, while
 * the keyed content outlet prevents data from the previous scope flashing
 * after a context switch.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Settings } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@appstrate/ui/cn";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@appstrate/ui/components/select";
import { getErrorMessage } from "@appstrate/core/errors";
import { client } from "../../api/client";
import { AppVersion } from "../../components/app-version";
import { NavigateKeepingState } from "../../components/navigate-keeping-state";
import { PanelDialog } from "../../components/panel-dialog";
import { useAppConfig } from "../../hooks/use-app-config";
import { useApplications } from "../../hooks/use-applications";
import { useAppSwitcher, useCurrentApplicationId } from "../../hooks/use-current-application";
import { useOrg } from "../../hooks/use-org";
import { usePermissions } from "../../hooks/use-permissions";
import { modalReturnTarget, openAsModal, useBackgroundLocation } from "../../lib/modal-route";
import {
  getLastWorkspaceId,
  pickWorkspaceForOrganization,
  rememberWorkspace,
  settingsContentKey,
  settingsScopeFromPath,
  type SettingsScope,
} from "../../lib/settings-context";
import {
  buildSettingsNavigation,
  type UnifiedSettingsNavItem,
  type UnifiedSettingsSection,
} from "./navigation";

interface ContextSelectorProps {
  value: string;
  label: string;
  disabled?: boolean;
  options: { id: string; name: string }[];
  onValueChange: (value: string) => void;
}

function ContextSelector({ value, label, disabled, options, onValueChange }: ContextSelectorProps) {
  return (
    <Select value={value} disabled={disabled} onValueChange={onValueChange}>
      <SelectTrigger className="bg-background h-10" aria-label={label}>
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.id} value={option.id}>
            {option.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function RailLink({
  item,
  label,
  active,
  state,
}: {
  item: UnifiedSettingsNavItem;
  label: string;
  active: boolean;
  state?: unknown;
}) {
  return (
    <Link
      to={item.to}
      state={state}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
          : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
      )}
    >
      <item.icon className="size-4 shrink-0" />
      <span className="truncate">{label}</span>
    </Link>
  );
}

interface ScopeNavigationProps {
  section: UnifiedSettingsSection;
  activeScope: SettingsScope;
  activeItem?: UnifiedSettingsNavItem;
  keepOverlay?: unknown;
  contextSelector: ReactNode;
  label: (key: string) => string;
}

function ScopeNavigation({
  section,
  activeScope,
  activeItem,
  keepOverlay,
  contextSelector,
  label,
}: ScopeNavigationProps) {
  const active = activeScope === section.scope;
  return (
    <section
      data-settings-scope={section.scope}
      data-active={active || undefined}
      className={cn(
        "border-l-2 px-3 py-4",
        section.scope === "workspace" && "border-t-sidebar-border border-t",
        active ? "border-l-primary bg-sidebar-accent/20" : "border-l-transparent",
      )}
    >
      <div
        className={cn(
          "mb-2 flex items-center gap-2 text-[0.7rem] font-semibold tracking-[0.06em] uppercase",
          active ? "text-foreground" : "text-muted-foreground",
        )}
      >
        <section.icon className="size-3.5" />
        {label(section.labelKey)}
      </div>
      {contextSelector}
      <nav className="mt-2 flex flex-col gap-0.5" aria-label={label(section.labelKey)}>
        {section.items.map((item) => (
          <RailLink
            key={item.to}
            item={item}
            label={label(item.labelKey)}
            active={activeItem?.to === item.to}
            state={keepOverlay}
          />
        ))}
      </nav>
    </section>
  );
}

interface MobileScopeNavigationProps {
  section: UnifiedSettingsSection;
  activeScope: SettingsScope;
  activeItem?: UnifiedSettingsNavItem;
  contextSelector: ReactNode;
  label: (key: string) => string;
  onNavigate: (to: string) => void;
}

function MobileScopeNavigation({
  section,
  activeScope,
  activeItem,
  contextSelector,
  label,
  onNavigate,
}: MobileScopeNavigationProps) {
  const active = activeScope === section.scope;
  const headingId = `settings-${section.scope}-mobile-heading`;
  const pageSelectorId = `settings-${section.scope}-mobile-page-selector`;
  return (
    <section
      data-settings-mobile-scope={section.scope}
      data-active={active || undefined}
      className={cn("rounded-lg border p-3", active && "border-primary/50 bg-primary/5")}
    >
      <div
        id={headingId}
        className="text-muted-foreground mb-2 text-xs font-semibold tracking-wide uppercase"
      >
        {label(section.labelKey)}
      </div>
      <div className="space-y-2">
        {contextSelector}
        <span id={pageSelectorId} className="sr-only">
          {label("unifiedSettings.pageSelector")}
        </span>
        <Select value={active ? activeItem?.to : ""} onValueChange={onNavigate}>
          <SelectTrigger aria-labelledby={`${headingId} ${pageSelectorId}`}>
            <SelectValue placeholder={label("unifiedSettings.choosePage")} />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectLabel>{label(section.labelKey)}</SelectLabel>
              {section.items.map((item) => (
                <SelectItem key={item.to} value={item.to}>
                  <span className="inline-flex items-center gap-2">
                    <item.icon className="size-4" />
                    {label(item.labelKey)}
                  </span>
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
    </section>
  );
}

export function UnifiedSettingsLayout() {
  const { t } = useTranslation(["settings", "common"]);
  const location = useLocation();
  const navigate = useNavigate();
  const background = useBackgroundLocation();
  const { currentOrg, orgs, switchOrg } = useOrg();
  const { data: applications = [] } = useApplications();
  const applicationId = useCurrentApplicationId();
  const { switchApp } = useAppSwitcher();
  const { isAdmin } = usePermissions();
  const { features } = useAppConfig();
  const [switchingOrganization, setSwitchingOrganization] = useState(false);
  const organizationSwitchRequest = useRef(0);

  useEffect(
    () => () => {
      organizationSwitchRequest.current += 1;
    },
    [],
  );

  const sections = buildSettingsNavigation({
    isAdmin,
    features: {
      oidc: !!features.oidc,
      billing: !!features.billing,
      webhooks: !!features.webhooks,
    },
  })
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => item.show !== false),
    }))
    .filter((section) => section.items.length > 0);

  const allItems = sections.flatMap((section) => section.items);
  const activeItem =
    allItems.find((item) => location.pathname === item.to) ??
    allItems.find((item) => location.pathname.startsWith(item.to + "/"));
  const activeScope = settingsScopeFromPath(location.pathname);
  const contentKey = settingsContentKey(location.pathname, currentOrg?.id ?? null, applicationId);
  const keepOverlay = background ? openAsModal(background) : undefined;
  const label = (key: string) => t(key, { ns: "settings" });

  const changeOrganization = async (organizationId: string) => {
    if (!currentOrg || organizationId === currentOrg.id || switchingOrganization) return;
    const requestId = ++organizationSwitchRequest.current;
    setSwitchingOrganization(true);
    try {
      const { data, error } = await client.GET("/api/applications", {
        params: { header: { "X-Org-Id": organizationId } },
      });
      if (organizationSwitchRequest.current !== requestId) return;
      if (error) throw error;

      const workspace = pickWorkspaceForOrganization(
        data?.data ?? [],
        getLastWorkspaceId(organizationId),
      );
      if (!workspace) throw new Error(label("unifiedSettings.noWorkspace"));

      if (applicationId) rememberWorkspace(currentOrg.id, applicationId);
      switchOrg(organizationId, workspace.id);
      rememberWorkspace(organizationId, workspace.id);
    } catch (error) {
      if (organizationSwitchRequest.current !== requestId) return;
      toast.error(label("unifiedSettings.switchError"), {
        description: getErrorMessage(error),
      });
    } finally {
      if (organizationSwitchRequest.current === requestId) setSwitchingOrganization(false);
    }
  };

  const changeWorkspace = (workspaceId: string) => {
    if (!currentOrg || workspaceId === applicationId) return;
    switchApp(workspaceId);
    rememberWorkspace(currentOrg.id, workspaceId);
  };

  // Workspace settings were admin-only before the shells were unified. A cold
  // or bookmarked workspace URL must keep that permission contract.
  if (activeScope === "workspace" && !isAdmin) {
    return <NavigateKeepingState to="/org-settings/general" />;
  }

  const organizationSelector = (
    <ContextSelector
      value={currentOrg?.id ?? ""}
      label={label("unifiedSettings.organizationSelector")}
      disabled={switchingOrganization}
      options={orgs}
      onValueChange={(id) => void changeOrganization(id)}
    />
  );
  const workspaceSelector = (
    <ContextSelector
      value={applicationId ?? ""}
      label={label("unifiedSettings.workspaceSelector")}
      disabled={switchingOrganization || applications.length === 0}
      options={applications}
      onValueChange={changeWorkspace}
    />
  );
  const selectorFor = (scope: SettingsScope) =>
    scope === "organization" ? organizationSelector : workspaceSelector;

  const rail = (
    <div className="flex h-full flex-col">
      <div className="border-sidebar-border flex items-center gap-2 border-b px-4 py-3 text-sm font-semibold">
        <Settings className="text-muted-foreground size-4" />
        {label("unifiedSettings.title")}
      </div>
      <div className="flex-1">
        {sections.map((section) => (
          <ScopeNavigation
            key={section.scope}
            section={section}
            activeScope={activeScope}
            activeItem={activeItem}
            keepOverlay={keepOverlay}
            contextSelector={selectorFor(section.scope)}
            label={label}
          />
        ))}
      </div>
      <div className="px-4 py-3">
        <AppVersion />
      </div>
    </div>
  );

  const mobileNav = (
    <div className="space-y-3">
      {sections.map((section) => (
        <MobileScopeNavigation
          key={section.scope}
          section={section}
          activeScope={activeScope}
          activeItem={activeItem}
          contextSelector={selectorFor(section.scope)}
          label={label}
          onNavigate={(to) => navigate(to, { state: keepOverlay })}
        />
      ))}
    </div>
  );

  const closeTarget = modalReturnTarget(background);

  return (
    <PanelDialog
      title={label("unifiedSettings.title")}
      rail={rail}
      mobileNav={mobileNav}
      onClose={() => navigate(closeTarget.to, { replace: true, state: closeTarget.state })}
    >
      {activeItem && <h3 className="mb-6 text-lg font-semibold">{label(activeItem.labelKey)}</h3>}
      <div
        key={contentKey}
        data-settings-content-scope={activeScope}
        data-settings-content-key={contentKey}
      >
        <Outlet />
      </div>
    </PanelDialog>
  );
}
