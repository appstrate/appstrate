// SPDX-License-Identifier: Apache-2.0

/**
 * Integration detail: capabilities and usage, connected accounts, tools,
 * authentication/access settings, and the read-only artifact. Technical auth
 * identifiers never stand in for navigation or capability activation.
 * OAuth clients are listed in one table across tiers (the space's own, the
 * organization's, the system's); client and connection mutations retain their
 * ownership gates. The sections live in `components/integration-detail/`.
 */

import { lazy, Suspense, useState } from "react";
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
  FileArchive,
  IdCard,
  Server,
  Info,
} from "lucide-react";
import { authMethodLabel } from "../lib/integration-presentation";
import { Alert, AlertDescription } from "@appstrate/ui/components/alert";
import { Button } from "@appstrate/ui/components/button";
import { Badge } from "@appstrate/ui/components/badge";
import { Tabs, TabsContent } from "@appstrate/ui/components/tabs";
import { ErrorState, ResourceErrorState } from "../components/page-states";
import { SettingsSkeleton } from "../components/loading-skeletons";
import { DetailTabsList, DetailTabsTrigger } from "../components/agent-detail/agent-local-tabs";
import { SettingsHeading } from "../components/settings/settings-heading";
import type { SectionRailItem } from "../components/settings/section-rail";
import {
  SettingsRailView,
  type SettingsRailGroup,
} from "../components/settings/settings-rail-view";
import { PackageDetailSkeleton, SharedHeader } from "../components/package-detail/shared-header";
import { PackageActionsDropdown } from "../components/package-detail/package-actions-dropdown";
import { SetupGuideSteps } from "../components/package-detail/setup-guide-steps";
import { PackageCommonSection } from "../components/package-detail/package-common-section";
import { useModalParam } from "../hooks/use-modal-param";
import { ForkPackageModal } from "../components/fork-package-modal";
import { ConfirmModal } from "../components/confirm-modal";
import { ConfigAuthBlock } from "../components/integration-detail/config-auth-block";
import { AccessRulesSection } from "../components/integration-detail/access-rules-section";
import { ConnectionsTable } from "../components/integration-detail/connections-table";
import { usePermissions, useHomeSpaceName, useCurrentSpaceGrant } from "../hooks/use-permissions";
import { maySetPackageActive } from "../lib/package-permissions";
import {
  usePackageDetail,
  useDeletePackage,
  usePackageDownload,
  type Versioned,
} from "../hooks/use-packages";
import { useIntegrationDetail, type IntegrationDetailWire } from "../hooks/use-integrations";
import { useCurrentSpaceId } from "../hooks/use-current-space";
import { useCanReach } from "../hooks/use-can-reach";
import { useSetPackageActive } from "../hooks/use-library";
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
  onActivate,
  activationPending,
  canActivate,
  definition,
  isOwned,
  versionGrants,
}: {
  packageId: string;
  detail: NonNullable<ReturnType<typeof useIntegrationDetail>["data"]>;
  blockUserConnections: boolean;
  canConfigure: boolean;
  onActivate: () => void;
  activationPending: boolean;
  /** `maySetPackageActive` for this space — the hint names no button the route would refuse. */
  canActivate: boolean;
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
    requested === "bundle" ||
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
          : [item("functioning", Plug, t("integration.structure.functioning"))]),
        item("tools", Wrench, t("integrationEditor.tabTools", { ns: "agents" })),
        item("bundle", FileArchive, t("editor.tabPackageFiles", { ns: "agents" })),
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
            manifest={detail.manifest}
            file={file}
            href={href}
            manifestSection={definition ? "identity" : undefined}
            versions={versionGrants}
          />
        ) : active === "functioning" ? (
          <div className="p-6">
            <SettingsHeading title={t("integration.structure.functioning")} description={null} />
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
            <ActivationHint
              onActivate={onActivate}
              pending={activationPending}
              canActivate={canActivate}
            />
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
              <div className="space-y-6">
                <SetupGuideSteps steps={steps} />
                {detail.auths.length === 0 && (
                  <p className="text-sm">{t("integration.auth.none")}</p>
                )}
                <div className="space-y-8">
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
function ActivationHint({
  onActivate,
  pending,
  canActivate,
}: {
  onActivate: () => void;
  pending: boolean;
  /** The page's one activation verdict — the hint must not offer what the header hides. */
  canActivate: boolean;
}) {
  const { t } = useTranslation(["settings", "common"]);
  return (
    <div
      className="border-border bg-muted/30 rounded-md border p-6 text-center"
      data-testid="activation-hint"
    >
      <p className="text-muted-foreground mb-3 text-sm">{t("integrations.activate.hint")}</p>
      {canActivate && (
        <Button size="sm" onClick={onActivate} disabled={pending} data-testid="detail-activate-btn">
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
  // ONE pair of doors for every package family: an integration is activated in
  // a space by `POST /api/spaces/{id}/packages` and switched off by its
  // `DELETE`, exactly like an agent or a skill. The row and its settings
  // survive the deactivation — connections were never held there anyway.
  const setActive = useSetPackageActive();
  const currentSpaceId = useCurrentSpaceId();
  const deletePkg = useDeletePackage("integration");
  const downloadPackage = usePackageDownload(scope, name);
  const { can } = usePermissions();
  // The package's own detail response is the authority on its home — both the
  // id (withheld unless this caller reaches that space) and the write verdict.
  const homeSpaceId = pkg?.home_space_id;
  const homeWritable = pkg?.home_writable;
  const homeDeletable = pkg?.home_deletable;
  const homeShareable = pkg?.home_shareable;
  const homeSpaceName = useHomeSpaceName(homeSpaceId);
  const canConfigure = can("integrations:configure");
  // The tree's ONE activation verdict, and deliberately not
  // `can("integrations:install")`: `can()` unions the org and space permission
  // sets, and that union does not carry RBAC §3.6 — owning the space IS the
  // authorization, so a guest in their own personal space holds `operator`,
  // no `integrations:install`, and the route accepts all the same. A second
  // spelling here hides a control the server takes, right beside the dropdown
  // below, which asks `maySetPackageActive` and would offer its mirror image.
  const spaceGrant = useCurrentSpaceGrant();
  const canActivate = maySetPackageActive(spaceGrant, "integration", true);
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
  const fork = useModalParam("fork");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);
  const canBrowseIntegrations = useCanReach()("/integrations");

  // `source` (system or local) comes from the package detail only: wait for it.
  if (isLoading || pkgLoading) return <PackageDetailSkeleton type="integration" />;
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
  // Only the package detail knows the source. Unknown (read refused or failed) is not owned.
  const source = pkg?.source;
  const version = pkg?.version ?? m.version;
  const isBuiltIn = source === "system";
  // Org-owned packages are editable regardless of scope name; only system packages are read-only.
  const isOwned = source === "local";
  // The fork action's own verdict (`PackageActionsDropdown`), which also bounds `?fork`.
  const canFork = can("integrations:write") && !isOwned;
  const setActivation = (next: boolean, onSuccess?: () => void) => {
    if (!currentSpaceId) return;
    setActive.mutate({ spaceId: currentSpaceId, packageId, active: next }, { onSuccess });
  };
  const onActivate = () => setActivation(true);

  return (
    <div>
      <SharedHeader
        detail={{
          id: packageId,
          displayName: m.display_name ?? packageId,
          description: m.description ?? "",
          source: source ?? "",
          type: "integration",
          version,
          icon: typeof m.icon === "string" ? m.icon : undefined,
          homeSpaceName,
        }}
        isHistoricalVersion={false}
        activeSubpage={{
          label: t(`integration.tabs.${tab}`),
        }}
        actionsLeft={
          <Badge variant={active ? "success" : "warning"}>
            {active ? t("integrations.badge.active") : t("integrations.badge.inactive")}
          </Badge>
        }
        actionsRight={
          <>
            {!active && canActivate && (
              <Button
                size="sm"
                onClick={onActivate}
                disabled={setActive.isPending}
                data-testid="detail-activate-btn"
              >
                {t("integrations.btn.activate")}
              </Button>
            )}
            <PackageActionsDropdown
              packageId={packageId}
              type="integration"
              isOwned={isOwned}
              isBuiltIn={isBuiltIn}
              isHistoricalVersion={false}
              homeSpaceId={homeSpaceId}
              homeWritable={homeWritable}
              homeDeletable={homeDeletable}
              homeShareable={homeShareable}
              downloadVersion={version}
              onDownload={downloadPackage}
              onFork={() => fork.open()}
              canDeactivate={active}
              onDeactivate={() => setConfirmDeactivate(true)}
              activationPending={setActive.isPending}
              canDeletePackage={!!pkg && pkg.agents.length === 0}
              onDeletePackage={() => setConfirmDelete(true)}
            />
          </>
        }
      />

      {isBuiltIn && (
        <Alert variant="info" className="mb-4">
          <Info />
          <AlertDescription>{t("ownership.readOnly", { ns: "agents" })}</AlertDescription>
        </Alert>
      )}

      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as (typeof INTEGRATION_TABS)[number])}
        className="mt-2"
      >
        <DetailTabsList>
          <DetailTabsTrigger value="overview" data-testid="tab-overview">
            {t("integration.tabs.overview")}
          </DetailTabsTrigger>
          <DetailTabsTrigger value="connections" data-testid="tab-connections">
            {t("integration.tabs.connections")}
          </DetailTabsTrigger>
          <DetailTabsTrigger value="configuration" data-testid="tab-configuration">
            {t("integration.tabs.configuration")}
          </DetailTabsTrigger>
        </DetailTabsList>

        {/* One connected-accounts table, with each row retaining its auth context. */}
        <TabsContent
          value="connections"
          className="bg-card mt-0 space-y-8 rounded-lg border p-6 shadow-sm"
        >
          {!active ? (
            <ActivationHint
              onActivate={onActivate}
              pending={setActive.isPending}
              canActivate={canActivate}
            />
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
        </TabsContent>

        {/* Configuration is admin-only; package files stay readable for every member. */}
        <TabsContent
          value="configuration"
          className="bg-card mt-0 overflow-clip rounded-lg border shadow-sm"
        >
          <IntegrationSettings
            packageId={packageId}
            detail={detail}
            blockUserConnections={detail.block_user_connections}
            canConfigure={canConfigure}
            onActivate={onActivate}
            activationPending={setActive.isPending}
            canActivate={canActivate}
            // Write authority is the package's HOME space, never the space being browsed.
            definition={homeWritable && pkg ? pkg : undefined}
            isOwned={isOwned}
            versionGrants={{
              canRestore: isOwned && !!homeWritable,
              canDelete: isOwned && !!homeDeletable,
            }}
          />
        </TabsContent>

        {/* ─── Outils (effective tool catalog — read-only) ─── */}

        {/* Capabilities, connected accounts and package usage are distinct concepts. */}
        <TabsContent value="overview" className="bg-card mt-0 rounded-lg border p-6 shadow-sm">
          <IntegrationOverview
            detail={detail}
            dependentIds={pkg?.agents.map((agent) => agent.id)}
            onOpenConnections={openConnections}
            onConfigureAuth={canConfigure ? openAuthentication : undefined}
          />
        </TabsContent>
      </Tabs>

      {fork.value !== null && canFork && (
        <ForkPackageModal
          open
          onClose={fork.close}
          onLeave={fork.leave}
          packageId={packageId}
          defaultName={name ?? ""}
          type="integration"
        />
      )}

      <ConfirmModal
        open={confirmDeactivate}
        onClose={() => setConfirmDeactivate(false)}
        title={t("integrations.deactivate.title")}
        confirmLabel={t("packages.deactivate")}
        description={t("integrations.deactivate.confirm")}
        variant="default"
        isPending={setActive.isPending}
        onConfirm={() => setActivation(false, () => setConfirmDeactivate(false))}
      />

      <ConfirmModal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={t("integrations.delete.title")}
        confirmLabel={t("btn.delete", { ns: "common" })}
        description={t("packages.deleteConfirm", {
          type: t("packages.type.integration"),
          name: m.display_name ?? packageId,
        })}
        isPending={deletePkg.isPending}
        onConfirm={() =>
          deletePkg.mutate(packageId, {
            onSuccess: () => setConfirmDelete(false),
          })
        }
      />
    </div>
  );
}
