// SPDX-License-Identifier: Apache-2.0

/**
 * Integration detail: capabilities and usage, connected accounts, tools,
 * authentication/access settings, and the read-only artifact. Technical auth
 * identifiers never stand in for navigation or capability activation.
 * OAuth clients are listed in one table across tiers (the space's own, the
 * organization's, the system's); client and connection mutations retain their
 * ownership gates. The sections live in `components/integration-detail/`.
 */

import { lazy, Suspense } from "react";
import { useTabWithHash } from "../hooks/use-tab-with-hash";
import { IntegrationOverview } from "../components/package-detail/integration-overview";
import { IntegrationFunctioning } from "../components/package-detail/integration-structure";
import { IntegrationToolsSection } from "../components/integration-editor/integration-tools-section";

const INTEGRATION_TABS = ["overview", "connections", "configuration"] as const;
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
} from "lucide-react";
import { InlineMarkdown } from "../components/markdown";
import { authMethodLabel } from "../lib/integration-presentation";
import { Button } from "@appstrate/ui/components/button";
import { Badge } from "@appstrate/ui/components/badge";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { ErrorState, ResourceErrorState } from "../components/page-states";
import { SettingsSkeleton } from "../components/loading-skeletons";
import { DetailTabs, DetailTabPanel, type DetailTab } from "../components/detail-tabs";
import { SettingsHeading } from "../components/settings/settings-heading";
import type { SectionRailItem } from "../components/settings/section-rail";
import {
  SettingsRailView,
  type SettingsRailGroup,
} from "../components/settings/settings-rail-view";
import { PackageDetailBar } from "../components/package-detail/package-detail-bar";
import { PackageDetailSkeleton } from "../components/loading-skeletons";
import { PackageActionsDropdown } from "../components/package-detail/package-actions-dropdown";
import { CatalogueLink } from "../components/package-detail/catalogue-link";
import { HeaderActionButton } from "../components/header-action-button";
import { SetupGuideSteps } from "../components/package-detail/setup-guide-steps";
import { PackageCommonSection } from "../components/package-detail/package-common-section";
import { isOwnedSource } from "../components/package-detail/owned-source";
import { PackageOwnershipNotice } from "../components/package-detail/package-ownership";
import { ConfigAuthBlock } from "../components/integration-detail/config-auth-block";
import { AccessRulesSection } from "../components/integration-detail/access-rules-section";
import { ConnectionsTable } from "../components/integration-detail/connections-table";
import { usePermissions, useHomeSpaceName } from "../hooks/use-permissions";
import { usePackageDetail, usePackageDownload, type Versioned } from "../hooks/use-packages";
import { useIntegrationDetail, type IntegrationDetailWire } from "../hooks/use-integrations";
import { useCanReach } from "../hooks/use-can-reach";
import { usePackageActivation } from "../hooks/use-library";
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
const DEFINITION_RAIL: readonly DefinitionRailEntry[] = [
  ["identity", "general"],
  ["source", "source"],
  ["auth-methods", "auths"],
  ["tools", "tools"],
];
const DEFINITION_SECTIONS: readonly string[] = DEFINITION_RAIL.map(([id]) => id);

function IntegrationGeneral({ detail }: { detail: IntegrationDetailWire }) {
  return <IntegrationFunctioning detail={detail} />;
}

function IntegrationSettings({
  packageId,
  detail,
  blockUserConnections,
  canConfigure,
  definition,
  isOwned,
  versionGrants,
}: {
  packageId: string;
  detail: NonNullable<ReturnType<typeof useIntegrationDetail>["data"]>;
  blockUserConnections: boolean;
  canConfigure: boolean;
  /**
   * The package draft, present when the reader may change the definition: its
   * sections are then edited here, in place. Absent, Définition stays a read.
   */
  definition?: Versioned<OrgPackageItemDetail>;
  /** A system integration has no version history of its own. */
  isOwned: boolean;
  /** What the version history may do: restore needs the home space's write, delete its delete. */
  versionGrants: { canRestore: boolean; canDelete: boolean };
}) {
  const { t } = useTranslation(["settings", "agents"]);
  const navigate = useNavigate();
  const resolve = (requested: string | null): IntegrationSettingsSection =>
    requested === "tools" ||
    requested === "functioning" ||
    (requested === "versions" && isOwned) ||
    (definition && requested && DEFINITION_SECTIONS.includes(requested))
      ? (requested as IntegrationSettingsSection)
      : requested === "files" || !canConfigure
        ? "files"
        : requested === "access"
          ? "access"
          : "authentication";
  const steps = detail.manifest.setup_guide?.steps ?? [];
  // Same order as an agent's: Explorer (see it: files, versions), then
  // what is set here, then the AFPS package, what the integration IS for every
  // space, edited in place when the reader may. The tool catalogue belongs to
  // the package: nothing about it is set per organization or per space.
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
              item("access", ShieldCheck, t("integration.admin.accessRules.title")),
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
      tab="configuration"
      label={t("integration.tabs.configuration")}
      groups={groups}
      resolve={resolve}
      definitionSections={DEFINITION_SECTIONS}
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
              onSection={(next) => {
                const railId = DEFINITION_RAIL.find(([, section]) => section === next)?.[0];
                if (railId) void navigate(href(railId));
              }}
              toolCatalog={detail.tool_catalog ?? []}
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
            <IntegrationGeneral detail={detail} />
          </div>
        ) : active === "tools" ? (
          <div className="p-6">
            <SettingsHeading
              title={t("integrationEditor.tabTools", { ns: "agents" })}
              description={t("integrationEditor.description.tools", { ns: "agents" })}
            />
            <IntegrationToolsSection
              tools={detail.tool_catalog ?? []}
              allowUndeclaredTools={detail.allow_undeclared_tools}
            />
          </div>
        ) : !detail.active ? (
          <div className="p-6">
            <ActivationHint packageId={packageId} />
          </div>
        ) : (
          <div className="p-6">
            <SettingsHeading
              title={t(
                active === "access"
                  ? "integration.admin.accessRules.title"
                  : "integration.presentation.authentication",
              )}
              description={t(
                active === "access"
                  ? "integration.config.accessDescription"
                  : "integration.presentation.authenticationDescription",
              )}
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
          </div>
        );
      }}
    </SettingsRailView>
  );
}

// ─────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────

/**
 * Inline prompt shown inside the Connexions tab when the integration is not
 * yet active — connecting and governance are meaningless until the
 * integration is activated for this space.
 */
function ActivationHint({ packageId }: { packageId: string }) {
  const { t } = useTranslation(["settings", "common"]);
  // The hint names no button the route would refuse.
  const { mayActivate, activate, pending } = usePackageActivation(packageId);
  return (
    <div
      className="border-border bg-muted/30 rounded-md border p-6 text-center"
      data-testid="activation-hint"
    >
      <p className="text-muted-foreground mb-3 text-sm">{t("integrations.activate.hint")}</p>
      {mayActivate && (
        <Button
          size="sm"
          onClick={() => activate()}
          disabled={pending}
          data-testid="detail-activate-btn"
        >
          {t("integrations.btn.activate")}
        </Button>
      )}
    </div>
  );
}

export function IntegrationDetailPage() {
  const { t } = useTranslation(["settings", "common", "agents"]);
  const { scope, name } = useParams<{ scope: string; name: string }>();
  const packageId = scope && name ? `${scope}/${name}` : "";
  const { data: detail, isLoading, error } = useIntegrationDetail(packageId || undefined);
  const { data: pkg, isLoading: pkgLoading } = usePackageDetail(
    "integration",
    packageId || undefined,
  );
  const activation = usePackageActivation(packageId);
  const downloadPackage = usePackageDownload(scope, name);
  const { can } = usePermissions();
  // The package's own detail response is the authority on its home — both the
  // id (withheld unless this caller reaches that space) and the write verdict.
  const homeSpaceId = pkg?.home_space_id;
  const homeWritable = pkg?.home_writable;
  const homeDeletable = pkg?.home_deletable;
  const homeSpaceName = useHomeSpaceName(homeSpaceId);
  const canConfigure = can("integrations:configure");
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
  const canBrowseIntegrations = useCanReach()("/integrations");

  // Only the integration detail gates the page; the package detail brings `source` and
  // follows in place (badges, read-only alert, actions menu).
  if (isLoading) return <PackageDetailSkeleton type="integration" />;
  if (error) {
    // Not placed in this space, or gone: one answer for both, and what the
    // member can do about either.
    return (
      <ResourceErrorState error={error} hint={t("integration.notInSpace.hint")}>
        {canBrowseIntegrations && (
          <Button variant="outline" asChild>
            <Link to="/integrations">{t("integration.notInSpace.back")}</Link>
          </Button>
        )}
      </ResourceErrorState>
    );
  }
  if (!detail) return <ErrorState message={t("packages.detailNotFound")} />;

  const active = detail.active;
  const m = detail.manifest;
  // Only the package detail knows the source.
  const source = pkg?.source;
  const version = pkgLoading ? undefined : (pkg?.version ?? m.version);
  const isOwned = isOwnedSource(source);

  const tabs: DetailTab<(typeof INTEGRATION_TABS)[number]>[] = [
    { value: "overview", label: t("integration.tabs.overview"), icon: LayoutGrid },
    { value: "connections", label: t("integration.tabs.connections"), icon: Plug },
    { value: "configuration", label: t("integration.tabs.configuration"), icon: Settings2 },
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
        }}
        isHistoricalVersion={false}
        tabs={tabs}
        status={
          <>
            {pkgLoading && <Skeleton className="h-5 w-16" />}
            <Badge variant={active ? "success" : "warning"}>
              {active ? t("integrations.badge.active") : t("integrations.badge.inactive")}
            </Badge>
          </>
        }
        actions={
          <>
            {/* No version route here: the sheet opens on the integration as read. */}
            <CatalogueLink type="integration" packageId={packageId} />
            {!active && activation.mayActivate && (
              <HeaderActionButton
                primary
                onClick={() => activation.activate()}
                disabled={activation.pending}
                data-testid="detail-activate-btn"
              >
                {t("integrations.btn.activate")}
              </HeaderActionButton>
            )}
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
      />

      {/* One connected-accounts table, with each row retaining its auth context. */}
      <DetailTabPanel value="connections">
        {!active ? (
          <ActivationHint packageId={packageId} />
        ) : detail.auths.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("integration.auth.none")}</p>
        ) : (
          <ConnectionsTable
            packageId={packageId}
            detail={detail}
            canConfigure={canConfigure}
            onConfigure={openAuthentication}
          />
        )}
      </DetailTabPanel>

      {/* Configuration is admin-only; package files stay readable for every member. */}
      <DetailTabPanel value="configuration" flush>
        {/* Its rail (definition, versions) depends on the package's source. */}
        {pkgLoading ? (
          <SettingsSkeleton className="p-6" />
        ) : (
          <IntegrationSettings
            packageId={packageId}
            detail={detail}
            blockUserConnections={detail.block_user_connections}
            canConfigure={canConfigure}
            // Write authority is the package's HOME space, never the space being browsed.
            definition={homeWritable && pkg ? pkg : undefined}
            isOwned={isOwned}
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
        {m.description && (
          <p className="mb-6 text-sm">
            <InlineMarkdown>{m.description}</InlineMarkdown>
          </p>
        )}
        <IntegrationOverview
          detail={detail}
          dependentIds={pkg?.agents.map((agent) => agent.id)}
          onOpenConnections={openConnections}
          onConfigureAuth={canConfigure ? openAuthentication : undefined}
        />
      </DetailTabPanel>
    </DetailTabs>
  );
}
