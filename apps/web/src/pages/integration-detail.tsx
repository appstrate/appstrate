// SPDX-License-Identifier: Apache-2.0

/**
 * Integration detail page (INTEGRATIONS_PROPOSAL Phase 1.3).
 *
 * Surfaces:
 *   - About / metadata (display name, version, author, license, repo, …)
 *   - Capabilities (server type, transport, tools dynamic, compatibility)
 *   - Auths — per-auth status with connect/disconnect, multi-account list,
 *     scope display, audience (RFC 8707), authorized URIs.
 *   - OAuth client (admin) — registration form for oauth2 auths whose
 *     IdP requires pre-registered client credentials.
 *
 * OAuth connect drives a popup against `/api/integrations/.../connect/oauth2`,
 * polls for popup close, then refetches the detail to surface the new
 * connection row.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams, Link } from "react-router-dom";
import {
  Boxes,
  Trash2,
  ShieldCheck,
  Settings2,
  AlertTriangle,
  Pencil,
  Check,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { PageHeader } from "../components/page-header";
import { LoadingState, ErrorState } from "../components/page-states";
import { usePermissions } from "../hooks/use-permissions";
import {
  useIntegrationDetail,
  useInstallIntegration,
  useUninstallIntegration,
  useIntegrationOAuthClient,
  useUpsertIntegrationOAuthClient,
  useDeleteIntegrationOAuthClient,
  useIntegrationRequiredScopes,
  useUpdateIntegrationConnection,
  useUpdateIntegrationSettings,
  type IntegrationAuthStatus,
  type IntegrationConnection,
  type IntegrationManifestView,
  type IntegrationManifestAuth,
} from "../hooks/use-integrations";
import { useIntegrations } from "../hooks/use-integrations";

// ─────────────────────────────────────────────
// OAuth client (admin) form
// ─────────────────────────────────────────────

function OAuthClientForm({ packageId, authKey }: { packageId: string; authKey: string }) {
  const { t } = useTranslation("settings");
  const { data: client, isLoading } = useIntegrationOAuthClient(packageId, authKey);
  const upsert = useUpsertIntegrationOAuthClient();
  const del = useDeleteIntegrationOAuthClient();
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [redirectUri, setRedirectUri] = useState("");
  const [publicClient, setPublicClient] = useState(false);

  if (isLoading) return <LoadingState />;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    upsert.mutate(
      {
        packageId,
        authKey,
        clientId,
        clientSecret: publicClient ? "" : clientSecret,
        ...(redirectUri ? { redirectUri } : {}),
      },
      {
        onSuccess: () => {
          setClientSecret("");
        },
      },
    );
  };

  const onDelete = () => {
    if (window.confirm(t("integration.oauthClient.delete.confirm"))) {
      del.mutate({ packageId, authKey });
    }
  };

  return (
    <div className="bg-muted/40 rounded-md border p-4">
      <div className="mb-3 flex items-center gap-2">
        <Settings2 size={14} className="text-muted-foreground" />
        <h4 className="text-sm font-semibold">{t("integration.section.oauthClient")}</h4>
      </div>
      {client && (
        <p className="text-muted-foreground mb-3 text-xs">
          {t("integration.oauthClient.registered", { clientId: client.clientId })}
        </p>
      )}
      <form className="grid gap-3 sm:grid-cols-2" onSubmit={submit}>
        <div className="space-y-1">
          <Label htmlFor={`cid-${authKey}`} className="text-xs">
            {t("integration.oauthClient.clientId")}
          </Label>
          <Input
            id={`cid-${authKey}`}
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder={client?.clientId ?? ""}
            data-testid={`oauth-clientid-${authKey}`}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`csecret-${authKey}`} className="text-xs">
            {t("integration.oauthClient.clientSecret")}
          </Label>
          <Input
            id={`csecret-${authKey}`}
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            disabled={publicClient}
            placeholder={client?.hasClientSecret ? "••••••••" : ""}
            data-testid={`oauth-clientsecret-${authKey}`}
          />
        </div>
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor={`redir-${authKey}`} className="text-xs">
            {t("integration.oauthClient.redirectUri")}
          </Label>
          <Input
            id={`redir-${authKey}`}
            type="url"
            value={redirectUri}
            onChange={(e) => setRedirectUri(e.target.value)}
            placeholder={client?.redirectUri ?? ""}
          />
        </div>
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <Checkbox checked={publicClient} onCheckedChange={(c) => setPublicClient(Boolean(c))} />
          {t("integration.oauthClient.publicClient")}
        </label>
        <div className="flex items-center gap-2 sm:col-span-2">
          <Button
            type="submit"
            size="sm"
            disabled={upsert.isPending || clientId.trim() === ""}
            data-testid={`oauth-client-save-${authKey}`}
          >
            {client
              ? t("integration.oauthClient.btnRotate")
              : t("integration.oauthClient.btnRegister")}
          </Button>
          {client && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onDelete}
              disabled={del.isPending}
            >
              <Trash2 size={14} className="text-destructive" />
              {t("integration.oauthClient.btnDelete")}
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}

// ─────────────────────────────────────────────
// Auth section (per declared auth in manifest)
// ─────────────────────────────────────────────

/**
 * Read-only diff between agent-required scopes and actor-granted scopes.
 *
 * The reconnect CTA was removed when connect/upgrade moved to agent
 * surfaces (architectural decision: connections are agent-driven; this
 * page is admin-leaning, for install + OAuth client registration). The
 * panel still surfaces the diff as audit info so admins can see at a
 * glance which permissions installed agents are asking for that no
 * actor has granted yet.
 */
function RequiredScopesPanel({
  packageId,
  authKey,
  hasConnection,
}: {
  packageId: string;
  authKey: string;
  hasConnection: boolean;
}) {
  const { t } = useTranslation("settings");
  const { data } = useIntegrationRequiredScopes(packageId, authKey);
  if (!data) return null;
  if (!hasConnection) return null;
  if (data.missingFromGranted.length === 0) return null;
  return (
    <div
      className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-amber-700 dark:text-amber-300"
      data-testid={`required-scopes-warning-${authKey}`}
    >
      <div className="mb-2 flex items-center gap-2">
        <AlertTriangle size={14} />
        <span className="text-sm font-semibold">{t("integration.scopes.missing")}</span>
      </div>
      <p className="text-foreground/90 mb-2 text-xs">
        {t("integration.scopes.missing.description")}
      </p>
      <ul
        className="list-inside list-disc font-mono text-xs"
        data-testid={`required-scopes-missing-${authKey}`}
      >
        {data.missingFromGranted.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Per-auth read-only block. The connect/disconnect surfaces moved to
 * the agent flow (AgentIntegrationsBlock + MissingConnectionsModal) —
 * see the section banner. This block keeps:
 *   - Auth metadata: type, required flag, default scopes, audience,
 *     authorized URIs.
 *   - Admin-only OAuth client registration form (oauth2).
 *   - Read-only connection list with scope + expiry info (no disconnect).
 *   - RequiredScopesPanel — passive diff display (no reconnect CTA).
 */
function AuthSection({
  packageId,
  status,
  authDecl,
  isAdmin,
}: {
  packageId: string;
  status: IntegrationAuthStatus;
  authDecl: IntegrationManifestAuth;
  isAdmin: boolean;
}) {
  const { t } = useTranslation("settings");
  const isOAuth = status.type === "oauth2";

  return (
    <div className="bg-card rounded-lg border p-4" data-testid={`auth-section-${status.authKey}`}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <ShieldCheck size={16} className="text-muted-foreground" />
        <span className="font-mono text-sm font-semibold">{status.authKey}</span>
        <Badge variant="outline">{status.type}</Badge>
        {status.required ? (
          <Badge variant="default">{t("integration.auth.required")}</Badge>
        ) : (
          <Badge variant="secondary">{t("integration.auth.optional")}</Badge>
        )}
      </div>

      {/* Scopes / audience */}
      {(status.scopes.length > 0 || status.audience) && (
        <div className="text-muted-foreground mb-3 grid gap-1 text-xs">
          {status.scopes.length > 0 && (
            <p>
              <span className="font-semibold">{t("integration.auth.scopes")}:</span>{" "}
              <span className="font-mono">{status.scopes.join(", ")}</span>
            </p>
          )}
          {status.audience && (
            <p>
              <span className="font-semibold">{t("integration.auth.audience")}:</span>{" "}
              <span className="font-mono">{status.audience}</span>
            </p>
          )}
          {authDecl.authorizedUris.length > 0 && (
            <p className="truncate">
              <span className="font-semibold">{t("integration.auth.authorizedUris")}:</span>{" "}
              <span className="font-mono text-[0.7rem]">
                {authDecl.authorizedUris.slice(0, 3).join(", ")}
                {authDecl.authorizedUris.length > 3 && ` (+${authDecl.authorizedUris.length - 3})`}
              </span>
            </p>
          )}
        </div>
      )}

      {/* OAuth client section (admin only, oauth2 only) */}
      {isOAuth && isAdmin && (
        <div className="mb-3">
          <OAuthClientForm packageId={packageId} authKey={status.authKey} />
          {!status.hasOAuthClient && (
            <p className="text-muted-foreground mt-2 text-xs">
              {t("integration.auth.noOauthClient")}
            </p>
          )}
        </div>
      )}

      {isOAuth && (
        <RequiredScopesPanel
          packageId={packageId}
          authKey={status.authKey}
          hasConnection={status.connections.length > 0}
        />
      )}

      {/* Connections — read-only audit list. Connect/disconnect live on
          the agent surfaces. */}
      {status.connections.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("integration.auth.noConnection")}</p>
      ) : (
        <div className="space-y-2">
          {status.connections.map((c) => (
            <ConnectionRow key={c.id} connection={c} packageId={packageId} />
          ))}
        </div>
      )}
    </div>
  );
}

function BlockUserConnectionsToggle({
  packageId,
  initialBlocked,
}: {
  packageId: string;
  initialBlocked: boolean;
}) {
  const { t } = useTranslation("settings");
  const updateSettings = useUpdateIntegrationSettings();
  // Drives the checkbox from server state — pending mutation reads the
  // about-to-be-applied value, idle reads the latest fetched value.
  const blocked =
    updateSettings.isPending && updateSettings.variables?.packageId === packageId
      ? updateSettings.variables.blockUserConnections
      : initialBlocked;
  return (
    <div
      className="border-border bg-muted/30 mb-6 rounded-md border p-4"
      data-testid="block-user-connections-section"
    >
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={blocked}
          disabled={updateSettings.isPending}
          onChange={(e) =>
            updateSettings.mutate({ packageId, blockUserConnections: e.target.checked })
          }
          data-testid="block-user-connections-toggle"
          className="mt-0.5"
        />
        <div className="flex-1">
          <label className="text-sm font-semibold">
            {t("integration.admin.blockUserConnections.label")}
          </label>
          <p className="text-muted-foreground mt-1 text-xs">
            {t("integration.admin.blockUserConnections.help")}
          </p>
        </div>
      </div>
    </div>
  );
}

function ConnectionRow({
  connection,
  packageId,
}: {
  connection: IntegrationConnection;
  packageId: string;
}) {
  const { t } = useTranslation("settings");
  const updateConnection = useUpdateIntegrationConnection();
  const [editing, setEditing] = useState(false);
  const [draftLabel, setDraftLabel] = useState(connection.label ?? "");
  const accountLabel =
    (connection.identityClaims?.accountEmail as string | undefined) ??
    (connection.identityClaims?.account_email as string | undefined) ??
    connection.accountId;
  const isShared = connection.sharedWithOrg === true;
  const startEdit = () => {
    setDraftLabel(connection.label ?? "");
    setEditing(true);
  };
  const cancelEdit = () => {
    setEditing(false);
    setDraftLabel(connection.label ?? "");
  };
  const submitLabel = () => {
    const next = draftLabel.trim();
    if (next === (connection.label ?? "")) {
      setEditing(false);
      return;
    }
    updateConnection.mutate(
      {
        packageId,
        connectionId: connection.id,
        label: next === "" ? null : next,
      },
      { onSuccess: () => setEditing(false) },
    );
  };
  return (
    <div
      className="bg-muted/30 flex flex-col gap-2 rounded-md border px-3 py-2 text-sm"
      data-testid={`connection-row-${connection.id}`}
    >
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {editing ? (
              <>
                <Input
                  value={draftLabel}
                  onChange={(e) => setDraftLabel(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submitLabel();
                    if (e.key === "Escape") cancelEdit();
                  }}
                  placeholder={t("integration.connection.labelPlaceholder")}
                  className="h-7 max-w-xs text-sm"
                  autoFocus
                  data-testid={`label-input-${connection.id}`}
                />
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  onClick={submitLabel}
                  disabled={updateConnection.isPending}
                  title={t("integration.connection.labelSave")}
                  data-testid={`label-save-${connection.id}`}
                >
                  <Check className="size-3.5" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  onClick={cancelEdit}
                  disabled={updateConnection.isPending}
                  title={t("integration.connection.labelCancel")}
                >
                  <X className="size-3.5" />
                </Button>
              </>
            ) : (
              <>
                {connection.label && (
                  <span className="truncate font-medium">{connection.label}</span>
                )}
                <span
                  className={
                    connection.label
                      ? "text-muted-foreground truncate text-xs"
                      : "truncate font-medium"
                  }
                >
                  {accountLabel}
                </span>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-6"
                  onClick={startEdit}
                  title={t("integration.connection.labelEdit")}
                  data-testid={`label-edit-${connection.id}`}
                >
                  <Pencil className="size-3" />
                </Button>
              </>
            )}
            {isShared && (
              <Badge variant="secondary" data-testid={`shared-badge-${connection.id}`}>
                {t("integration.connection.sharedBadge")}
              </Badge>
            )}
            {connection.needsReconnection && (
              <Badge variant="destructive">{t("integration.auth.needsReconnection")}</Badge>
            )}
          </div>
          {connection.scopesGranted.length > 0 && (
            <p className="text-muted-foreground truncate font-mono text-[0.65rem]">
              {connection.scopesGranted.join(" ")}
            </p>
          )}
          {connection.expiresAt && (
            <p className="text-muted-foreground text-[0.65rem]">
              {t("integration.auth.expiresAt", {
                date: new Date(connection.expiresAt).toLocaleDateString(),
              })}
            </p>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 pt-1">
        <label className="flex items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            checked={isShared}
            disabled={updateConnection.isPending}
            onChange={(e) =>
              updateConnection.mutate({
                packageId,
                connectionId: connection.id,
                sharedWithOrg: e.target.checked,
              })
            }
            data-testid={`share-toggle-${connection.id}`}
          />
          {t("integration.connection.shareWithOrg.label")}
        </label>
        <span className="text-muted-foreground text-[0.65rem]">
          {t("integration.connection.shareWithOrg.help")}
        </span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// About + metadata blocks
// ─────────────────────────────────────────────

function MetadataBlock({ manifest }: { manifest: IntegrationManifestView }) {
  const { t } = useTranslation("settings");
  const author =
    typeof manifest.author === "string" ? manifest.author : (manifest.author?.name ?? "");
  const repo =
    typeof manifest.repository === "string"
      ? manifest.repository
      : (manifest.repository?.url ?? "");
  const rows: Array<[string, React.ReactNode]> = [
    [t("integration.field.version"), <span className="font-mono">{manifest.version}</span>],
    [t("integration.field.author"), author || "—"],
    [t("integration.field.license"), manifest.license ?? "—"],
    [
      t("integration.field.repository"),
      repo ? (
        <a href={repo} target="_blank" rel="noopener noreferrer" className="text-primary underline">
          {repo}
        </a>
      ) : (
        "—"
      ),
    ],
    [t("integration.field.serverType"), <span className="font-mono">{manifest.server.type}</span>],
    [
      t("integration.field.transport"),
      <span className="font-mono">{manifest.transport?.type ?? "stdio"}</span>,
    ],
    [t("integration.field.toolsDynamic"), manifest.server.toolsDynamic ? "✓" : "—"],
    [
      t("integration.field.compatibility"),
      manifest.compatibility ? (
        <span className="font-mono">
          afps:{manifest.compatibility.afps ?? "—"} mcp:{manifest.compatibility.mcp ?? "—"}
        </span>
      ) : (
        "—"
      ),
    ],
  ];
  return (
    <dl className="grid grid-cols-1 gap-y-2 text-sm sm:grid-cols-[max-content_1fr] sm:gap-x-4">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

// ─────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────

export function IntegrationDetailPage() {
  const { t } = useTranslation("settings");
  const { scope, name } = useParams<{ scope: string; name: string }>();
  const navigate = useNavigate();
  const packageId = scope && name ? `${scope}/${name}` : "";
  const { data: detail, isLoading, error } = useIntegrationDetail(packageId || undefined);
  const { data: integrations } = useIntegrations();
  const install = useInstallIntegration();
  const uninstall = useUninstallIntegration();
  const { isAdmin } = usePermissions();

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={String(error)} />;
  if (!detail) return <ErrorState message="Integration not found" />;

  const summary = integrations?.find((i) => i.id === packageId);
  const installed = Boolean(summary?.installed);
  const m = detail.manifest;

  return (
    <div className="p-6">
      <PageHeader
        emoji="🧩"
        title={m.displayName}
        breadcrumbs={[
          { label: t("integrations.title"), href: "/integrations" },
          { label: m.displayName },
        ]}
        actions={
          <>
            {installed ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  if (window.confirm(t("integrations.uninstall.confirm"))) {
                    uninstall.mutate(packageId);
                  }
                }}
                disabled={uninstall.isPending}
              >
                {t("integrations.btn.uninstall")}
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={() => install.mutate(packageId)}
                disabled={install.isPending}
                data-testid="detail-install-btn"
              >
                {t("integrations.btn.install")}
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => navigate("/integrations")}>
              ← {t("integrations.title")}
            </Button>
          </>
        }
      >
        <p className="text-muted-foreground mt-1 font-mono text-xs">{packageId}</p>
        {m.description && <p className="mt-3 text-sm">{m.description}</p>}
      </PageHeader>

      {installed && isAdmin && (
        <BlockUserConnectionsToggle
          packageId={packageId}
          initialBlocked={summary?.blockUserConnections ?? false}
        />
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Auths column (2/3) */}
        <div className="space-y-4 lg:col-span-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <Boxes size={16} />
            {t("integration.section.auths")}
          </h3>
          {detail.auths.length > 1 && (
            <div
              className="border-border bg-muted/40 rounded-md border p-3 text-xs"
              data-testid="multi-auth-banner"
            >
              <p className="mb-1 font-semibold">{t("integration.multiAuth.title")}</p>
              <p className="text-muted-foreground">{t("integration.multiAuth.description")}</p>
            </div>
          )}
          {detail.auths.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {/* Integration declares no auths — nothing to connect. */}—
            </p>
          ) : (
            detail.auths.map((authStatus) => {
              const declared = (m.auths ?? {})[authStatus.authKey];
              if (!declared) return null;
              return (
                <AuthSection
                  key={authStatus.authKey}
                  packageId={packageId}
                  status={authStatus}
                  authDecl={declared}
                  isAdmin={isAdmin}
                />
              );
            })
          )}
        </div>

        {/* Metadata column (1/3) */}
        <aside className="space-y-4">
          <h3 className="text-sm font-semibold">{t("integration.section.metadata")}</h3>
          <MetadataBlock manifest={m} />
          {m.privacyPolicy && (
            <p className="text-xs">
              <span className="text-muted-foreground">{t("integration.field.privacyPolicy")}:</span>{" "}
              <a
                href={m.privacyPolicy}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary break-all underline"
              >
                {m.privacyPolicy}
              </a>
            </p>
          )}
          {m.keywords && m.keywords.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {m.keywords.map((k) => (
                <Badge key={k} variant="outline" className="text-[0.65rem]">
                  {k}
                </Badge>
              ))}
            </div>
          )}
          <p className="text-xs">
            <Link to="/integrations" className="text-primary underline">
              ← {t("integrations.title")}
            </Link>
          </p>
        </aside>
      </div>
    </div>
  );
}
