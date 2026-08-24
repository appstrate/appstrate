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
import { ChevronDown, Settings, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@appstrate/ui/cn";
import { Button } from "@appstrate/ui/components/button";
import { ScrollArea } from "@appstrate/ui/components/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@appstrate/ui/components/select";
import { getErrorMessage } from "@appstrate/core/errors";
import { client } from "../../api/client";
import { AppVersion } from "../../components/app-version";
import { SettingsPageActionTargetsProvider } from "../../components/settings/settings-page-actions";
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
import { useBreadcrumbStore } from "../../stores/breadcrumb-store";
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

const contextSelectorTriggerClass = [
  "relative h-11 border-transparent bg-transparent py-0 shadow-none",
  "before:pointer-events-none before:absolute before:inset-x-0 before:inset-y-0.5",
  "before:rounded-md before:border before:border-input before:bg-background before:shadow-sm",
  "[&>span]:relative [&>span]:z-10 [&>svg]:relative [&>svg]:z-10",
  "md:h-9 md:border-input md:bg-background md:py-2 md:shadow-sm md:before:hidden",
].join(" ");

function ContextSelector({ value, label, disabled, options, onValueChange }: ContextSelectorProps) {
  return (
    <Select value={value} disabled={disabled} onValueChange={onValueChange}>
      <SelectTrigger
        className={contextSelectorTriggerClass}
        aria-label={label}
        data-settings-context-selector
      >
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
  mobile = false,
  onNavigate,
}: {
  item: UnifiedSettingsNavItem;
  label: string;
  active: boolean;
  state?: unknown;
  mobile?: boolean;
  onNavigate?: () => void;
}) {
  return (
    <Link
      to={item.to}
      state={state}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
        mobile && "min-h-11",
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
  activeItem?: UnifiedSettingsNavItem;
  keepOverlay?: unknown;
  contextSelector?: ReactNode;
  label: (key: string) => string;
  mobile?: boolean;
  onNavigate?: () => void;
}

function ScopeNavigation({
  section,
  activeItem,
  keepOverlay,
  contextSelector,
  label,
  mobile = false,
  onNavigate,
}: ScopeNavigationProps) {
  return (
    <section
      data-settings-scope={section.scope}
      className={cn(
        "px-3 py-3",
        section.scope === "workspace" && "border-t-sidebar-border border-t",
      )}
    >
      <div
        data-settings-scope-title
        className="text-muted-foreground mb-1.5 text-[0.7rem] font-semibold tracking-[0.06em] uppercase"
      >
        {label(section.labelKey)}
      </div>
      {contextSelector}
      <nav className="mt-1.5 flex flex-col gap-0.5" aria-label={label(section.labelKey)}>
        {section.items.map((item) => (
          <RailLink
            key={item.to}
            item={item}
            label={label(item.labelKey)}
            active={activeItem?.to === item.to}
            state={keepOverlay}
            mobile={mobile}
            onNavigate={onNavigate}
          />
        ))}
      </nav>
    </section>
  );
}

export function UnifiedSettingsLayout() {
  const { t } = useTranslation(["settings", "common"]);
  const location = useLocation();
  const navigate = useNavigate();
  const background = useBackgroundLocation();
  const setBreadcrumbEntries = useBreadcrumbStore((state) => state.setEntries);
  const { currentOrg, orgs, switchOrg } = useOrg();
  const { data: applications = [] } = useApplications();
  const applicationId = useCurrentApplicationId();
  const { switchApp } = useAppSwitcher();
  const { isAdmin } = usePermissions();
  const { features } = useAppConfig();
  const shouldOpenMobileNavigationOnEntry =
    background !== null &&
    (location.pathname === "/org-settings" ||
      location.pathname === "/org-settings/general" ||
      location.pathname === "/workspace-settings" ||
      location.pathname === "/workspace-settings/general");
  const openMobileNavigationOnEntry = useRef(shouldOpenMobileNavigationOnEntry);
  const [switchingOrganization, setSwitchingOrganization] = useState(false);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(
    () =>
      shouldOpenMobileNavigationOnEntry &&
      (location.pathname === "/org-settings/general" ||
        location.pathname === "/workspace-settings/general"),
  );
  const [desktopActionTarget, setDesktopActionTarget] = useState<HTMLDivElement | null>(null);
  const [mobileActionTarget, setMobileActionTarget] = useState<HTMLDivElement | null>(null);
  const organizationSwitchRequest = useRef(0);
  const mobileNavigationButton = useRef<HTMLButtonElement>(null);
  const mobileNavigationPanel = useRef<HTMLDivElement>(null);
  const breadcrumbsBeforeSettings = useRef(useBreadcrumbStore.getState().entries);

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
  const activeSection = sections.find((section) => section.scope === activeScope);
  const contentKey = settingsContentKey(location.pathname, currentOrg?.id ?? null, applicationId);
  const keepOverlay = background ? openAsModal(background) : undefined;
  const label = (key: string) => t(key, { ns: "settings" });
  const settingsBreadcrumbLabel = label("unifiedSettings.title");
  const activeSectionLabel = activeSection ? label(activeSection.labelKey) : null;
  const activeItemLabel = activeItem ? label(activeItem.labelKey) : null;
  const activeSectionHref = activeSection?.items[0]?.to ?? activeItem?.to;

  useEffect(() => {
    if (
      !openMobileNavigationOnEntry.current ||
      (location.pathname !== "/org-settings/general" &&
        location.pathname !== "/workspace-settings/general")
    ) {
      return;
    }
    openMobileNavigationOnEntry.current = false;
    setMobileNavigationOpen(true);
  }, [location.pathname]);

  useEffect(() => {
    const previousBreadcrumbs = breadcrumbsBeforeSettings.current;
    return () => setBreadcrumbEntries(previousBreadcrumbs);
  }, [setBreadcrumbEntries]);

  useEffect(() => {
    if (!activeSectionLabel || !activeItemLabel || !activeSectionHref) return;
    setBreadcrumbEntries([
      { label: settingsBreadcrumbLabel, href: "/org-settings/general" },
      { label: activeSectionLabel, href: activeSectionHref },
      { label: activeItemLabel },
    ]);
  }, [
    activeItemLabel,
    activeSectionHref,
    activeSectionLabel,
    setBreadcrumbEntries,
    settingsBreadcrumbLabel,
  ]);

  useEffect(() => {
    if (!mobileNavigationOpen) return;

    mobileNavigationPanel.current?.focus();
    const keepFocusInNavigation = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setMobileNavigationOpen(false);
        requestAnimationFrame(() => mobileNavigationButton.current?.focus());
        return;
      }
      if (event.key !== "Tab") return;

      const panel = mobileNavigationPanel.current;
      if (!panel) return;
      const focusable = [
        ...panel.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [role="combobox"]:not([aria-disabled="true"]), [tabindex]:not([tabindex="-1"])',
        ),
      ].filter((element) => !element.hidden && element.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        event.preventDefault();
        panel.focus();
      } else if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === panel)
      ) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", keepFocusInNavigation, true);
    return () => window.removeEventListener("keydown", keepFocusInNavigation, true);
  }, [mobileNavigationOpen]);

  const closeMobileNavigation = () => {
    setMobileNavigationOpen(false);
    requestAnimationFrame(() => mobileNavigationButton.current?.focus());
  };

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

  const closeTarget = modalReturnTarget(background);
  const closeSettings = () => navigate(closeTarget.to, { replace: true, state: closeTarget.state });

  const rail = (
    <div className="flex h-full flex-col">
      <div className="border-sidebar-border flex min-h-14 items-center gap-2 border-b pr-1.5 pl-4 text-sm font-semibold">
        <Settings className="text-muted-foreground size-4" />
        {label("unifiedSettings.title")}
      </div>
      <div className="flex-1">
        {sections.map((section) => (
          <ScopeNavigation
            key={section.scope}
            section={section}
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

  const mobileNavigation = mobileNavigationOpen ? (
    <div
      ref={mobileNavigationPanel}
      id="settings-mobile-navigation"
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={label("unifiedSettings.title")}
      className="bg-background fixed inset-x-0 top-24 bottom-0 z-30 flex flex-col outline-none md:hidden"
    >
      <div className="border-border flex h-14 shrink-0 items-center border-b pr-1.5 pl-4 text-sm font-semibold">
        {label("unifiedSettings.title")}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="ml-auto size-11"
          aria-label={label("unifiedSettings.closeMenu")}
          onClick={closeMobileNavigation}
        >
          <X className="size-4" />
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="pb-3">
          {sections.map((section) => (
            <ScopeNavigation
              key={section.scope}
              section={section}
              activeItem={activeItem}
              keepOverlay={keepOverlay}
              contextSelector={selectorFor(section.scope)}
              label={label}
              mobile
              onNavigate={closeMobileNavigation}
            />
          ))}
        </div>
      </ScrollArea>
      <div className="shrink-0 px-4 py-3">
        <AppVersion />
      </div>
    </div>
  ) : null;

  return (
    <PanelDialog
      title={label("unifiedSettings.title")}
      rail={rail}
      contentScrollArea
      closeLabel={t("btn.close", { ns: "common" })}
      reserveCloseArea
      mobileAsSurface
      onClose={closeSettings}
    >
      {activeSection && activeItem && (
        <div className="mb-6 md:hidden">
          <Button
            ref={mobileNavigationButton}
            type="button"
            variant="outline"
            className="h-11 w-full justify-between bg-transparent px-3"
            aria-label={label("unifiedSettings.openNavigation")}
            aria-expanded={mobileNavigationOpen}
            aria-controls="settings-mobile-navigation"
            onClick={() => setMobileNavigationOpen(true)}
          >
            <span className="truncate">{label("unifiedSettings.menu")}</span>
            <ChevronDown className="size-4 shrink-0" />
          </Button>
          <div className="mt-6 flex min-h-9 items-center justify-between gap-3">
            <h1 className="text-xl font-semibold">{label(activeItem.labelKey)}</h1>
            <div ref={setMobileActionTarget} className="flex shrink-0 items-center gap-2" />
          </div>
        </div>
      )}
      {mobileNavigation}
      {activeItem && (
        <div className="mb-6 hidden min-h-9 items-center justify-between gap-4 md:flex">
          <h3 className="text-lg font-semibold">{label(activeItem.labelKey)}</h3>
          <div ref={setDesktopActionTarget} className="flex shrink-0 items-center gap-2" />
        </div>
      )}
      <div
        key={contentKey}
        inert={mobileNavigationOpen}
        aria-hidden={mobileNavigationOpen || undefined}
        data-settings-table-surface="integrated"
        data-settings-content-scope={activeScope}
        data-settings-content-key={contentKey}
      >
        <SettingsPageActionTargetsProvider
          targets={{ desktop: desktopActionTarget, mobile: mobileActionTarget }}
        >
          <Outlet />
        </SettingsPageActionTargetsProvider>
      </div>
    </PanelDialog>
  );
}
