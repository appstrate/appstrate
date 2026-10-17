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
import { orgTile, spaceTile } from "../../lib/identity-tile-props";
import { AppVersion } from "../../components/app-version";
import { SettingsHeading } from "../../components/settings/settings-heading";
import { SettingsPageActionTargetProvider } from "../../components/settings/settings-page-actions";
import { RailLink } from "../../components/settings/rail-link";
import { RailGroup, RailHeader } from "../../components/settings/rail-shell";
import { ContextSelector } from "../../components/settings/context-selector";
import { cn } from "@appstrate/ui/cn";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { PanelLayout } from "../../components/panel-layout";
import { SettingsSkeleton } from "../../components/loading-skeletons";
import { useSpaces } from "../../hooks/use-spaces";
import { usePermissions } from "../../hooks/use-permissions";
import {
  isSpaceEnterable,
  useSpaceSwitcher,
  useCurrentSpaceId,
} from "../../hooks/use-current-space";
import { useOrg } from "../../hooks/use-org";
import { useViewer } from "../../hooks/use-auth";
import { useLandAfterOrgSwitch } from "../../lib/modal-route";
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

/** The rail's groups, as they stand before the caller's permissions say which entries exist. */
const RAIL_PLACEHOLDER: { scope: SettingsScope; labelKey: string; rows: number }[] = [
  { scope: "organization", labelKey: "source.org", rows: 6 },
  { scope: "workspace", labelKey: "workspaceSettings.sectionGeneral", rows: 5 },
  { scope: "account", labelKey: "preferences.sectionAccount", rows: 5 },
];

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
    <RailGroup title={label(section.labelKey)} separated={separated}>
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
  const landAfterOrgSwitch = useLandAfterOrgSwitch();
  const { currentOrg, orgs, switchOrg } = useOrg();
  const { data: spaces = [] } = useSpaces();
  const viewer = useViewer();
  const spaceId = useCurrentSpaceId();
  const { switchSpace } = useSpaceSwitcher();
  const [actionTarget, setActionTarget] = useState<HTMLDivElement | null>(null);

  const sections = useSettingsSections();
  const { ready } = usePermissions();

  const activeItem = activeSettingsItem(sections, location.pathname);
  const activeScope = settingsScopeFromPath(location.pathname);
  const activeSection = sections.find((section) => section.scope === activeScope);
  const contentKey = settingsContentKey(location.pathname, currentOrg?.id ?? null, spaceId);
  const label = (key: string) => t(key, { ns: "settings" });
  const settingsBreadcrumbLabel = label("common:nav.settings");
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
      options={orgs.map((org) => ({
        id: org.id,
        name: org.name,
        tile: orgTile(org),
      }))}
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
        tile: spaceTile(space, viewer),
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
      <RailHeader icon={Settings} title={label("common:nav.settings")} />
      <div className="flex-1">
        {ready
          ? sections.map((section, index) => (
              <ScopeNavigation
                key={section.scope}
                section={section}
                separated={index > 0}
                activeItem={activeItem}
                contextSelector={selectors[section.scope]}
                label={label}
              />
            ))
          : // Entries are gated per space, so none exists until the permissions
            // land: hold each group's place rather than insert rows later.
            RAIL_PLACEHOLDER.map((group, index) => (
              <RailGroup key={group.scope} title={label(group.labelKey)} separated={index > 0}>
                {selectors[group.scope]}
                <div className="mt-1.5 flex flex-col gap-0.5" aria-hidden>
                  {Array.from({ length: group.rows }, (_, i) => (
                    <div key={i} className="flex h-8 items-center gap-2 px-2">
                      <Skeleton className="size-4 shrink-0 rounded-sm" />
                      <Skeleton className="h-3.5 w-3/5" />
                    </div>
                  ))}
                </div>
              </RailGroup>
            ))}
      </div>
      <div className="px-4 py-3">
        <AppVersion />
      </div>
    </div>
  );

  return (
    <PanelLayout
      title={settingsBreadcrumbLabel}
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
      >
        <SettingsPageActionTargetProvider target={actionTarget}>
          <Outlet />
        </SettingsPageActionTargetProvider>
      </div>
    </PanelLayout>
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
  if (!ready) return <SettingsSkeleton />;
  return <Navigate to={firstSettingsPath(sections, settingsScopeFromPath(pathname))} replace />;
}
