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
 *     URIs), the OAuth clients table (system + custom) and the BYO-app
 *     registration form, the org-wide access rules (block member connections,
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
import { CopyBlock } from "../components/copy-block";
import { ManifestOverview } from "../components/package-manifest/manifest-overview";
import { FileExplorer } from "../components/package-files/file-explorer";
import { CallbackUrlHint } from "../components/package-detail/callback-url-hint";

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
import { useParams } from "react-router-dom";
import { toast } from "sonner";
import { Trash2, ShieldCheck, Plus, Pencil, Check, X, ChevronRight } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Badge } from "@appstrate/ui/components/badge";
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";
import { Checkbox } from "@appstrate/ui/components/checkbox";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@appstrate/ui/components/tabs";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@appstrate/ui/components/table";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@appstrate/ui/components/collapsible";
import { LoadingState, ErrorState } from "../components/page-states";
import { SharedHeader } from "../components/package-detail/shared-header";
import { PackageActionsDropdown } from "../components/package-detail/package-actions-dropdown";
import { SetupGuideSteps } from "../components/package-detail/setup-guide-steps";
import { VersionHistory } from "../components/version-history";
import { ForkPackageModal } from "../components/fork-package-modal";
import { ConfirmModal } from "../components/confirm-modal";
import { Modal } from "../components/modal";
import { SourceBadge } from "../components/source-badge";
import { DefaultCell } from "../components/default-cell";
import { usePermissions } from "../hooks/use-permissions";
import { usePackageDetail, useDeletePackage, usePackageDownload } from "../hooks/use-packages";
import {
  useIntegrationDetail,
  useActivateIntegration,
  useDeactivateIntegration,
  useIntegrationClients,
  useSetDefaultIntegrationClient,
  useCreateIntegrationOAuthClient,
  useRotateIntegrationOAuthClient,
  useDeleteIntegrationOAuthClient,
  useUpdateIntegrationConnection,
  useUpdateIntegrationSettings,
  useIntegrationPins,
  useIntegrationConnections,
  useAgentsConsumingIntegration,
  useUpsertIntegrationPin,
  useDeleteIntegrationPin,
  useIntegrationOrgDefault,
  useUpsertIntegrationOrgDefault,
  useDeleteIntegrationOrgDefault,
  type IntegrationAuthStatus,
  type IntegrationAuthType,
  type IntegrationClient,
  type IntegrationConnection,
  type IntegrationManifestAuth,
} from "../hooks/use-integrations";
import { useIntegrations } from "../hooks/use-integrations";
import { useDisconnectIntegrationConnection } from "../hooks/use-me-connections";
import { useCurrentOrgId } from "../hooks/use-org";
import { useAuth } from "../hooks/use-auth";
import { useCurrentSpaceId } from "../hooks/use-current-space";
import { InlineConnectButton } from "../components/integration-connect/inline-connect-button";
import {
  connectionDisplayLabel,
  isConnectionOwnedBy,
} from "../components/integration-connect/connection-label";
import { isOauthAuthConnectable } from "../components/integration-connect/connectable-auth-keys";
import { ConnectionStatusBadge } from "../components/integration-connect/connection-status-badge";

// ─────────────────────────────────────────────
// OAuth client (admin) — create / rotate modal
// ─────────────────────────────────────────────

/**
 * Register a new custom OAuth client (`mode: "create"`) or rotate an existing
 * one in place (`mode: "rotate"`, preloaded from its descriptor). The parent
 * mounts this only while open, keyed by mode+clientRef, so field state resets
 * cleanly between invocations. The client secret is write-only — never echoed
 * back, shown as a placeholder when one is already set.
 */
function OAuthClientModal({
  packageId,
  authKey,
  authDecl,
  mode,
  existing,
  platformRedirectUri,
  onClose,
}: {
  packageId: string;
  authKey: string;
  authDecl?: IntegrationManifestAuth;
  mode: "create" | "rotate";
  existing?: IntegrationClient;
  platformRedirectUri: string;
  onClose: () => void;
}) {
  const { t } = useTranslation("settings");
  const create = useCreateIntegrationOAuthClient();
  const rotate = useRotateIntegrationOAuthClient();
  const pending = mode === "create" ? create.isPending : rotate.isPending;
  const [clientId, setClientId] = useState(existing?.client_id ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [redirectUri, setRedirectUri] = useState(existing?.redirect_uri ?? "");
  // What connect will send for THIS client. Named once: the copy block and the
  // publisher hint below must agree, and they diverge the moment the same
  // expression is spelled out twice.
  const effectiveRedirectUri = redirectUri.trim() || platformRedirectUri;
  // The admin's own declaration, read back from the row — NOT re-derived from
  // the absence of a secret. The old `!has_client_secret` guess could not tell
  // "declared public" from "secret not entered yet", so reopening a client
  // saved without one came back checked with the secret field disabled, and a
  // secret typed after that was never sent.
  const [publicClient, setPublicClient] = useState(
    existing ? existing.token_endpoint_auth_method === "none" : false,
  );
  // Registration with no secret and no public declaration is refused by the
  // API (400). Catching it here keeps the refusal on the field it belongs to
  // rather than in a toast, and — more importantly — stops the form from
  // sending an inferred `""`, which used to register a PUBLIC client from an
  // admin who never declared one and then showed the box ticked on reopen.
  // Rotation is exempt: there an untouched secret field means PRESERVE.
  const secretMissing = mode === "create" && !publicClient && clientSecret === "";
  // "Reward early, punish late" (same rule as `useAppForm`'s `showError`): the
  // message appears once the admin has touched the field or tried to submit,
  // never on a form they have not filled in yet.
  const [secretTouched, setSecretTouched] = useState(false);
  const [attempted, setAttempted] = useState(false);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setAttempted(true);
    if (secretMissing) return;
    // Declared, not inferred: the server records `none` instead of guessing
    // from a blank secret. And on rotation an untouched secret field is OMITTED
    // rather than sent as `""` — sending it would clear the stored credential
    // and flip a confidential client public, for an edit that only meant to
    // change the redirect URI.
    const common = {
      client_id: clientId,
      ...(publicClient ? { token_endpoint_auth_method: "none" as const } : {}),
      ...(redirectUri ? { redirect_uri: redirectUri } : {}),
    };
    if (mode === "create") {
      // A public client declares itself with `token_endpoint_auth_method: none`
      // and sends NO secret; a confidential one sends the typed secret. Neither
      // branch ships a blank the server would have to interpret.
      const body = publicClient ? common : { ...common, client_secret: clientSecret };
      create.mutate({ params: { path: { packageId, authKey } }, body }, { onSuccess: onClose });
    } else {
      // Rotation OMITS an untouched secret field rather than sending `""`.
      const body = {
        ...common,
        ...(publicClient
          ? { client_secret: "" }
          : clientSecret
            ? { client_secret: clientSecret }
            : {}),
      };
      rotate.mutate(
        { params: { path: { packageId, clientId: existing!.client_ref } }, body },
        { onSuccess: onClose },
      );
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={
        mode === "create"
          ? t("integration.oauthClient.modalCreateTitle")
          : t("integration.oauthClient.modalRotateTitle")
      }
    >
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={submit}
        data-testid={`oauth-client-form-${authKey}`}
      >
        <div className="space-y-1">
          <Label htmlFor={`cid-${authKey}`} className="text-xs">
            {t("integration.oauthClient.clientId")}
          </Label>
          <Input
            id={`cid-${authKey}`}
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
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
            onBlur={() => setSecretTouched(true)}
            disabled={publicClient}
            placeholder={existing?.has_client_secret ? "••••••••" : ""}
            data-testid={`oauth-clientsecret-${authKey}`}
          />
          {secretMissing && (secretTouched || attempted) && (
            <p
              className="text-destructive text-sm"
              data-testid={`oauth-clientsecret-error-${authKey}`}
            >
              {t("integration.oauthClient.clientSecretRequired")}
            </p>
          )}
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
          />
          {/* The redirect_uri connect will send for THIS client: the override
              typed above when it is set, else the platform callback. Providers
              compare it byte-for-byte and reject a mismatch with an opaque
              error, so the admin is shown the exact string to register rather
              than left to reconstruct it from the browser's origin (which is
              NOT authoritative — `APP_URL` is). */}
          <div className="space-y-1">
            <p className="text-muted-foreground text-[0.7rem]">
              {t("integration.oauthClient.platformRedirectUri")}
            </p>
            <CopyBlock
              value={effectiveRedirectUri}
              dense
              testId={`platform-redirect-uri-modal-${authKey}`}
            />
          </div>
          {/* AFPS §7.10 — surface `auths.<key>.callback_url_hint`, with its
              `{{callback_url}}` placeholder resolved against the SAME value
              shown above. Read-only display; the editable override lives in
              the input. */}
          {authDecl?.callback_url_hint && (
            <CallbackUrlHint
              hint={authDecl.callback_url_hint}
              callbackUrl={effectiveRedirectUri}
              authKey={authKey}
            />
          )}
        </div>
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <Checkbox checked={publicClient} onCheckedChange={(c) => setPublicClient(Boolean(c))} />
          {t("integration.oauthClient.publicClient")}
        </label>
        <div className="flex items-center justify-end gap-2 sm:col-span-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={pending}>
            {t("integration.connect.btn.cancel")}
          </Button>
          <Button
            type="submit"
            size="sm"
            disabled={pending || clientId.trim() === ""}
            data-testid={`oauth-client-save-${authKey}`}
          >
            {mode === "create"
              ? t("integration.oauthClient.btnRegister")
              : t("integration.oauthClient.btnRotate")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ─────────────────────────────────────────────
// OAuth clients (system + custom) — CRUD hub
// ─────────────────────────────────────────────

/**
 * The admin hub for an auth's OAuth clients: every client that can mint a
 * connection — the platform's system client(s) (`SYSTEM_INTEGRATIONS`,
 * read-only) plus the org's N custom (BYO-app) clients — with which is the
 * default. Multi-client: an admin registers as many custom clients as needed,
 * rotates or deletes each by id, and picks the default (the model-provider
 * pattern). Auto-provisioned (remote MCP DCR/CIMD) auths keep ONE machine
 * client, shown read-only with a delete action that re-triggers registration;
 * a manual escape hatch (opt-in) covers the rare server needing a pre-registered
 * public client. Secrets are never returned by the endpoint.
 */
function ClientsTable({
  packageId,
  authKey,
  authDecl,
  autoProvisioned,
}: {
  packageId: string;
  authKey: string;
  authDecl?: IntegrationManifestAuth;
  autoProvisioned: boolean;
}) {
  const { t } = useTranslation("settings");
  const { data: clients } = useIntegrationClients(packageId, authKey);
  // Read from the same query key the page already holds, rather than threading
  // the value down through `ConfigAuthBlock`, which would carry a prop it never
  // reads. React Query dedupes, so this costs no request.
  const { data: detail } = useIntegrationDetail(packageId);
  const platformRedirectUri = detail?.platform_redirect_uri ?? "";
  const setDefault = useSetDefaultIntegrationClient();
  const del = useDeleteIntegrationOAuthClient();
  const [modal, setModal] = useState<
    { mode: "create" } | { mode: "rotate"; client: IntegrationClient } | null
  >(null);
  const [confirmDelete, setConfirmDelete] = useState<IntegrationClient | null>(null);
  // Auto-provisioned auths hide the manual register button by default — their
  // token endpoint only accepts a DCR/CIMD-acquired client, so a hand-entered
  // one usually points at the wrong server and disables auto-registration. Keep
  // an opt-in escape hatch for the rare server needing a pre-registered client.
  const [showManual, setShowManual] = useState(false);

  const rows = clients ?? [];
  // What connect will ACTUALLY send. A registered client may carry its own
  // `redirect_uri`, and `OAuth2Strategy.begin` prefers it over the platform
  // callback (`clientRedirectUri ?? redirectUri`) — so showing the platform
  // value unconditionally would hand the admin the wrong string to register in
  // exactly the setup this display exists to get right. New connections always
  // use the default client, so that client's override is the one that decides.
  const effectiveRedirectUri = rows.find((c) => c.is_default)?.redirect_uri || platformRedirectUri;
  // Choosing a default only matters when more than one client can mint connections.
  const canChooseDefault = rows.length > 1;
  const hasAutoClient = rows.some((c) => c.auto_provisioned);
  // Classic auths always allow registering more custom clients; auto-provisioned
  // auths only via the opt-in escape hatch (and only when none is registered yet).
  const canRegister = !autoProvisioned || (showManual && !hasAutoClient);

  return (
    <div className="mb-3" data-testid={`oauth-clients-list-${authKey}`}>
      {/* Registering this exact string on the provider's OAuth app is a
          prerequisite to the FIRST connect attempt, so it is shown before the
          clients table rather than only inside the registration modal — an
          admin setting the app up at the provider needs it before there is any
          client to register. */}
      <div className="mb-3 space-y-1">
        <p className="text-muted-foreground text-xs font-semibold">
          {t("integration.oauthClient.platformRedirectUri")}
        </p>
        <CopyBlock value={effectiveRedirectUri} testId={`platform-redirect-uri-${authKey}`} />
      </div>

      <div className="mb-2 flex items-center justify-between gap-2">
        <h4 className="text-muted-foreground text-xs font-semibold">
          {t("integration.clients.title")}
        </h4>
        {canRegister && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => setModal({ mode: "create" })}
            data-testid={`oauth-client-register-${authKey}`}
          >
            <Plus size={14} />
            {t("integration.clients.register")}
          </Button>
        )}
      </div>

      {autoProvisioned && !hasAutoClient && (
        <p
          className="text-muted-foreground mb-2 text-xs"
          data-testid={`oauth-client-auto-hint-${authKey}`}
        >
          {t("integration.oauthClient.autoProvisionedHint")}
        </p>
      )}

      {rows.length > 0 && (
        <div className="overflow-hidden rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">{t("integration.clients.col.source")}</TableHead>
                <TableHead className="text-xs">{t("integration.clients.col.clientId")}</TableHead>
                <TableHead className="text-xs">{t("integration.clients.col.default")}</TableHead>
                <TableHead className="w-px text-right text-xs">
                  {t("integration.clients.col.actions")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((client) => {
                const editable = client.source === "custom" && !client.auto_provisioned;
                const deletable = client.source === "custom";
                return (
                  <TableRow
                    key={client.client_ref}
                    data-testid={`oauth-client-row-${client.client_ref}`}
                  >
                    <TableCell>
                      <SourceBadge
                        source={client.source}
                        autoProvisioned={client.auto_provisioned}
                      />
                    </TableCell>
                    <TableCell className="font-mono text-xs">{client.client_id}</TableCell>
                    <TableCell>
                      <DefaultCell
                        isDefault={client.is_default}
                        defaultLabel={t("integration.clients.default")}
                        setLabel={t("integration.clients.setDefault.action")}
                        canSetDefault={canChooseDefault}
                        disabled={setDefault.isPending}
                        onSetDefault={() =>
                          setDefault.mutate({
                            params: { path: { packageId, authKey } },
                            body: { client_ref: client.client_ref },
                          })
                        }
                        testId={`set-default-client-${client.client_ref}`}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        {editable && (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-7 w-7 p-0"
                            onClick={() => setModal({ mode: "rotate", client })}
                            data-testid={`oauth-client-rotate-${client.client_ref}`}
                            aria-label={t("integration.oauthClient.btnRotate")}
                          >
                            <Pencil size={14} />
                          </Button>
                        )}
                        {deletable && (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-7 w-7 p-0"
                            onClick={() => setConfirmDelete(client)}
                            disabled={del.isPending}
                            data-testid={`oauth-client-delete-${client.client_ref}`}
                            aria-label={t("integration.oauthClient.btnDelete")}
                          >
                            <Trash2 size={14} className="text-destructive" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {autoProvisioned && !showManual && !hasAutoClient && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-2"
          onClick={() => setShowManual(true)}
          data-testid={`oauth-client-manual-toggle-${authKey}`}
        >
          {t("integration.oauthClient.registerManually")}
        </Button>
      )}

      {modal && (
        <OAuthClientModal
          key={modal.mode === "rotate" ? modal.client.client_ref : "create"}
          packageId={packageId}
          authKey={authKey}
          authDecl={authDecl}
          mode={modal.mode}
          existing={modal.mode === "rotate" ? modal.client : undefined}
          platformRedirectUri={platformRedirectUri}
          onClose={() => setModal(null)}
        />
      )}
      <ConfirmModal
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        title={t("btn.confirm", { ns: "common" })}
        description={t("integration.oauthClient.delete.confirm")}
        isPending={del.isPending}
        onConfirm={() => {
          if (!confirmDelete) return;
          del.mutate(
            { params: { path: { packageId, clientId: confirmDelete.client_ref } } },
            { onSuccess: () => setConfirmDelete(null) },
          );
        }}
      />
    </div>
  );
}

// ─────────────────────────────────────────────
// Auth header (shared chrome for both tabs)
// ─────────────────────────────────────────────

/** Auth identity row reused by the Connexions and Configuration blocks. */
function AuthHeader({ status }: { status: IntegrationAuthStatus }) {
  const { t } = useTranslation("settings");
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <ShieldCheck size={16} className="text-muted-foreground" />
      <span className="font-mono text-sm font-semibold">{status.auth_key}</span>
      <Badge variant="outline">{status.type}</Badge>
      {status.required ? (
        <Badge variant="default">{t("integration.auth.required")}</Badge>
      ) : (
        <Badge variant="secondary">{t("integration.auth.optional")}</Badge>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// Connexions tab — per-auth connect CTA + accounts table
// ─────────────────────────────────────────────

/**
 * Per-auth connect surface: the "+ Ajouter" CTA (admin) — which always connects
 * via the resolved default client (no per-connect picker) — and the table of
 * connected accounts with rename/share/reconnect/disconnect. Runtime view — the
 * OAuth client setup lives in the Configuration tab (see {@link ConfigAuthBlock}).
 *
 * Scope-aware connect/upgrade still also lives on the agent surfaces
 * (AgentIntegrationsBlock + MissingConnectionsModal) where the per-agent scope
 * context is known; the "+ Ajouter" here connects with default scopes.
 */
function ConnectAuthBlock({
  packageId,
  status,
  isAdmin,
}: {
  packageId: string;
  status: IntegrationAuthStatus;
  isAdmin: boolean;
}) {
  const { t } = useTranslation("settings");
  const { user } = useAuth();
  const isOAuth = status.type === "oauth2";
  // Connectable when a client is usable: org-registered, shared system client,
  // or auto-provisioned at connect time (remote MCP CIMD/DCR). Shared gate.
  const clientMissing = isOAuth && !isOauthAuthConnectable(status);
  // `status.connections` is the own ∪ org-shared union, but "force the IdP's
  // account chooser" is about the CALLER's own accounts — it exists so a second
  // connect can't silently re-pick the account already signed in on this
  // browser. Someone else's shared connection says nothing about that.
  const ownConnectionCount = status.connections.filter((c) =>
    isConnectionOwnedBy(c, user?.id),
  ).length;

  return (
    <div className="bg-card rounded-lg border p-4" data-testid={`auth-section-${status.auth_key}`}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <AuthHeader status={status} />
        {/* Connect CTA / locked state. A missing oauth2 client blocks connecting:
            admins are pointed at the Configuration tab, members get a hint. User-
            facing connect also lives on agent surfaces where the agent's scope
            context is known; here the "+ Ajouter" connects with default scopes. */}
        {clientMissing ? (
          <p
            className="text-muted-foreground text-xs"
            data-testid={`no-oauth-client-hint-${status.auth_key}`}
          >
            {isAdmin ? t("integration.auth.noClientHintAdmin") : t("integration.auth.noClientHint")}
          </p>
        ) : isAdmin ? (
          <InlineConnectButton
            packageId={packageId}
            authKey={status.auth_key}
            intent="connect"
            label={t("integration.auth.addAccount")}
            forceAccountSelect={ownConnectionCount > 0}
            lockToAuthKey
          />
        ) : null}
      </div>

      <ConnectionsTable
        packageId={packageId}
        authKey={status.auth_key}
        authType={status.type}
        connections={status.connections}
        // Renew via OAuth needs a usable client; when none is available the
        // connect CTA is already hidden, so gate the per-row renew button the
        // same way to avoid a guaranteed 403.
        canRenew={isOAuth && !clientMissing}
      />
    </div>
  );
}

// ─────────────────────────────────────────────
// Configuration tab — per-auth metadata + OAuth clients
// ─────────────────────────────────────────────

/**
 * Per-auth admin configuration: the declared auth metadata (scopes, resource,
 * authorized URIs) plus the OAuth clients table (system + custom) and the
 * registration form to add/rotate/delete the org's own (BYO-app) client.
 * Separated from the runtime connections view (see {@link ConnectAuthBlock}).
 */
function ConfigAuthBlock({
  packageId,
  status,
  authDecl,
}: {
  packageId: string;
  status: IntegrationAuthStatus;
  authDecl: IntegrationManifestAuth;
}) {
  const { t } = useTranslation("settings");
  const isOAuth = status.type === "oauth2";

  return (
    <div className="bg-card rounded-lg border p-4" data-testid={`auth-config-${status.auth_key}`}>
      <AuthHeader status={status} />

      {/* Scopes / resource (RFC 8707 — `resource` in AFPS §7.3) */}
      {(status.scopes.length > 0 ||
        status.resource ||
        (authDecl.authorized_uris?.length ?? 0) > 0) && (
        <div className="text-muted-foreground mb-3 grid gap-1 text-xs">
          {status.scopes.length > 0 && (
            <p>
              <span className="font-semibold">{t("integration.auth.scopes")}:</span>{" "}
              <span className="font-mono">{status.scopes.join(", ")}</span>
            </p>
          )}
          {status.resource && (
            <p>
              <span className="font-semibold">{t("integration.auth.resource")}:</span>{" "}
              <span className="font-mono">{status.resource}</span>
            </p>
          )}
          {(authDecl.authorized_uris?.length ?? 0) > 0 && (
            <p className="truncate">
              <span className="font-semibold">{t("integration.auth.authorizedUris")}:</span>{" "}
              <span className="font-mono text-[0.7rem]">
                {authDecl.authorized_uris!.slice(0, 3).join(", ")}
                {authDecl.authorized_uris!.length > 3 &&
                  ` (+${authDecl.authorized_uris!.length - 3})`}
              </span>
            </p>
          )}
        </div>
      )}

      {/* OAuth clients (system + custom) — list, register, rotate, delete, default. */}
      {isOAuth && (
        <ClientsTable
          packageId={packageId}
          authKey={status.auth_key}
          authDecl={authDecl}
          autoProvisioned={status.client_auto_provisioned}
        />
      )}
      {!isOAuth && (
        <p className="text-muted-foreground text-xs">{t("integration.config.noOAuthClient")}</p>
      )}
    </div>
  );
}

/**
 * Org-wide access policy for this integration — collapsed by default, admin
 * only. Cross-cutting (not tied to one authKey): who may create connections,
 * the org-wide default, and per-agent pin exceptions.
 */
function AccessRulesSection({
  packageId,
  blockUserConnections,
}: {
  packageId: string;
  blockUserConnections: boolean;
}) {
  const { t } = useTranslation("settings");
  const [open, setOpen] = useState(false);
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="border-border bg-muted/20 rounded-md border"
      data-testid="access-rules-section"
    >
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-4 py-3 text-left">
        <ChevronRight
          size={16}
          className={`text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
        />
        <span className="text-sm font-semibold">{t("integration.admin.accessRules.title")}</span>
        <span className="text-muted-foreground ml-2 text-xs">
          {t("integration.admin.accessRules.help")}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="px-4 pb-2">
        <BlockUserConnectionsToggle packageId={packageId} initialBlocked={blockUserConnections} />
        <OrgDefaultSection packageId={packageId} />
        <PinManagementSection packageId={packageId} />
      </CollapsibleContent>
    </Collapsible>
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
    updateSettings.isPending && updateSettings.variables?.params.path.packageId === packageId
      ? updateSettings.variables.body.block_user_connections
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
            updateSettings.mutate({
              params: { path: { packageId } },
              body: { block_user_connections: e.target.checked },
            })
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

/**
 * Org-wide default connection for this integration — the cross-agent
 * baseline every consuming agent uses unless a per-agent exception (pin)
 * overrides it. `enforce` locks members; otherwise it's a soft default a
 * member can still override with their own pick.
 */
/**
 * Option label for the two admin pickers (org default, pins). Those lists
 * are org-wide — since the connections endpoint returns shared connections
 * owned by other members, an admin choosing a cross-agent default is picking
 * between rows whose labels can collide ("Connexion 1" for two members), so
 * the owner is part of the identity here. The per-row table carries the same
 * information as a badge instead, where a suffix would fight the rename UI.
 */
function connectionOptionLabel(c: IntegrationConnection): string {
  const base = connectionDisplayLabel(c);
  return c.owner_name ? `${base} — ${c.owner_name}` : base;
}

function OrgDefaultSection({ packageId }: { packageId: string }) {
  const { t } = useTranslation("settings");
  const { data: orgDefault } = useIntegrationOrgDefault(packageId);
  const { data: connections } = useIntegrationConnections(packageId);
  const upsert = useUpsertIntegrationOrgDefault();
  const remove = useDeleteIntegrationOrgDefault();

  const shared = (connections ?? []).filter((c) => c.shared_with_org === true);
  const connectionDisplay = (id: string): string => {
    const c = (connections ?? []).find((x) => x.id === id);
    if (!c) return id;
    return connectionOptionLabel(c);
  };

  const [connectionId, setConnectionId] = useState("");
  const [enforce, setEnforce] = useState(false);

  // Seed the form from the persisted default once loaded.
  const seededFor = orgDefault?.connection_id ?? null;
  const [seeded, setSeeded] = useState<string | null>(null);
  if (seededFor !== seeded) {
    setSeeded(seededFor);
    setConnectionId(orgDefault?.connection_id ?? "");
    setEnforce(orgDefault?.enforce ?? false);
  }

  return (
    <div
      className="border-border bg-muted/30 mb-6 rounded-md border p-4"
      data-testid="org-default-section"
    >
      <div className="mb-3">
        <h3 className="text-sm font-semibold">{t("integration.admin.orgDefault.title")}</h3>
        <p className="text-muted-foreground mt-1 text-xs">
          {t("integration.admin.orgDefault.help")}
        </p>
      </div>

      {shared.length === 0 ? (
        <p className="text-muted-foreground text-xs italic">
          {t("integration.admin.orgDefault.noPinnableConnections")}
        </p>
      ) : (
        <div className="border-border bg-background flex flex-wrap items-end gap-3 rounded-md border p-3">
          <div className="min-w-[14rem] flex-1">
            <Label className="text-muted-foreground mb-1 block text-[0.65rem]">
              {t("integration.admin.orgDefault.connection")}
            </Label>
            <select
              className="border-border bg-background w-full rounded border px-2 py-1 text-xs"
              value={connectionId}
              onChange={(e) => setConnectionId(e.target.value)}
              data-testid="org-default-connection"
            >
              <option value="">{t("integration.admin.orgDefault.none")}</option>
              {shared.map((c) => (
                <option key={c.id} value={c.id}>
                  {connectionDisplay(c.id)}
                </option>
              ))}
            </select>
          </div>
          <label className="flex items-center gap-2 pb-1 text-xs">
            <Checkbox
              checked={enforce}
              onCheckedChange={(v) => setEnforce(v === true)}
              data-testid="org-default-enforce"
            />
            {t("integration.admin.orgDefault.enforce")}
          </label>
          <Button
            size="sm"
            onClick={() =>
              connectionId &&
              upsert.mutate({
                params: { path: { packageId } },
                body: { connection_id: connectionId, enforce },
              })
            }
            disabled={!connectionId || upsert.isPending}
            data-testid="org-default-save"
          >
            {t("integration.admin.orgDefault.save")}
          </Button>
          {orgDefault ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => remove.mutate({ params: { path: { packageId } } })}
              disabled={remove.isPending}
              data-testid="org-default-clear"
            >
              {t("integration.admin.orgDefault.clear")}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * Centralised pin management. One pin per (agent, integration) — admin
 * picks which shared connection a given agent uses. Flat model: no
 * authKey to disambiguate (the connection's own authKey is implicit).
 * With an org default in place, this surface is for per-agent EXCEPTIONS.
 */
function PinManagementSection({ packageId }: { packageId: string }) {
  const { t } = useTranslation("settings");
  const { data: pins } = useIntegrationPins(packageId);
  const { data: connections } = useIntegrationConnections(packageId);
  const { data: consumingAgents } = useAgentsConsumingIntegration(packageId);
  const upsertPin = useUpsertIntegrationPin();
  const deletePin = useDeleteIntegrationPin();

  const [newAgent, setNewAgent] = useState("");
  const [newConnectionId, setNewConnectionId] = useState("");

  const pinnableConnections = (connections ?? []).filter((c) => c.shared_with_org === true);

  // Lookup helpers for the table
  const agentDisplayName = (id: string): string =>
    consumingAgents?.find((a) => a.packageId === id)?.display_name ?? id;
  const connectionDisplay = (id: string): string => {
    const c = (connections ?? []).find((x) => x.id === id);
    if (!c) return id;
    return connectionOptionLabel(c);
  };

  const onSubmitNewPin = () => {
    if (!newAgent || !newConnectionId) return;
    upsertPin.mutate(
      {
        params: { path: { packageId, agentPackageId: newAgent } },
        body: { connection_id: newConnectionId },
      },
      {
        onSuccess: () => {
          setNewAgent("");
          setNewConnectionId("");
        },
      },
    );
  };

  // Only include agents not already pinned.
  const alreadyPinnedAgentIds = new Set(
    (pins ?? []).filter((p) => p.integration_package_id === packageId).map((p) => p.packageId),
  );
  const pinnableAgents = (consumingAgents ?? []).filter(
    (a) => !alreadyPinnedAgentIds.has(a.packageId),
  );

  return (
    <div
      className="border-border bg-muted/30 mb-6 rounded-md border p-4"
      data-testid="pin-management-section"
    >
      <div className="mb-3">
        <h3 className="text-sm font-semibold">{t("integration.admin.exceptions.title")}</h3>
        <p className="text-muted-foreground mt-1 text-xs">
          {t("integration.admin.exceptions.help")}
        </p>
      </div>

      {/* Existing pins */}
      {(pins ?? []).length > 0 ? (
        <div className="border-border bg-background mb-3 overflow-hidden rounded-md border">
          <Table className="text-xs">
            <TableHeader className="bg-muted/40">
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-auto px-3 py-2">
                  {t("integration.admin.pinManagement.colAgent")}
                </TableHead>
                <TableHead className="h-auto px-3 py-2">
                  {t("integration.admin.pinManagement.colAuth")}
                </TableHead>
                <TableHead className="h-auto px-3 py-2">
                  {t("integration.admin.pinManagement.colConnection")}
                </TableHead>
                <TableHead className="h-auto w-12 px-3 py-2" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(pins ?? []).map((p) => (
                <TableRow
                  key={`${p.packageId}-${p.auth_key}`}
                  data-testid={`pin-row-${p.packageId}-${p.auth_key}`}
                >
                  <TableCell className="px-3 py-2">{agentDisplayName(p.packageId)}</TableCell>
                  <TableCell className="px-3 py-2">
                    <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 font-mono text-[10px]">
                      {p.auth_key}
                    </span>
                  </TableCell>
                  <TableCell className="px-3 py-2">{connectionDisplay(p.connection_id)}</TableCell>
                  <TableCell className="px-3 py-2">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6"
                      disabled={deletePin.isPending}
                      onClick={() =>
                        deletePin.mutate({
                          params: { path: { packageId, agentPackageId: p.packageId } },
                        })
                      }
                      title={t("integration.admin.pinManagement.delete")}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <p className="text-muted-foreground mb-3 text-xs italic">
          {t("integration.admin.pinManagement.empty")}
        </p>
      )}

      {/* Add new pin */}
      {pinnableConnections.length === 0 ? (
        <p className="text-muted-foreground text-xs italic">
          {t("integration.admin.pinManagement.noPinnableConnections")}
        </p>
      ) : pinnableAgents.length === 0 ? (
        <p className="text-muted-foreground text-xs italic">
          {t("integration.admin.pinManagement.noConsumingAgents")}
        </p>
      ) : (
        <div className="border-border bg-background flex flex-wrap items-end gap-2 rounded-md border p-3">
          <div className="min-w-[12rem] flex-1">
            <Label className="text-muted-foreground mb-1 block text-[0.65rem]">
              {t("integration.admin.pinManagement.colAgent")}
            </Label>
            <select
              className="border-border bg-background w-full rounded border px-2 py-1 text-xs"
              value={newAgent}
              onChange={(e) => setNewAgent(e.target.value)}
              data-testid="pin-add-agent"
            >
              <option value="">—</option>
              {pinnableAgents.map((a) => (
                <option key={a.packageId} value={a.packageId}>
                  {a.display_name}
                </option>
              ))}
            </select>
          </div>
          <div className="min-w-[12rem] flex-1">
            <Label className="text-muted-foreground mb-1 block text-[0.65rem]">
              {t("integration.admin.pinManagement.colConnection")}
            </Label>
            <select
              className="border-border bg-background w-full rounded border px-2 py-1 text-xs"
              value={newConnectionId}
              onChange={(e) => setNewConnectionId(e.target.value)}
              data-testid="pin-add-connection"
            >
              <option value="">—</option>
              {pinnableConnections.map((c) => (
                <option key={c.id} value={c.id}>
                  {connectionDisplay(c.id)}
                </option>
              ))}
            </select>
          </div>
          <Button
            size="sm"
            onClick={onSubmitNewPin}
            disabled={!newAgent || !newConnectionId || upsertPin.isPending}
            data-testid="pin-add-submit"
          >
            {t("integration.admin.pinManagement.add")}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * Connected accounts for one auth, as a table. Empty → a muted line. Columns:
 * account (with inline rename), status (+ reconnect when stale), granted scopes,
 * org-share toggle, and a disconnect action. All mutations are unchanged from
 * the previous card layout — only the presentation moved to a table.
 */
function ConnectionsTable({
  packageId,
  authKey,
  authType,
  connections,
  canRenew,
}: {
  packageId: string;
  authKey: string;
  authType: IntegrationAuthType;
  connections: IntegrationConnection[];
  canRenew: boolean;
}) {
  const { t } = useTranslation("settings");
  if (connections.length === 0)
    return <p className="text-muted-foreground text-sm">{t("integration.auth.noConnection")}</p>;
  return (
    <div className="overflow-hidden rounded-md border" data-testid={`connections-table-${authKey}`}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="text-xs">{t("integration.connection.col.account")}</TableHead>
            <TableHead className="text-xs">{t("integration.connection.col.status")}</TableHead>
            <TableHead className="text-xs">{t("integration.connection.col.scopes")}</TableHead>
            <TableHead className="text-xs">{t("integration.connection.col.shared")}</TableHead>
            <TableHead className="w-px text-right text-xs">
              {t("integration.connection.col.actions")}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {connections.map((c) => (
            <ConnectionTableRow
              key={c.id}
              connection={c}
              packageId={packageId}
              authKey={authKey}
              authType={authType}
              canRenew={canRenew}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function ConnectionTableRow({
  connection,
  packageId,
  authKey,
  authType,
  canRenew,
}: {
  connection: IntegrationConnection;
  packageId: string;
  /** Auth key the connection is bound to — forwarded to the renew CTA. */
  authKey: string;
  /** Auth type from the manifest — gates the renew CTA to oauth2 only. */
  authType: IntegrationAuthType;
  /** False when no OAuth client is usable yet — admin must set one up first. */
  canRenew: boolean;
}) {
  const { t } = useTranslation("settings");
  const updateConnection = useUpdateIntegrationConnection();
  const disconnect = useDisconnectIntegrationConnection();
  const orgId = useCurrentOrgId();
  const spaceId = useCurrentSpaceId();
  const { user } = useAuth();
  const { isAdmin } = usePermissions();
  const [editing, setEditing] = useState(false);
  const [draftLabel, setDraftLabel] = useState(connection.label ?? "");
  const [confirmDelete, setConfirmDelete] = useState(false);
  // `label` is the single source of truth (set at creation to the identity or
  // "Connexion N"); render it verbatim.
  const name = connectionDisplayLabel(connection);
  const isShared = connection.shared_with_org === true;
  // The list now returns org-shared connections owned by OTHER members, so
  // every per-row control has to be gated on the same rule the API enforces —
  // otherwise the button renders and the request comes back 403:
  //   - delete  → `DELETE /api/me/connections/:id`, strictly owner-scoped
  //               (`routes/me.ts`), no admin escape hatch by design;
  //   - share   → owner-only, because sharing is the owner's consent
  //               (`routes/integrations.ts`, `shared_with_org` branch);
  //   - rename  → owner OR org admin (same route, label branch).
  const isOwn = isConnectionOwnedBy(connection, user?.id);
  const canRename = isOwn || isAdmin;
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
        params: { path: { packageId, connectionId: connection.id } },
        body: { label: next === "" ? null : next },
      },
      { onSuccess: () => setEditing(false) },
    );
  };
  const onDelete = () => {
    if (!orgId || !spaceId) return;
    setConfirmDelete(true);
  };
  return (
    <>
      <TableRow data-testid={`connection-row-${connection.id}`}>
        {/* Account — inline rename */}
        <TableCell>
          {editing ? (
            <div className="flex items-center gap-1">
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
            </div>
          ) : (
            <div className="flex items-center gap-1">
              <span className="truncate font-medium">{name}</span>
              {!isOwn && (
                <Badge
                  variant="secondary"
                  className="text-[0.6rem]"
                  data-testid={`connection-owner-${connection.id}`}
                >
                  {connection.owner_name
                    ? t("integration.connection.sharedByOwner", { owner: connection.owner_name })
                    : t("integration.connection.sharedByUnknown")}
                </Badge>
              )}
              {canRename && (
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
              )}
            </div>
          )}
        </TableCell>

        {/* Status — connected / needs reconnection (+ renew) + expiry */}
        <TableCell>
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              {connection.needs_reconnection ? (
                <>
                  <ConnectionStatusBadge tone="needsReconnection">
                    {t("integration.auth.needsReconnection")}
                  </ConnectionStatusBadge>
                  {/* Owner-only: the reconnect writes through
                      `persistCredentialBundle` kind `update-owned`, whose WHERE
                      carries the actor identity — a non-owner reconnect 404s.
                      Only the owner can re-authenticate their own credential,
                      so others see the state without a dead CTA. */}
                  {isOwn && canRenew && authType === "oauth2" && (
                    <InlineConnectButton
                      packageId={packageId}
                      authKey={authKey}
                      intent="reconnect"
                      // Threading the existing row id is what makes the OAuth
                      // callback UPDATE-in-place rather than INSERT a duplicate
                      // (integration-connections.ts:721 "explicit connectionId
                      // = update; no id = insert").
                      connectionId={connection.id}
                      lockToAuthKey
                      size="sm"
                    />
                  )}
                </>
              ) : (
                <ConnectionStatusBadge tone="connected">
                  {t("integration.connection.statusConnected")}
                </ConnectionStatusBadge>
              )}
            </div>
            {connection.expiresAt && (
              <p className="text-muted-foreground text-[0.65rem]">
                {t("integration.auth.expiresAt", {
                  date: new Date(connection.expiresAt).toLocaleDateString(),
                })}
              </p>
            )}
          </div>
        </TableCell>

        {/* Granted scopes */}
        <TableCell className="max-w-[16rem]">
          {connection.scopes_granted.length > 0 ? (
            <span
              className="text-muted-foreground block truncate font-mono text-[0.65rem]"
              title={connection.scopes_granted.join(" ")}
            >
              {connection.scopes_granted.join(" ")}
            </span>
          ) : (
            <span className="text-muted-foreground text-xs">—</span>
          )}
        </TableCell>

        {/* Org-share toggle — owner-only (sharing is the owner's consent) */}
        <TableCell>
          {isOwn ? (
            <label
              className="flex items-center gap-1.5 text-xs"
              title={t("integration.connection.shareWithOrg.help")}
            >
              <input
                type="checkbox"
                checked={isShared}
                disabled={updateConnection.isPending}
                onChange={(e) =>
                  updateConnection.mutate({
                    params: { path: { packageId, connectionId: connection.id } },
                    body: { shared_with_org: e.target.checked },
                  })
                }
                data-testid={`share-toggle-${connection.id}`}
              />
              {t("integration.connection.shareWithOrg.label")}
            </label>
          ) : (
            <span className="text-muted-foreground text-xs">
              {t("integration.connection.shareWithOrg.label")}
            </span>
          )}
        </TableCell>

        {/* Disconnect — owner-only: the endpoint is `/api/me/connections` */}
        <TableCell className="text-right">
          {isOwn ? (
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              onClick={onDelete}
              disabled={disconnect.isPending}
              title={t("integration.connection.delete")}
              data-testid={`connection-delete-${connection.id}`}
            >
              <Trash2 className="text-destructive size-3.5" />
            </Button>
          ) : (
            <span className="text-muted-foreground text-xs">—</span>
          )}
        </TableCell>
      </TableRow>
      <ConfirmModal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={t("btn.confirm", { ns: "common" })}
        description={t("integration.connection.deleteConfirm")}
        isPending={disconnect.isPending}
        onConfirm={() =>
          disconnect.mutate(
            { params: { path: { connectionId: connection.id } } },
            { onSuccess: () => setConfirmDelete(false) },
          )
        }
      />
    </>
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
function ActivationHint({ onActivate, pending }: { onActivate: () => void; pending: boolean }) {
  const { t } = useTranslation("settings");
  return (
    <div
      className="border-border bg-muted/30 rounded-md border p-6 text-center"
      data-testid="activation-hint"
    >
      <p className="text-muted-foreground mb-3 text-sm">{t("integrations.activate.hint")}</p>
      <Button size="sm" onClick={onActivate} disabled={pending} data-testid="detail-activate-btn">
        {t("integrations.btn.activate")}
      </Button>
    </div>
  );
}

export function IntegrationDetailPage() {
  const { t } = useTranslation(["settings", "common", "agents"]);
  const { scope, name } = useParams<{ scope: string; name: string }>();
  const packageId = scope && name ? `${scope}/${name}` : "";
  const { data: detail, isLoading, error } = useIntegrationDetail(packageId || undefined);
  const { data: pkg } = usePackageDetail("integration", packageId || undefined);
  const { data: integrations } = useIntegrations();
  const activate = useActivateIntegration();
  const deactivate = useDeactivateIntegration();
  const deletePkg = useDeletePackage("integration");
  const downloadPackage = usePackageDownload(scope, name);
  const { isAdmin } = usePermissions();
  // Hash-driven like the agent page, so the tab can be LINKED to. Needed
  // because "an administrator must register an OAuth client" is only useful if
  // it can point at the screen where that happens.
  const [tab, setTab] = useTabWithHash(INTEGRATION_TABS, "connections");
  const [forkOpen, setForkOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={String(error)} />;
  if (!detail) return <ErrorState message={t("packages.detailNotFound")} />;

  const summary = integrations?.find((i) => i.id === packageId);
  const active = Boolean(summary?.active);
  const m = detail.manifest;
  const source = pkg?.source ?? summary?.source ?? "local";
  const version = pkg?.version ?? m.version;
  const isBuiltIn = source === "system";
  // Org-owned packages are editable regardless of scope name; only system packages are read-only.
  const isOwned = !isBuiltIn;
  const onActivate = () => activate.mutate({ params: { path: { packageId } } });

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
            {!active && (
              <Button
                size="sm"
                onClick={onActivate}
                disabled={activate.isPending}
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
              downloadVersion={version}
              onDownload={downloadPackage}
              onFork={() => setForkOpen(true)}
              canDeactivate={active}
              onDeactivate={() => setConfirmDeactivate(true)}
              deactivatePending={deactivate.isPending}
              canDeletePackage={!!pkg && pkg.agents.length === 0}
              onDeletePackage={() => setConfirmDelete(true)}
            />
          </>
        }
      />

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
            {isAdmin && (
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
            <ActivationHint onActivate={onActivate} pending={activate.isPending} />
          ) : detail.auths.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t("integration.auth.none")}</p>
          ) : (
            detail.auths.map((authStatus) => (
              <ConnectAuthBlock
                key={authStatus.auth_key}
                packageId={packageId}
                status={authStatus}
                isAdmin={isAdmin}
              />
            ))
          )}
        </TabsContent>

        {/* ─── Configuration (admin: OAuth clients, auth metadata, access
            rules, publisher setup guide). Separated from the runtime
            Connexions view so client setup and connected accounts no longer
            share one crowded card. ─── */}
        {isAdmin && (
          <TabsContent value="configuration" className="mt-4 space-y-4">
            {!active ? (
              <ActivationHint onActivate={onActivate} pending={activate.isPending} />
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
                  blockUserConnections={summary?.block_user_connections ?? false}
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
            <VersionHistory packageId={packageId} type="integration" isOwned={isOwned} />
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
        isPending={deactivate.isPending}
        onConfirm={() =>
          deactivate.mutate(
            { params: { path: { packageId } } },
            { onSuccess: () => setConfirmDeactivate(false) },
          )
        }
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
            onError: (err) =>
              toast.error(err instanceof Error ? err.message : t("packages.deleteDependedOn")),
          })
        }
      />
    </div>
  );
}
