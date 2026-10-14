// SPDX-License-Identifier: Apache-2.0

/**
 * One settings shell for two API scopes.
 *
 * Organization and workspace are independent menu sections in the rail. Each
 * section owns its selector and navigation; they are deliberately not a shared
 * context block. The keyed content outlet prevents data from the previous scope
 * flashing after a context switch.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Navigate, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ChevronDown, Settings, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@appstrate/ui/components/button";
import { ScrollArea } from "@appstrate/ui/components/scroll-area";
import { useIsMobile } from "@appstrate/ui/use-mobile";
import { client } from "../../api/client";
import { errorMessage } from "../../lib/mutation-error";
import { spaceLabel } from "../../lib/space-label";
import { AppVersion } from "../../components/app-version";
import { SettingsHeading } from "../../components/settings/settings-heading";
import { SettingsPageActionTargetProvider } from "../../components/settings/settings-page-actions";
import { RailLink } from "../../components/settings/rail-link";
import { RailGroup, RailHeader } from "../../components/settings/rail-shell";
import { ContextSelector } from "../../components/settings/context-selector";
import { cn } from "@appstrate/ui/cn";
import { PanelDialog } from "../../components/panel-dialog";
import { useSpaces } from "../../hooks/use-spaces";
import {
  isSpaceEnterable,
  useSpaceSwitcher,
  useCurrentSpaceId,
} from "../../hooks/use-current-space";
import { useOrg } from "../../hooks/use-org";
import { modalReturnTarget, useBackgroundLocation } from "../../lib/modal-route";
import {
  getLastWorkspaceId,
  pickWorkspaceForOrganization,
  rememberWorkspace,
  settingsContentKey,
  settingsScopeFromPath,
  type SettingsScope,
} from "../../lib/settings-context";
import { useBreadcrumbStore } from "../../stores/breadcrumb-store";
import { activeSettingsItem } from "../../lib/settings-nav";
import {
  firstSettingsPath,
  type UnifiedSettingsNavItem,
  type UnifiedSettingsSection,
} from "./navigation";
import { useSettingsSections } from "./use-settings-sections";

interface ScopeNavigationProps {
  section: UnifiedSettingsSection;
  activeItem?: UnifiedSettingsNavItem;
  contextSelector?: ReactNode;
  label: (key: string) => string;
  mobile?: boolean;
  onNavigate?: () => void;
}

function ScopeNavigation({
  section,
  activeItem,
  contextSelector,
  label,
  mobile = false,
  onNavigate,
}: ScopeNavigationProps) {
  return (
    <RailGroup title={label(section.labelKey)} separated={section.scope === "workspace"}>
      {contextSelector}
      <nav className="mt-1.5 flex flex-col gap-0.5" aria-label={label(section.labelKey)}>
        {section.items.map((item) => (
          <RailLink
            key={item.to}
            item={item}
            label={label(item.labelKey)}
            active={activeItem?.to === item.to}
            mobile={mobile}
            onNavigate={onNavigate}
          />
        ))}
      </nav>
    </RailGroup>
  );
}

export function UnifiedSettingsLayout() {
  const { t } = useTranslation(["settings", "common"]);
  const isMobile = useIsMobile();
  const location = useLocation();
  const navigate = useNavigate();
  const background = useBackgroundLocation();
  const setBreadcrumbEntries = useBreadcrumbStore((state) => state.setEntries);
  const { currentOrg, orgs, switchOrg } = useOrg();
  const { data: applications = [] } = useSpaces();
  const spaceId = useCurrentSpaceId();
  const { switchSpace } = useSpaceSwitcher();
  const [switchingOrganization, setSwitchingOrganization] = useState(false);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [actionTarget, setActionTarget] = useState<HTMLDivElement | null>(null);
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

  const sections = useSettingsSections();

  const activeItem = activeSettingsItem(
    sections.flatMap((section) => section.items),
    location.pathname,
  );
  const activeScope = settingsScopeFromPath(location.pathname);
  // On a phone the index IS the navigation: `SettingsIndexRedirect` stays put.
  const navigationAsIndex = isMobile && sections.length > 0 && isSettingsIndex(location.pathname);
  const navigationOpen = mobileNavigationOpen || navigationAsIndex;
  const activeSection = sections.find((section) => section.scope === activeScope);
  const contentKey = settingsContentKey(location.pathname, currentOrg?.id ?? null, spaceId);
  const label = (key: string) => t(key, { ns: "settings" });
  const settingsBreadcrumbLabel = label("unifiedSettings.title");
  const activeSectionLabel = activeSection ? label(activeSection.labelKey) : null;
  const activeItemLabel = activeItem ? label(activeItem.labelKey) : null;
  const activeSectionHref = activeSection?.items[0]?.to ?? activeItem?.to;

  useEffect(() => {
    const previousBreadcrumbs = breadcrumbsBeforeSettings.current;
    return () => setBreadcrumbEntries(previousBreadcrumbs);
  }, [setBreadcrumbEntries]);

  useEffect(() => {
    if (!activeSectionLabel || !activeItemLabel || !activeSectionHref) return;
    setBreadcrumbEntries([
      { label: settingsBreadcrumbLabel, href: "/org-settings" },
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
    if (!navigationOpen) return;

    mobileNavigationPanel.current?.focus();
    const keepFocusInNavigation = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // As the index there is nothing under it: the dialog's own Escape closes settings.
        if (navigationAsIndex) return;
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
  }, [navigationOpen, navigationAsIndex]);

  const closeMobileNavigation = () => {
    setMobileNavigationOpen(false);
    requestAnimationFrame(() => mobileNavigationButton.current?.focus());
  };

  const changeOrganization = async (organizationId: string) => {
    if (!currentOrg || organizationId === currentOrg.id || switchingOrganization) return;
    const requestId = ++organizationSwitchRequest.current;
    setSwitchingOrganization(true);
    try {
      const { data, error } = await client.GET("/api/spaces", {
        params: { header: { "X-Org-Id": organizationId } },
      });
      if (organizationSwitchRequest.current !== requestId) return;
      if (error) throw error;

      const workspace = pickWorkspaceForOrganization(
        data?.data ?? [],
        getLastWorkspaceId(organizationId),
      );
      if (!workspace) throw new Error(label("unifiedSettings.noWorkspace"));

      if (spaceId) rememberWorkspace(currentOrg.id, spaceId);
      switchOrg(organizationId, workspace.id);
      rememberWorkspace(organizationId, workspace.id);
    } catch (error) {
      if (organizationSwitchRequest.current !== requestId) return;
      toast.error(label("unifiedSettings.switchError"), {
        description: errorMessage(error),
      });
    } finally {
      if (organizationSwitchRequest.current === requestId) setSwitchingOrganization(false);
    }
  };

  const changeWorkspace = (workspaceId: string) => {
    if (!currentOrg || workspaceId === spaceId) return;
    switchSpace(workspaceId);
    rememberWorkspace(currentOrg.id, workspaceId);
  };

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
      value={spaceId ?? ""}
      label={label("unifiedSettings.workspaceSelector")}
      disabled={switchingOrganization || applications.length === 0}
      // Listed is not enterable: a closed space shows, disabled.
      options={applications.map((space) => ({
        id: space.id,
        name: spaceLabel(space, t),
        disabled: !isSpaceEnterable(space),
      }))}
      onValueChange={changeWorkspace}
    />
  );
  const selectorFor = (scope: SettingsScope) =>
    scope === "organization" ? organizationSelector : workspaceSelector;

  const closeTarget = modalReturnTarget(background);
  const closeSettings = () => navigate(closeTarget.to, { replace: true, state: closeTarget.state });

  const rail = (
    <div className="flex h-full flex-col">
      <RailHeader icon={Settings} title={label("unifiedSettings.title")} />
      <div className="flex-1">
        {sections.map((section) => (
          <ScopeNavigation
            key={section.scope}
            section={section}
            activeItem={activeItem}
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

  const mobileNavigation = navigationOpen ? (
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
          onClick={navigationAsIndex ? closeSettings : closeMobileNavigation}
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
      reserveCloseArea
      mobileAsSurface
      // The same band as the catalogue: invisible at rest, the section's name
      // once the page has scrolled past its own heading — and an opaque surface
      // under the close control, so the page does not scroll beneath it.
      contentHeader={(stuck) =>
        activeItem ? (
          <span
            className={cn(
              "duration-fast truncate text-sm font-semibold transition-opacity",
              stuck ? "opacity-100" : "opacity-0",
            )}
          >
            {label(activeItem.labelKey)}
          </span>
        ) : null
      }
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
            aria-expanded={navigationOpen}
            aria-controls="settings-mobile-navigation"
            onClick={() => setMobileNavigationOpen(true)}
          >
            <span className="truncate">{label("unifiedSettings.menu")}</span>
            <ChevronDown className="size-4 shrink-0" />
          </Button>
        </div>
      )}
      {mobileNavigation}
      {activeItem && (
        <div className="mb-6 flex min-h-9 items-center justify-between gap-3 md:gap-4">
          <SettingsHeading className="mb-0" title={label(activeItem.labelKey)} />
          <div
            ref={setActionTarget}
            data-page-actions
            className="flex shrink-0 items-center gap-2"
          />
        </div>
      )}
      <div
        key={contentKey}
        inert={navigationOpen}
        aria-hidden={navigationOpen || undefined}
        data-settings-table-surface="integrated"
        data-settings-content-scope={activeScope}
        className="[&_[data-data-table-row]]:[grid-template-columns:var(--dt-cols-3)] [&_[data-data-table-scroll]_table]:min-w-(--dt-full-floor) [&_td[data-data-table-tier]]:flex [&_th[data-data-table-tier]]:block"
      >
        <SettingsPageActionTargetProvider target={actionTarget}>
          <Outlet />
        </SettingsPageActionTargetProvider>
      </div>
    </PanelDialog>
  );
}

const SETTINGS_INDEXES = ["/org-settings", "/workspace-settings"];

function isSettingsIndex(pathname: string): boolean {
  return SETTINGS_INDEXES.includes(pathname.replace(/\/$/, ""));
}

/**
 * `/org-settings` and `/workspace-settings` land on the first entry the rail
 * lists for this caller in that scope. On a phone the layout shows the rail
 * there instead.
 */
export function SettingsIndexRedirect() {
  const sections = useSettingsSections();
  const isMobile = useIsMobile();
  const { pathname } = useLocation();
  if (isMobile && sections.length > 0) return null;
  // No entry at all: nothing in settings is for this caller, so leave.
  return (
    <Navigate to={firstSettingsPath(sections, settingsScopeFromPath(pathname)) ?? "/"} replace />
  );
}
