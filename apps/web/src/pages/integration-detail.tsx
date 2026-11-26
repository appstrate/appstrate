// SPDX-License-Identifier: Apache-2.0

/**
 * Integration detail: capabilities and usage, connected accounts, tools,
 * authentication/access settings, and the read-only artifact. Technical auth
 * identifiers never stand in for navigation or capability activation.
 * OAuth clients are listed in one table across tiers (the space's own, the
 * organization's, the system's); client and connection mutations retain their
 * ownership gates. The sections live in `components/integration-detail/`.
 */

import { lazy, Suspense, useEffect } from "react";
import { useUrlModal } from "../hooks/use-url-modal";
import { EDIT_OAUTH_CLIENT_PARAM, integrationClientModalRef } from "../lib/integration-clients";
import { useTabWithHash } from "../hooks/use-tab-with-hash";
import { IntegrationOverview } from "../components/package-detail/integration-overview";
import { IntegrationFunctioning } from "../components/package-detail/integration-structure";
import { IntegrationToolsSection } from "../components/integration-editor/integration-tools-section";
import type {
  ToolDeclaration,
  ToolPolicyAccess,
} from "../components/integration-editor/integration-tool-policy-section";

const INTEGRATION_TABS = ["overview", "connections", "settings"] as const;
import { useTranslation } from "react-i18next";
import { Link, useParams, useLocation, useNavigate } from "react-router-dom";
import type { OrgPackageItemDetail } from "@appstrate/shared-types";
import type { IntegrationDefinitionSection } from "./package-editor";
import {
  ShieldCheck,
  KeyRound,
  Plug,
  FolderTree,
  Wrench,
  History,
  IdCard,
  LayoutGrid,
  Server,
  Settings2,
  Star,
} from "lucide-react";
import { authMethodLabel } from "../lib/integration-presentation";
import { AvailabilityBadge } from "../components/package-detail/availability-card";
import { Button } from "@appstrate/ui/components/button";
import { Alert, AlertDescription, AlertTitle } from "@appstrate/ui/components/alert";
import { needsWizardFinish, wizardResumePath } from "../lib/integration-wizard";
import { Badge } from "@appstrate/ui/components/badge";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { UnreadableDetail } from "../components/unreadable-detail";
import { isQueryInFlight } from "../lib/query-state";
import { SettingsSkeleton } from "../components/loading-skeletons";
import { DetailTabs, DetailTabPanel, type DetailTab } from "../components/detail-tabs";
import { SettingsHeading } from "../components/settings/settings-heading";
import type { SectionRailItem } from "../components/settings/section-rail";
import {
  SettingsRailView,
  type SettingsRailGroup,
} from "../components/settings/settings-rail-view";
import { PackageDetailBar } from "../components/package-detail/package-detail-bar";
import { ErrorState } from "../components/page-states";
import { ListTabSkeleton, PackageDetailSkeleton } from "../components/loading-skeletons";
import { PackageActionsDropdown } from "../components/package-detail/package-actions-dropdown";
import { SetupGuideSteps } from "../components/package-detail/setup-guide-steps";
import { PackageCommonSection } from "../components/package-detail/package-common-section";
import { isOwnedSource } from "../components/package-detail/owned-source";
import { PackageOwnershipNotice } from "../components/package-detail/package-ownership";
import { ConfigAuthBlock } from "../components/integration-detail/config-auth-block";
import { AccessRulesSection } from "../components/integration-detail/access-rules-section";
import { ConnectionsTable } from "../components/integration-detail/connections-table";
import { DefaultConnectionSettings } from "../components/integration-detail/default-connection-section";
import { IntegrationActivateButton } from "../components/integration-detail/integration-activate-button";
import { ConfigurationSpace } from "../components/configuration-space";
import { RoleLimitNotice } from "../components/role-limit-notice";
import { usePermissions, useHomeSpaceName } from "../hooks/use-permissions";
import { toolSnapshot } from "../lib/integration-tool-snapshot";
import { readIntegrationSource } from "../lib/package-manifest";
import { serverReadAvailability } from "../lib/integration-server-sync";
import { isUnauthenticatedIntegration } from "@appstrate/core/integration";
import {
  INTEGRATION_DEFINITION_SECTIONS,
  isIntegrationSpaceSection,
  resolveIntegrationSettingsSection,
} from "../lib/integration-settings-sections";
import { usePackageDetail, usePackageDownload, type Versioned } from "../hooks/use-packages";
import { useIntegrationDetail, useIntegrationDetailsIn } from "../hooks/use-integrations";
import { useCanReach } from "../hooks/use-can-reach";
import { useIntegrationSpaceAction } from "../components/integration-detail/use-integration-space";
import { useSpacesFor } from "../hooks/use-space-action";
import type { SpaceEntry } from "../hooks/use-space-entry";
import { useOverviewMode } from "../hooks/use-overview-mode";
import { useSpaceLabelOf } from "../hooks/use-spaces";
import { useCurrentSpaceId } from "../hooks/use-current-space";
import {
  integrationSettingsHref,
  isPackageCommonSection,
  type IntegrationSettingsSection,
} from "../lib/settings-section-href";

const IntegrationDefinitionEditor = lazy(() =>
  import("./package-editor").then((module) => ({
    default: module.IntegrationDefinitionEditor,
  })),
);

/** Rail id → editor section. Contenu (`bundle`) is not one: it reads the bundle. */
type DefinitionRailEntry = [IntegrationSettingsSection, IntegrationDefinitionSection];
/** The heading of each section set in one space (`isIntegrationSpaceSection`). */
const SPACE_SECTION_HEADINGS = {
  authentication: {
    title: "integration.presentation.authentication",
    description: "integration.presentation.authenticationDescription",
  },
  access: {
    title: "integration.admin.access.title",
    description: "integration.config.accessDescription",
  },
  "default-connection": {
    title: "integration.defaultConnection.title",
    description: "integration.defaultConnection.description",
  },
} as const;

const DEFINITION_RAIL: readonly DefinitionRailEntry[] = [
  ["identity", "general"],
  ["source", "source"],
  ["auth-methods", "auths"],
  ["tools", "tools"],
];

export function IntegrationSettings({
  packageId,
  detail,
  blockUserConnections,
  spaceIds,
  configureIn,
  definition,
  isOwned,
  published,
  versionGrants,
}: {
  packageId: string;
  /** The spaces the integration is active in: in « Tous les espaces », where it is configured from. */
  spaceIds: readonly string[];
  /** Where it is configured from: `useIntegrationSpaceAction` on `integrations:configure`. */
  configureIn: SpaceEntry;
  detail: NonNullable<ReturnType<typeof useIntegrationDetail>["data"]>;
  blockUserConnections: boolean;
  /**
   * The package draft, present when the reader may change the definition: its
   * sections are then edited here, in place. Absent, Définition stays a read.
   */
  definition?: Versioned<OrgPackageItemDetail>;
  /** A system integration has no version history of its own. */
  isOwned: boolean;
  /** A version is published: the server's tools are read from the latest one. */
  published: boolean;
  /** What the version history may do: restore needs the home space's write, delete its delete. */
  versionGrants: { canRestore: boolean; canDelete: boolean };
}) {
  const { t } = useTranslation(["settings", "agents"]);
  const { can } = usePermissions();
  const { on: overview } = useOverviewMode();
  const workingSpaceId = useCurrentSpaceId();
  const workingSpace = useSpaceLabelOf()(workingSpaceId);
  const fromWorkingSpace = shownFromWorkingSpace(overview, workingSpaceId, spaceIds);
  const canConfigure = configureIn.offered;
  const { value: clientTarget, close: closeClient } = useUrlModal(EDIT_OAUTH_CLIENT_PARAM);
  const hasClientTable =
    detail.active &&
    detail.auths.some(
      (auth) =>
        auth.type === "oauth2" &&
        !!detail.manifest.auths?.[auth.auth_key] &&
        integrationClientModalRef(auth.auth_key, clientTarget) !== null,
    );
  useEffect(() => {
    if (clientTarget !== null && !hasClientTable) closeClient();
  }, [clientTarget, hasClientTable, closeClient]);

  // The identity read calls the server of the DRAFT, published or not: the copy this editor writes.
  // A reader without the draft reads the saved one: the listing is asked for with its source.
  const readManifest = definition?.manifest ?? detail.manifest;
  const serverRead = serverReadAvailability(readIntegrationSource(readManifest.source), {
    unauthenticated: isUnauthenticatedIntegration(readManifest),
    mayProxy: can("credential-proxy:call-own"),
    hasConnection: detail.auths.some((auth) => auth.connections.length > 0),
  });
  const snapshot = toolSnapshot(detail, serverRead, published);
  // Only a remote integration lists tools a space can review. The review is one space's: it
  // follows the sections set in a space (`isIntegrationSpaceSection`) in « Tous les espaces ».
  // An author of the draft reads it too, to declare the listed tools.
  const toolPolicy =
    snapshot && (canConfigure || !!definition)
      ? (declaration?: ToolDeclaration): ToolPolicyAccess => {
          // The decisions are the working space's; declaring is the integration's, whatever the space.
          const spaceLine = canConfigure && fromWorkingSpace;
          return {
            packageId,
            review: spaceLine && detail.active && can("integrations:configure"),
            declaration,
            banner: (
              <>
                {canConfigure && overview && (
                  <ConfigurationSpace
                    label={t("detail.configuration.spaceLabel", { ns: "agents" })}
                    choiceLabel={t("detail.configuration.spaceChoice", { ns: "agents" })}
                    spaceIds={spaceIds}
                    enter={configureIn}
                  />
                )}
                {spaceLine &&
                  (!detail.active ? (
                    <ActivationHint />
                  ) : (
                    overview &&
                    !can("integrations:configure") &&
                    workingSpace && (
                      <RoleLimitNotice>
                        {t("integration.config.roleLimitIn", { space: workingSpace })}
                      </RoleLimitNotice>
                    )
                  ))}
              </>
            ),
          };
        }
      : undefined;
  const resolve = (requested: string | null): IntegrationSettingsSection =>
    resolveIntegrationSettingsSection(requested, {
      canConfigure,
      isOwned,
      hasDefinition: !!definition,
    });
  const steps = detail.manifest.setup_guide?.steps ?? [];
  // Same order as an agent's: Explorer (see it: files, versions), then
  // what is set here, then the AFPS package, what the integration IS for every
  // space, edited in place when the reader may. The tool catalogue is the package's; what a
  // server exposes is read per connection and kept as a snapshot.
  const item = (
    id: IntegrationSettingsSection,
    icon: SectionRailItem["icon"],
    label: string,
  ): SettingsRailGroup<IntegrationSettingsSection>["items"][number] => ({ id, icon, label });
  const groups = [
    {
      title: t("detail.settings.exploreGroup", { ns: "agents" }),
      items: [
        item("files", FolderTree, t("detail.overview.explorer", { ns: "agents" })),
        ...(isOwned
          ? [item("versions", History, t("detail.settings.versions", { ns: "agents" }))]
          : []),
      ],
    },
    ...(canConfigure
      ? [
          {
            title: t("detail.settings.configurationGroup", { ns: "agents" }),
            items: [
              item("authentication", KeyRound, t("integration.presentation.authentication")),
              item("access", ShieldCheck, t("integration.admin.access.title")),
              item("default-connection", Star, t("integration.defaultConnection.title")),
            ],
          },
        ]
      : []),
    {
      title: t("detail.settings.definitionGroup", { ns: "agents" }),
      items: [
        ...(definition
          ? [
              item("identity", IdCard, t("editor.tabGeneral", { ns: "agents" })),
              item("source", Server, t("integrationEditor.tabSource", { ns: "agents" })),
              item(
                "auth-methods",
                KeyRound,
                t("integrationEditor.tabAuthMethods", { ns: "agents" }),
              ),
            ]
          : [item("functioning", Plug, t("orgSettings.tabGeneral"))]),
        item("tools", Wrench, t("integrationEditor.tabTools", { ns: "agents" })),
      ],
    },
  ];
  return (
    <SettingsRailView
      param="integrationSettings"
      tab="settings"
      label={t("integration.tabs.settings")}
      groups={groups}
      resolve={resolve}
      definitionSections={INTEGRATION_DEFINITION_SECTIONS}
    >
      {({ active, file, href }) => {
        const definitionSection = definition
          ? DEFINITION_RAIL.find(([id]) => id === active)?.[1]
          : undefined;
        return definition && definitionSection ? (
          <Suspense fallback={<SettingsSkeleton />}>
            <IntegrationDefinitionEditor
              detail={definition}
              section={definitionSection}
              toolCatalog={detail.tool_catalog ?? []}
              snapshot={snapshot}
              serverRead={serverRead}
              toolPolicy={toolPolicy}
            />
          </Suspense>
        ) : isPackageCommonSection(active) ? (
          <PackageCommonSection
            section={active}
            type="integration"
            packageId={packageId}
            file={file}
            href={href}
            manifestSection={definition ? "identity" : undefined}
            versions={versionGrants}
          />
        ) : active === "functioning" ? (
          <div className="p-6">
            <SettingsHeading title={t("orgSettings.tabGeneral")} description={null} />
            <IntegrationFunctioning detail={detail} />
          </div>
        ) : active === "tools" ? (
          <div className="p-6">
            <SettingsHeading
              title={t("integrationEditor.tabTools", { ns: "agents" })}
              description={t("integrationEditor.description.tools", { ns: "agents" })}
            />
            <IntegrationToolsSection
              packageId={packageId}
              tools={detail.tool_catalog ?? []}
              allowUndeclaredTools={detail.allow_undeclared_tools}
              snapshot={snapshot}
              spacePolicy={toolPolicy?.()}
            />
          </div>
        ) : isIntegrationSpaceSection(active) ? (
          // In « Tous les espaces » the space it is set in comes first.
          <div className="p-6">
            {overview && (
              <ConfigurationSpace
                label={t("detail.configuration.spaceLabel", { ns: "agents" })}
                choiceLabel={t("detail.configuration.spaceChoice", { ns: "agents" })}
                spaceIds={spaceIds}
                enter={configureIn}
              />
            )}
            {/* In the mode, the section is the working space's only when the line names it. */}
            {!fromWorkingSpace ? null : !detail.active ? (
              <ActivationHint />
            ) : overview && !can("integrations:configure") ? (
              workingSpace && (
                <RoleLimitNotice>
                  {t("integration.config.roleLimitIn", { space: workingSpace })}
                </RoleLimitNotice>
              )
            ) : (
              <>
                <SettingsHeading
                  title={t(SPACE_SECTION_HEADINGS[active].title)}
                  description={t(SPACE_SECTION_HEADINGS[active].description)}
                />
                {active === "authentication" && (
                  <div className="flex flex-col gap-4">
                    <SetupGuideSteps steps={steps} />
                    {detail.auths.length === 0 && (
                      <p className="text-sm">{t("integration.auth.none")}</p>
                    )}
                    <div className="flex flex-col gap-8">
                      {detail.auths.map((status) => {
                        const authDecl = detail.manifest.auths?.[status.auth_key];
                        if (!authDecl) return null;
                        return (
                          <section
                            key={status.auth_key}
                            id={`auth-${status.auth_key}`}
                            className="min-w-0"
                          >
                            <div className="mb-4 flex items-center gap-3">
                              <h3 className="text-base font-semibold">
                                {authMethodLabel(
                                  status,
                                  detail.auths,
                                  t(`integration.auth.type.${status.type}`),
                                )}
                              </h3>
                              <Badge variant="secondary">
                                {t(
                                  status.required
                                    ? "integration.auth.required"
                                    : "integration.auth.optional",
                                )}
                              </Badge>
                            </div>
                            <ConfigAuthBlock
                              packageId={packageId}
                              status={status}
                              authDecl={authDecl}
                            />
                          </section>
                        );
                      })}
                    </div>
                  </div>
                )}
                {active === "access" && (
                  <AccessRulesSection
                    packageId={packageId}
                    blockUserConnections={blockUserConnections}
                  />
                )}
                {active === "default-connection" && (
                  <DefaultConnectionSettings packageId={packageId} detail={detail} />
                )}
              </>
            )}
          </div>
        ) : null;
      }}
    </SettingsRailView>
  );
}

// ─────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────

/**
 * In « Tous les espaces », whether a per-space section is the working space's: the space line
 * names it only when the integration is active there (`spaceIds`). With a space selected, always.
 */
function shownFromWorkingSpace(
  overview: boolean,
  workingSpaceId: string | null,
  spaceIds: readonly string[],
): boolean {
  return !overview || (!!workingSpaceId && spaceIds.includes(workingSpaceId));
}

/**
 * Shown in place of connections and governance while the integration is not active: it points at
 * the header's « Activer », the page's one place for it, and names no space.
 */
function ActivationHint() {
  const { t } = useTranslation("settings");
  return (
    <div
      className="border-border bg-muted/40 rounded-lg border p-6 text-center"
      data-testid="activation-hint"
    >
      <p className="text-muted-foreground text-sm">{t("integrations.activate.hint")}</p>
    </div>
  );
}

export function IntegrationDetailPage() {
  const { t } = useTranslation(["settings", "common", "agents"]);
  const { scope, name } = useParams<{ scope: string; name: string }>();
  const packageId = scope && name ? `${scope}/${name}` : "";
  const detailQuery = useIntegrationDetail(packageId || undefined);
  const { data: detail, error } = detailQuery;
  const { data: pkg, isLoading: pkgLoading } = usePackageDetail(
    "integration",
    packageId || undefined,
  );
  const { on: overview } = useOverviewMode();
  const downloadPackage = usePackageDownload(scope, name);
  const { can } = usePermissions();
  // The package's own detail response is the authority on its home — both the
  // id (withheld unless this caller reaches that space) and the write verdict.
  const homeSpaceId = pkg?.home_space_id;
  const homeWritable = pkg?.home_writable;
  const homeDeletable = pkg?.home_deletable;
  const homeSpaceName = useHomeSpaceName(homeSpaceId);
  const spaceIds = pkg?.space_ids ?? [];
  // The working space's verdict, for what acts in it.
  const canConfigure = can("integrations:configure");
  const configureIn = useIntegrationSpaceAction(packageId, "integrations:configure", spaceIds);
  // In « Tous les espaces », the integration as each space it is active in reads it.
  const across = useIntegrationDetailsIn(packageId || undefined, overview ? spaceIds : []);
  const workingSpaceId = useCurrentSpaceId();
  const connectionsFromWorkingSpace = shownFromWorkingSpace(overview, workingSpaceId, spaceIds);
  // Hash-driven like the agent page, so the tab can be LINKED to. Needed
  // because "an administrator must register an OAuth client" is only useful if
  // it can point at the screen where that happens.
  const [tab, setTab] = useTabWithHash(INTEGRATION_TABS, "overview");
  const navigate = useNavigate();
  const location = useLocation();
  const openAuthentication = () =>
    void navigate(integrationSettingsHref(location.pathname, "authentication"));
  const openConnections = (authKey?: string) => {
    const params = new URLSearchParams(location.search);
    if (authKey) params.set("connectionMethod", authKey);
    else params.delete("connectionMethod");
    void navigate({ search: params.toString(), hash: "connections" });
  };
  const canReach = useCanReach();
  // In « Tous les espaces » the list spans the reader's spaces: some space opening it suffices.
  const canBrowseIntegrations = useSpacesFor({ route: "/integrations" }).offered;

  // Only the integration detail gates the page; the package detail brings `source` and
  // follows in place (badges, read-only alert, actions menu).
  if (isQueryInFlight(detailQuery)) return <PackageDetailSkeleton type="integration" />;
  if (error || !detail) {
    // Not placed in this space, or gone: one answer for both, and what the
    // member can do about either. In « Tous les espaces » the list names every space.
    return (
      <UnreadableDetail
        kind="integration"
        id={packageId}
        error={error}
        pending={<PackageDetailSkeleton type="integration" />}
        hint={t("integration.notInSpace.hint")}
      >
        {canBrowseIntegrations && (
          <Button variant="outline" asChild>
            <Link to="/integrations">
              {overview ? t("integration.notInSpace.backAcross") : t("integration.notInSpace.back")}
            </Link>
          </Button>
        )}
      </UnreadableDetail>
    );
  }

  const active = detail.active;
  const connectionSources = overview
    ? across.sources
    : active && workingSpaceId
      ? [{ spaceId: workingSpaceId, detail }]
      : [];
  const m = detail.manifest;
  // Only the package detail knows the source.
  const source = pkg?.source;
  const version = pkgLoading ? undefined : (pkg?.version ?? m.version);
  const isOwned = isOwnedSource(source);

  const tabs: DetailTab<(typeof INTEGRATION_TABS)[number]>[] = [
    { value: "overview", label: t("integration.tabs.overview"), icon: LayoutGrid },
    { value: "connections", label: t("integration.tabs.connections"), icon: Plug },
    { value: "settings", label: t("integration.tabs.settings"), icon: Settings2 },
  ];

  return (
    <DetailTabs value={tab} onChange={setTab}>
      <PackageDetailBar
        detail={{
          id: packageId,
          displayName: m.display_name ?? packageId,
          source: source ?? "",
          type: "integration",
          version,
          icon: typeof m.icon === "string" ? m.icon : undefined,
          homeSpaceName,
          homeSpaceId: homeSpaceId ?? null,
          spaceIds: pkgLoading ? undefined : (pkg?.space_ids ?? []),
        }}
        isHistoricalVersion={false}
        tabs={tabs}
        status={
          <>
            {pkgLoading && <Skeleton className="h-5 w-16" />}
            {/* The working space's switch: in « Tous les espaces » the spaces it is active in say it. */}
            {!overview && (
              <AvailabilityBadge type="integration" availability={detail.availability} />
            )}
          </>
        }
        actions={
          <>
            <IntegrationActivateButton packageId={packageId} activeHere={active} />
            {pkgLoading ? (
              <Skeleton className="size-8 rounded-md" />
            ) : (
              <PackageActionsDropdown
                packageId={packageId}
                type="integration"
                detail={pkg}
                isHistoricalVersion={false}
                downloadVersion={version}
                onDownload={downloadPackage}
                isActiveHere={active}
              />
            )}
          </>
        }
      />

      <PackageOwnershipNotice
        type="integration"
        isOwned={isOwned}
        forkedFrom={pkg?.forked_from ?? null}
        draftReadOnly={pkg?.definition === "draft" && !homeWritable}
        pending={pkgLoading}
      />

      {needsWizardFinish({
        manifest: m,
        // Unread, a package is not yet known to be unpublished.
        published: pkgLoading || (pkg?.version_count ?? 0) > 0,
        homeWritable: !!homeWritable,
        canOpenWizard: canReach("/integrations/new/mcp"),
      }) && (
        <Alert
          variant="info"
          className="mb-4"
          data-testid="integration-wizard-finish"
          action={
            <Button variant="outline" size="sm" asChild>
              <Link to={wizardResumePath(packageId)}>
                {t("integrationWizard.finish.action", { ns: "agents" })}
              </Link>
            </Button>
          }
        >
          <AlertTitle>{t("integrationWizard.finish.title", { ns: "agents" })}</AlertTitle>
          <AlertDescription>
            {t("integrationWizard.finish.description", { ns: "agents" })}
          </AlertDescription>
        </Alert>
      )}

      {/* One connected-accounts table, with each row retaining its auth context. */}
      <DetailTabPanel value="connections">
        {/* The working space's list, or in « Tous les espaces » one list spanning every space the
            integration is active in where the reader reads it; active nowhere, the hint. */}
        {overview && (pkgLoading || across.isLoading) ? (
          <ListTabSkeleton />
        ) : across.error ? (
          <ErrorState error={across.error} />
        ) : connectionSources.length === 0 ? (
          <ActivationHint />
        ) : connectionSources.every((source) => source.detail.auths.length === 0) ? (
          <p className="text-muted-foreground text-sm">{t("integration.auth.none")}</p>
        ) : (
          <ConnectionsTable
            packageId={packageId}
            sources={connectionSources}
            spanning={overview}
            addIn={connectionsFromWorkingSpace && active ? { detail, canConfigure } : undefined}
            onConfigure={openAuthentication}
          />
        )}
      </DetailTabPanel>

      {/* Configuration is admin-only; package files stay readable for every member. */}
      <DetailTabPanel value="settings" framed>
        {/* Its rail (definition, versions) depends on the package's source. */}
        {pkgLoading ? (
          <SettingsSkeleton className="p-6" />
        ) : (
          <IntegrationSettings
            packageId={packageId}
            detail={detail}
            blockUserConnections={detail.block_user_connections}
            spaceIds={spaceIds}
            configureIn={configureIn}
            // Write authority is the package's HOME space, never the space being browsed.
            definition={homeWritable && pkg ? pkg : undefined}
            isOwned={isOwned}
            published={(pkg?.version_count ?? 0) > 0}
            versionGrants={{
              canRestore: isOwned && !!homeWritable,
              canDelete: isOwned && !!homeDeletable,
            }}
          />
        )}
      </DetailTabPanel>

      {/* ─── Outils (effective tool catalog — read-only) ─── */}

      {/* Capabilities, connected accounts and package usage are distinct concepts. */}
      <DetailTabPanel value="overview">
        <IntegrationOverview
          packageId={packageId}
          detail={detail}
          spaceIds={pkgLoading ? undefined : spaceIds}
          dependentIds={pkg?.agents.map((agent) => agent.id)}
          onOpenConnections={openConnections}
          onConfigureAuth={configureIn.offered ? openAuthentication : undefined}
        />
      </DetailTabPanel>
    </DetailTabs>
  );
}
