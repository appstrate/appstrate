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

import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams, Link } from "react-router-dom";
import { Boxes, Plus, Trash2, ShieldCheck, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Modal } from "../components/modal";
import { PageHeader } from "../components/page-header";
import { LoadingState, ErrorState } from "../components/page-states";
import { usePermissions } from "../hooks/use-permissions";
import {
  useIntegrationDetail,
  useInstallIntegration,
  useUninstallIntegration,
  useConnectIntegrationFields,
  useInitiateIntegrationOAuth,
  useDisconnectIntegration,
  useIntegrationOAuthClient,
  useUpsertIntegrationOAuthClient,
  useDeleteIntegrationOAuthClient,
  type IntegrationAuthStatus,
  type IntegrationConnection,
  type IntegrationManifestView,
  type IntegrationManifestAuth,
} from "../hooks/use-integrations";
import { useIntegrations } from "../hooks/use-integrations";

const OAUTH_POPUP_TIMEOUT_MS = 5 * 60_000;

// ─────────────────────────────────────────────
// Fields-connect modal (api_key / basic / custom)
// ─────────────────────────────────────────────

function deriveFieldNames(auth: IntegrationManifestAuth): string[] {
  const schema = auth.credentials?.schema as { properties?: Record<string, unknown> } | undefined;
  if (schema?.properties && typeof schema.properties === "object") {
    return Object.keys(schema.properties);
  }
  // Sensible defaults by auth type so the form still renders for malformed manifests.
  if (auth.type === "api_key") return ["api_key"];
  if (auth.type === "basic") return ["username", "password"];
  return [];
}

function FieldsConnectModal({
  open,
  onClose,
  packageId,
  authKey,
  auth,
  displayName,
}: {
  open: boolean;
  onClose: () => void;
  packageId: string;
  authKey: string;
  auth: IntegrationManifestAuth;
  displayName: string;
}) {
  const { t } = useTranslation("settings");
  const [values, setValues] = useState<Record<string, string>>({});
  const mutation = useConnectIntegrationFields();
  const fields = deriveFieldNames(auth);
  const sensitiveKeywords = ["password", "secret", "token", "key"];

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    mutation.mutate(
      { packageId, authKey, credentials: values },
      {
        onSuccess: () => {
          setValues({});
          onClose();
        },
      },
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("integration.connect.modal.title", { display: displayName })}
    >
      <form className="space-y-4" onSubmit={submit}>
        <p className="text-muted-foreground text-sm">
          {t("integration.connect.modal.subtitle", { type: auth.type })}
        </p>
        {fields.map((field) => {
          const isSensitive = sensitiveKeywords.some((k) => field.toLowerCase().includes(k));
          return (
            <div key={field} className="space-y-1">
              <Label htmlFor={`field-${field}`} className="font-mono text-xs">
                {field}
              </Label>
              <Input
                id={`field-${field}`}
                type={isSensitive ? "password" : "text"}
                value={values[field] ?? ""}
                onChange={(e) => setValues((prev) => ({ ...prev, [field]: e.target.value }))}
                autoComplete="off"
                data-testid={`field-input-${field}`}
              />
            </div>
          );
        })}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("integration.connect.btn.cancel")}
          </Button>
          <Button type="submit" disabled={mutation.isPending}>
            {t("integration.connect.btn.save")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

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

function AuthSection({
  packageId,
  displayName,
  status,
  authDecl,
  isAdmin,
}: {
  packageId: string;
  displayName: string;
  status: IntegrationAuthStatus;
  authDecl: IntegrationManifestAuth;
  isAdmin: boolean;
}) {
  const { t } = useTranslation("settings");
  const [fieldsModalOpen, setFieldsModalOpen] = useState(false);
  const initiateOAuth = useInitiateIntegrationOAuth();
  const disconnect = useDisconnectIntegration();

  const isOAuth = status.type === "oauth2";
  const canConnect = !isOAuth || status.hasOAuthClient;

  const onOAuthConnect = useCallback(async () => {
    const popup = window.open("", "integration-oauth", "width=600,height=700");
    if (!popup) {
      window.alert(t("integration.popup.blocked"));
      return;
    }
    try {
      const session = await initiateOAuth.mutateAsync({
        packageId,
        authKey: status.authKey,
      });
      popup.location.href = session.authUrl;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          clearInterval(poll);
          try {
            popup.close();
          } catch {
            /* ignore */
          }
          reject(new Error("OAuth timeout"));
        }, OAUTH_POPUP_TIMEOUT_MS);
        const poll = setInterval(() => {
          if (popup.closed) {
            clearInterval(poll);
            clearTimeout(timer);
            resolve();
          }
        }, 500);
      });
    } catch (err) {
      try {
        popup.close();
      } catch {
        /* ignore */
      }
      throw err;
    }
  }, [initiateOAuth, packageId, status.authKey, t]);

  const connectButton = isOAuth ? (
    <Button
      size="sm"
      disabled={!canConnect || initiateOAuth.isPending}
      onClick={onOAuthConnect}
      data-testid={`auth-connect-${status.authKey}`}
    >
      <Plus size={14} />
      {status.connections.length === 0
        ? t("integration.auth.connectWith", { type: status.type })
        : t("integration.auth.addAccount")}
    </Button>
  ) : (
    <Button
      size="sm"
      onClick={() => setFieldsModalOpen(true)}
      data-testid={`auth-connect-${status.authKey}`}
    >
      <Plus size={14} />
      {status.connections.length === 0
        ? t("integration.auth.connectWith", { type: status.type })
        : t("integration.auth.addAccount")}
    </Button>
  );

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
        <div className="flex-1" />
        {connectButton}
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

      {/* Connections */}
      {status.connections.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("integration.auth.noConnection")}</p>
      ) : (
        <div className="space-y-2">
          {status.connections.map((c) => (
            <ConnectionRow
              key={c.id}
              packageId={packageId}
              connection={c}
              onDisconnect={() => disconnect.mutate({ packageId, connectionId: c.id })}
            />
          ))}
        </div>
      )}

      {!isOAuth && (
        <FieldsConnectModal
          open={fieldsModalOpen}
          onClose={() => setFieldsModalOpen(false)}
          packageId={packageId}
          authKey={status.authKey}
          auth={authDecl}
          displayName={displayName}
        />
      )}
    </div>
  );
}

function ConnectionRow({
  packageId: _packageId,
  connection,
  onDisconnect,
}: {
  packageId: string;
  connection: IntegrationConnection;
  onDisconnect: () => void;
}) {
  const { t } = useTranslation("settings");
  const accountLabel =
    (connection.identityClaims?.accountEmail as string | undefined) ??
    (connection.identityClaims?.account_email as string | undefined) ??
    connection.accountId;
  return (
    <div
      className="bg-muted/30 flex items-center gap-3 rounded-md border px-3 py-2 text-sm"
      data-testid={`connection-row-${connection.id}`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium">{accountLabel}</span>
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
      <Button
        variant="ghost"
        size="icon"
        onClick={onDisconnect}
        aria-label={t("integration.auth.disconnectAccount")}
      >
        <Trash2 size={14} className="text-destructive" />
      </Button>
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

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Auths column (2/3) */}
        <div className="space-y-4 lg:col-span-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <Boxes size={16} />
            {t("integration.section.auths")}
          </h3>
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
                  displayName={m.displayName}
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
