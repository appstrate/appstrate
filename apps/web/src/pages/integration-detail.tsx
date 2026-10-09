// SPDX-License-Identifier: Apache-2.0

/**
 * Integration detail page.
 *
 * Shares the unified package layout (SharedHeader + PackageActionsDropdown)
 * with agents and skills. The activate/deactivate toggle lives in the header
 * (left action); download / fork / delete live in the actions dropdown. The
 * manifest's metadata is rendered by the À propos tab. Integrations are
 * import-only — there is no in-app editor.
 *
 * Tabs:
 *   - Connexions — per-auth connect CTA (always the resolved default client —
 *     the org's custom client when registered, else the system client) and a
 *     table of connected accounts with rename / share / reconnect / disconnect.
 *     Runtime view, visible to members.
 *   - Configuration (admin) — per-auth metadata (scopes, resource, authorized
 *     URIs), the OAuth clients table (system + org + space custom), the org's
 *     own clients table (org admins), the BYO-app registration form, the org-wide access rules (block member connections,
 *     default connection, per-agent pins), and the publisher setup guide.
 *   - Outils — read-only catalog of tools the integration exposes (resolved
 *     server-side via `resolveIntegrationToolCatalog`: MCPB-canonical from
 *     the referenced mcp-server minus `hidden_tools` and connect.tool
 *     primitives). Per-tool description + required scopes + URL patterns.
 *   - À propos — metadata (version, author, license, repo, …), privacy policy,
 *     keywords.
 *   - Contenu — the artifact's own files, read-only, opening on
 *     INTEGRATION.md. This is where `manifest.json` is readable verbatim: an
 *     admin auditing a third-party integration before granting it OAuth scopes
 *     must not have to download the `.afps` and unzip it.
 *   - Versions — read-only release history (non-system packages only).
 *
 * Connect drives a popup through the hosted connect portal (issue #769) —
 * mint `/connect/session`, open the returned `connect_url` (which dispatches to
 * the provider OAuth screen or the hosted credential form), then refetch the
 * detail to surface the new connection row.
 */

import { useState } from "react";
import { useTabWithHash } from "../hooks/use-tab-with-hash";
import { ManifestOverview } from "../components/package-manifest/manifest-overview";
import { FileExplorer } from "../components/package-files/file-explorer";

/** Tab ids, also the URL fragments that select them. `content` is the same id
 *  the unified package page uses for its file explorer, so a deep link reads
 *  the same on either page. */
const INTEGRATION_TABS = [
  "connections",
  "configuration",
  "tools",
  "about",
  "content",
  "versions",
] as const;
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router-dom";
import { Button } from "@appstrate/ui/components/button";
import { Badge } from "@appstrate/ui/components/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@appstrate/ui/components/tabs";
import { LoadingState, ErrorState, ResourceErrorState } from "../components/page-states";
import { SharedHeader } from "../components/package-detail/shared-header";
import { PackageActionsDropdown } from "../components/package-detail/package-actions-dropdown";
import { SetupGuideSteps } from "../components/package-detail/setup-guide-steps";
import { VersionHistory } from "../components/version-history";
import { ForkPackageModal } from "../components/fork-package-modal";
import { ConfirmModal } from "../components/confirm-modal";
import { ConnectAuthBlock } from "../components/integration-detail/connect-auth-block";
import { ConfigAuthBlock } from "../components/integration-detail/config-auth-block";
import { AccessRulesSection } from "../components/integration-detail/access-rules-section";
import { usePermissions, useHomeSpaceName, useCurrentSpaceGrant } from "../hooks/use-permissions";
import { maySetPackageActive } from "../lib/package-permissions";
import { usePackageDetail, useDeletePackage, usePackageDownload } from "../hooks/use-packages";
import { useIntegrationDetail } from "../hooks/use-integrations";
import { useCurrentSpaceId } from "../hooks/use-current-space";
import { useCanReach } from "../hooks/use-can-reach";
import { useSetPackageActive } from "../hooks/use-library";

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
  const [tab, setTab] = useTabWithHash(INTEGRATION_TABS, "connections");
  const [forkOpen, setForkOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);
  const canBrowseIntegrations = useCanReach()("/integrations");

  // `source` (system or local) comes from the package detail only: wait for it.
  if (isLoading || pkgLoading) return <LoadingState />;
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
  const source = pkg?.source ?? "local";
  const version = pkg?.version ?? m.version;
  const isBuiltIn = source === "system";
  // Org-owned packages are editable regardless of scope name; only system packages are read-only.
  const isOwned = !isBuiltIn;
  const setActivation = (next: boolean, onSuccess?: () => void) => {
    if (!currentSpaceId) return;
    setActive.mutate({ spaceId: currentSpaceId, packageId, active: next }, { onSuccess });
  };
  const onActivate = () => setActivation(true);

  return (
    <div className="p-6">
      <SharedHeader
        detail={{
          id: packageId,
          displayName: m.display_name ?? packageId,
          description: m.description ?? "",
          source,
          type: "integration",
          version,
          icon: typeof m.icon === "string" ? m.icon : undefined,
          homeSpaceName,
        }}
        isHistoricalVersion={false}
        actionsLeft={
          <span
            className={
              active
                ? "rounded bg-emerald-500/10 px-1.5 py-0.5 text-[0.65rem] font-medium text-emerald-500"
                : "bg-warning/10 text-warning rounded px-1.5 py-0.5 text-[0.65rem] font-medium"
            }
          >
            {active ? t("integrations.badge.active") : t("integrations.badge.inactive")}
          </span>
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
              onFork={() => setForkOpen(true)}
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
        <div className="mb-4 rounded-lg border border-blue-500/30 bg-blue-500/5 px-4 py-3 text-sm text-blue-400">
          {t("ownership.readOnly", { ns: "agents" })}
        </div>
      )}

      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as (typeof INTEGRATION_TABS)[number])}
        className="mt-2"
      >
        <div className="max-w-full overflow-x-auto pb-1">
          <TabsList className="w-max">
            <TabsTrigger value="connections" data-testid="tab-connections">
              {t("integration.tabs.connections")}
            </TabsTrigger>
            {canConfigure && (
              <TabsTrigger value="configuration" data-testid="tab-configuration">
                {t("integration.tabs.configuration")}
              </TabsTrigger>
            )}
            <TabsTrigger value="tools" data-testid="tab-tools">
              {t("integration.tabs.tools")}
              {detail.tool_catalog && detail.tool_catalog.length > 0 && (
                <Badge variant="outline" className="ml-1.5 text-[0.65rem]">
                  {detail.tool_catalog.length}
                  {detail.allow_undeclared_tools ? "+" : ""}
                </Badge>
              )}
              {detail.tool_catalog &&
                detail.tool_catalog.length === 0 &&
                detail.allow_undeclared_tools && (
                  <Badge
                    variant="outline"
                    className="ml-1.5 text-[0.65rem]"
                    data-testid="tab-tools-wildcard-badge"
                  >
                    *
                  </Badge>
                )}
            </TabsTrigger>
            <TabsTrigger value="about" data-testid="tab-about">
              {t("integration.tabs.about")}
            </TabsTrigger>
            <TabsTrigger value="content" data-testid="tab-content">
              {t("detail.tabFiles", { ns: "agents" })}
            </TabsTrigger>
            {!isBuiltIn && (
              <TabsTrigger value="versions" data-testid="tab-versions">
                {t("integration.tabs.versions")}
              </TabsTrigger>
            )}
          </TabsList>
        </div>

        {/* ─── Connexions (per-auth connect CTA + accounts table) ─── */}
        <TabsContent value="connections" className="mt-4 space-y-4">
          {!active ? (
            <ActivationHint
              onActivate={onActivate}
              pending={setActive.isPending}
              canActivate={canActivate}
            />
          ) : detail.auths.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t("integration.auth.none")}</p>
          ) : (
            detail.auths.map((authStatus) => (
              <ConnectAuthBlock
                key={authStatus.auth_key}
                packageId={packageId}
                status={authStatus}
                manifest={detail.manifest}
                personalConnectionsBlocked={detail.block_user_connections}
              />
            ))
          )}
        </TabsContent>

        {/* ─── Configuration (admin: OAuth clients, auth metadata, access
            rules, publisher setup guide). Separated from the runtime
            Connexions view so client setup and connected accounts no longer
            share one crowded card. ─── */}
        {canConfigure && (
          <TabsContent value="configuration" className="mt-4 space-y-4">
            {!active ? (
              <ActivationHint
                onActivate={onActivate}
                pending={setActive.isPending}
                canActivate={canActivate}
              />
            ) : (
              <>
                {/* AFPS §7.10 — publisher-authored prerequisites (OAuth app
                    creation, redirect URI registration, …): admin setup, so it
                    belongs with the client configuration. */}
                {(m as { setup_guide?: { steps?: Array<{ label: string; url?: string }> } })
                  .setup_guide?.steps &&
                  (m as { setup_guide?: { steps?: Array<{ label: string; url?: string }> } })
                    .setup_guide!.steps!.length > 0 && (
                    <SetupGuideSteps
                      steps={
                        (
                          m as {
                            setup_guide?: { steps?: Array<{ label: string; url?: string }> };
                          }
                        ).setup_guide!.steps!
                      }
                    />
                  )}
                {detail.auths.length === 0 ? (
                  <p className="text-muted-foreground text-sm">{t("integration.auth.none")}</p>
                ) : (
                  detail.auths.map((authStatus) => {
                    const declared = (m.auths ?? {})[authStatus.auth_key];
                    if (!declared) return null;
                    return (
                      <ConfigAuthBlock
                        key={authStatus.auth_key}
                        packageId={packageId}
                        status={authStatus}
                        authDecl={declared}
                      />
                    );
                  })
                )}
                <AccessRulesSection
                  packageId={packageId}
                  blockUserConnections={detail.block_user_connections}
                />
              </>
            )}
          </TabsContent>
        )}

        {/* ─── Outils (effective tool catalog — read-only) ─── */}
        <TabsContent value="tools" className="mt-4">
          <div className="max-w-2xl space-y-3">
            <p className="text-muted-foreground text-xs">{t("integration.tools.intro")}</p>
            {detail.allow_undeclared_tools && (
              <div
                className="rounded-md border-l-2 border-amber-500/30 bg-amber-500/5 p-3 text-xs"
                data-testid="integration-tools-wildcard-notice"
              >
                <p className="font-medium">{t("integration.tools.wildcardNotice.title")}</p>
                <p className="text-muted-foreground mt-1">
                  {t("integration.tools.wildcardNotice.body")}
                </p>
              </div>
            )}
            {(detail.tool_catalog ?? []).length === 0 ? (
              <p className="text-muted-foreground text-sm">{t("integration.tools.none")}</p>
            ) : (
              <div className="grid gap-2">
                {(detail.tool_catalog ?? []).map((tool) => {
                  const scopesByAuth = Object.entries(tool.policy?.required_scopes ?? {}).filter(
                    ([, s]) => s.length > 0,
                  );
                  return (
                    <div
                      key={tool.name}
                      className="bg-muted/30 rounded-md border p-3 text-xs"
                      data-testid={`integration-tool-${tool.name}`}
                    >
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="font-mono text-sm font-semibold">{tool.name}</span>
                      </div>
                      {tool.description && (
                        <p className="text-muted-foreground mt-1">{tool.description}</p>
                      )}
                      {scopesByAuth.map(([authKey, scopes]) => (
                        <p key={authKey} className="text-muted-foreground mt-2">
                          {t("integration.tools.requires")}{" "}
                          <Badge variant="outline" className="mr-1 font-mono text-[0.65rem]">
                            {authKey}
                          </Badge>
                          {scopes.map((s) => (
                            <Badge
                              key={s}
                              variant="secondary"
                              className="mr-1 font-mono text-[0.65rem]"
                            >
                              {s}
                            </Badge>
                          ))}
                        </p>
                      ))}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </TabsContent>

        {/* ─── À propos (manifest, rendered) ───
            The same component the Aperçu tab of the unified package page
            mounts. It replaced a local metadata block that built
            `<a href={manifest.repository}>` with no protocol check — a
            published integration carrying `"repository": "javascript:…"` ran
            on the platform origin as soon as someone clicked it. The href is
            now gated on `normalizeHttpUrl`. */}
        <TabsContent value="about" className="mt-4">
          <div className="max-w-2xl">
            <ManifestOverview manifest={m} type="integration" />
          </div>
        </TabsContent>

        {/* ─── Contenu (the artifact's own files, read-only) ───
            Same generic explorer the unified package page mounts; the type
            only decides which file opens first (INTEGRATION.md here). No
            `version` prop: this page has no historical-version view, so the
            explorer reads the live draft. */}
        <TabsContent value="content" className="mt-4">
          <FileExplorer packageId={packageId} type="integration" />
        </TabsContent>

        {/* ─── Versions (read-only history; non-system only) ─── */}
        {!isBuiltIn && (
          <TabsContent value="versions" className="mt-4">
            <VersionHistory
              packageId={packageId}
              type="integration"
              canRestore={isOwned && !!homeWritable}
              canDelete={isOwned && !!homeDeletable}
            />
          </TabsContent>
        )}
      </Tabs>

      <ForkPackageModal
        open={forkOpen}
        onClose={() => setForkOpen(false)}
        packageId={packageId}
        defaultName={name ?? ""}
        type="integration"
      />

      <ConfirmModal
        open={confirmDeactivate}
        onClose={() => setConfirmDeactivate(false)}
        title={t("btn.confirm", { ns: "common" })}
        description={t("integrations.deactivate.confirm")}
        variant="default"
        isPending={setActive.isPending}
        onConfirm={() => setActivation(false, () => setConfirmDeactivate(false))}
      />

      <ConfirmModal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={t("btn.confirm", { ns: "common" })}
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
