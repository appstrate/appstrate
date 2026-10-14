// SPDX-License-Identifier: Apache-2.0

/**
 * One settings shell for three scopes: organization, workspace and the
 * caller's own account (`/preferences`).
 *
 * Each scope is its own menu section in the rail; organization and workspace
 * carry their context selector. The keyed content outlet prevents data from
 * the previous scope flashing after a context switch.
 */
import { useState, type ReactNode } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Settings } from "lucide-react";
import { spaceLabel } from "../../lib/space-label";
import { AppVersion } from "../../components/app-version";
import { SettingsHeading } from "../../components/settings/settings-heading";
import { SettingsPageActionTargetProvider } from "../../components/settings/settings-page-actions";
import { RailLink } from "../../components/settings/rail-link";
import { RailGroup, RailHeader } from "../../components/settings/rail-shell";
import { ContextSelector } from "../../components/settings/context-selector";
import { cn } from "@appstrate/ui/cn";
import { PanelDialog } from "../../components/panel-dialog";
import { LoadingState } from "../../components/page-states";
import { useSpaces } from "../../hooks/use-spaces";
import { usePermissions } from "../../hooks/use-permissions";
import {
  isSpaceEnterable,
  useSpaceSwitcher,
  useCurrentSpaceId,
} from "../../hooks/use-current-space";
import { useOrg } from "../../hooks/use-org";
import { useCloseOverlay, useLandAfterOrgSwitch } from "../../lib/modal-route";
import { SETTINGS_INDEX, type SettingsScope } from "../../lib/route-access";
import { useOverlayBreadcrumb } from "../../hooks/use-overlay-breadcrumb";
import {
  activeSettingsItem,
  firstSettingsPath,
  settingsContentKey,
  settingsScopeFromPath,
  type UnifiedSettingsNavItem,
  type UnifiedSettingsSection,
} from "./navigation";
import { useSettingsSections } from "./use-settings-sections";

interface ScopeNavigationProps {
  section: UnifiedSettingsSection;
  separated: boolean;
  activeItem?: UnifiedSettingsNavItem;
  contextSelector?: ReactNode;
  label: (key: string) => string;
}

function ScopeNavigation({
  section,
  separated,
  activeItem,
  contextSelector,
  label,
}: ScopeNavigationProps) {
  return (
    <RailGroup
      data-settings-scope={section.scope}
      title={label(section.labelKey)}
      separated={separated}
    >
      {contextSelector}
      <nav className="mt-1.5 flex flex-col gap-0.5" aria-label={label(section.labelKey)}>
        {section.items.map((item) => (
          <RailLink
            key={item.to}
            item={item}
            label={label(item.labelKey)}
            active={activeItem?.to === item.to}
          />
        ))}
      </nav>
    </RailGroup>
  );
}

export function UnifiedSettingsLayout() {
  const { t } = useTranslation(["settings", "common"]);
  const location = useLocation();
  const closeSettings = useCloseOverlay();
  const landAfterOrgSwitch = useLandAfterOrgSwitch();
  const { currentOrg, orgs, switchOrg } = useOrg();
  const { data: spaces = [] } = useSpaces();
  const spaceId = useCurrentSpaceId();
  const { switchSpace } = useSpaceSwitcher();
  const [actionTarget, setActionTarget] = useState<HTMLDivElement | null>(null);

  const sections = useSettingsSections();

  const activeItem = activeSettingsItem(sections, location.pathname);
  const activeScope = settingsScopeFromPath(location.pathname);
  const activeSection = sections.find((section) => section.scope === activeScope);
  const contentKey = settingsContentKey(location.pathname, currentOrg?.id ?? null, spaceId);
  const label = (key: string) => t(key, { ns: "settings" });
  const settingsBreadcrumbLabel = label("unifiedSettings.title");
  const activeSectionLabel = activeSection ? label(activeSection.labelKey) : null;
  const activeSectionHref = activeSection?.items[0]?.to ?? activeItem?.to;

  useOverlayBreadcrumb(
    activeSectionLabel && activeItem && activeSectionHref
      ? [
          { label: settingsBreadcrumbLabel, href: SETTINGS_INDEX[activeScope] },
          { label: activeSectionLabel, href: activeSectionHref },
          // A link once a page under the item (a webhook) extends the trail.
          {
            label: label(activeItem.labelKey),
            href: location.pathname === activeItem.to ? undefined : activeItem.to,
          },
        ]
      : [],
  );

  // The space of the next organization is `useSpaceResolver`'s pick: its
  // remembered one for this account, else its default.
  const organizationSelector = (
    <ContextSelector
      value={currentOrg?.id ?? ""}
      label={label("unifiedSettings.organizationSelector")}
      options={orgs}
      onValueChange={(id) => {
        switchOrg(id);
        landAfterOrgSwitch();
      }}
    />
  );
  const workspaceSelector = (
    <ContextSelector
      value={spaceId ?? ""}
      label={label("unifiedSettings.workspaceSelector")}
      disabled={spaces.length === 0}
      // Listed is not enterable: a closed space shows, disabled.
      options={spaces.map((space) => ({
        id: space.id,
        name: spaceLabel(space, t),
        disabled: !isSpaceEnterable(space),
      }))}
      onValueChange={switchSpace}
    />
  );
  const selectors: Partial<Record<SettingsScope, ReactNode>> = {
    organization: organizationSelector,
    workspace: workspaceSelector,
  };
  const rail = (
    <div className="flex h-full flex-col">
      <RailHeader icon={Settings} title={label("unifiedSettings.title")} />
      <div className="flex-1">
        {sections.map((section, index) => (
          <ScopeNavigation
            key={section.scope}
            section={section}
            separated={index > 0}
            activeItem={activeItem}
            contextSelector={selectors[section.scope]}
            label={label}
          />
        ))}
      </div>
      <div className="px-4 py-3">
        <AppVersion />
      </div>
    </div>
  );

  return (
    <PanelDialog
      title={label("unifiedSettings.title")}
      rail={rail}
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
        data-settings-table-surface="integrated"
        data-settings-content-scope={activeScope}
        data-settings-content-key={contentKey}
        className="[&_[data-data-table-row]]:[grid-template-columns:var(--dt-cols-3)] [&_[data-data-table-scroll]_table]:min-w-(--dt-full-floor) [&_td[data-data-table-tier]]:flex [&_th[data-data-table-tier]]:block"
      >
        <SettingsPageActionTargetProvider target={actionTarget}>
          <Outlet />
        </SettingsPageActionTargetProvider>
      </div>
    </PanelDialog>
  );
}

/**
 * A scope's index (`/org-settings`, `/workspace-settings`, `/preferences`)
 * lands on the first entry the rail lists for this caller in that scope.
 */
export function SettingsIndexRedirect() {
  const sections = useSettingsSections();
  const { ready } = usePermissions();
  const { pathname } = useLocation();
  // Until the permissions load every entry reads as refused.
  if (!ready) return <LoadingState />;
  return <Navigate to={firstSettingsPath(sections, settingsScopeFromPath(pathname))} replace />;
}
