// SPDX-License-Identifier: Apache-2.0

/**
 * Integration detail page.
 *
 * Shares the unified package layout (SharedHeader + PackageActionsDropdown)
 * with agents and skills. The activate/deactivate toggle lives in the header
 * (left action); manifest view / download / fork / delete live in the actions
 * dropdown. Integrations are import-only — there is no in-app editor.
 *
 * Tabs:
 *   - Connexions — per-auth connect CTA (with the system/custom client picker
 *     when several clients coexist) and a table of connected accounts with
 *     rename / share / reconnect / disconnect. Runtime view, visible to members.
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
 *   - Versions — read-only release history (non-system packages only).
 *
 * OAuth connect drives a popup against `/api/integrations/.../connect/oauth2`,
 * polls for popup close, then refetches the detail to surface the new
 * connection row.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { toast } from "sonner";
import { Trash2, ShieldCheck, Settings2, Pencil, Check, X, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { LoadingState, ErrorState } from "../components/page-states";
import { SharedHeader } from "../components/package-detail/shared-header";
import { PackageActionsDropdown } from "../components/package-detail/package-actions-dropdown";
import { VersionHistory } from "../components/version-history";
import { ForkPackageModal } from "../components/fork-package-modal";
import { ConfirmModal } from "../components/confirm-modal";
import { usePermissions } from "../hooks/use-permissions";
import { usePackageDetail, useDeletePackage, usePackageDownload } from "../hooks/use-packages";
import {
  useIntegrationDetail,
  useActivateIntegration,
  useDeactivateIntegration,
  useIntegrationOAuthClient,
  useIntegrationClients,
  useSetDefaultIntegrationClient,
  useUpsertIntegrationOAuthClient,
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
  type IntegrationManifestView,
  type IntegrationManifestAuth,
} from "../hooks/use-integrations";
import { useIntegrations } from "../hooks/use-integrations";
import { useDisconnectIntegrationConnection } from "../hooks/use-me-connections";
import { useCurrentOrgId } from "../hooks/use-org";
import { useCurrentApplicationId } from "../hooks/use-current-application";
import { InlineConnectButton } from "../components/integration-connect/inline-connect-button";
import { connectionDisplayLabel } from "../components/integration-connect/connection-label";
import { isOauthAuthConnectable } from "../components/integration-connect/connectable-auth-keys";
import { ConnectionStatusBadge } from "../components/integration-connect/connection-status-badge";

// ─────────────────────────────────────────────
// OAuth client (admin) form
// ─────────────────────────────────────────────

function OAuthClientForm({
  packageId,
  authKey,
  authDecl,
  autoProvisioned = false,
}: {
  packageId: string;
  authKey: string;
  authDecl?: IntegrationManifestAuth;
  // Remote MCP auths register their client at connect time (CIMD/DCR), so a
  // pre-registered client is optional. Surface that instead of a "to configure"
  // warning, and keep the form collapsed by default.
  autoProvisioned?: boolean;
}) {
  const { t } = useTranslation("settings");
  const { data: client, isLoading } = useIntegrationOAuthClient(packageId, authKey);
  const upsert = useUpsertIntegrationOAuthClient();
  const del = useDeleteIntegrationOAuthClient();
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [redirectUri, setRedirectUri] = useState("");
  const [publicClient, setPublicClient] = useState(false);
  // Accordion: collapsed once a client is registered, open while it still
  // needs configuring. `null` = follow that default; a boolean = user toggled.
  const [open, setOpen] = useState<boolean | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Auto-provisioned (remote MCP) auths hide the manual client form by default.
  // Their token endpoint only accepts a DCR/CIMD-acquired public client, so a
  // hand-entered client_id almost always points at the wrong OAuth server and
  // silently disables auto-registration (the stored client makes the backend
  // skip DCR). Keep an opt-in escape hatch for the rare server that needs a
  // pre-registered public client.
  const [showManualForm, setShowManualForm] = useState(false);

  if (isLoading) return <LoadingState />;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    upsert.mutate(
      {
        params: { path: { packageId, authKey } },
        body: {
          client_id: clientId,
          client_secret: publicClient ? "" : clientSecret,
          ...(redirectUri ? { redirect_uri: redirectUri } : {}),
        },
      },
      {
        onSuccess: () => {
          setClientSecret("");
        },
      },
    );
  };

  const configured = !!client;
  // Default collapsed when configured OR when the client is auto-provisioned
  // (manual registration is optional in that case); open otherwise so an admin
  // who must register a client sees the form straight away.
  const isOpen = open === null ? !configured && !autoProvisioned : open;
  // For auto-provisioned auths the manual form is opt-in (advanced); for classic
  // confidential clients it is always shown — registering one is mandatory.
  const showManualClientForm = !autoProvisioned || showManualForm;

  return (
    <>
      <Collapsible
        open={isOpen}
        onOpenChange={setOpen}
        className="bg-muted/40 rounded-md border"
        data-testid={`oauth-client-${authKey}`}
      >
        <CollapsibleTrigger className="flex w-full items-center gap-2 p-4 text-left">
          <ChevronRight
            size={14}
            className={`text-muted-foreground transition-transform ${isOpen ? "rotate-90" : ""}`}
          />
          <Settings2 size={14} className="text-muted-foreground" />
          <h4 className="text-sm font-semibold">{t("integration.section.oauthClient")}</h4>
          <span
            className={
              configured
                ? "ml-auto rounded bg-emerald-500/10 px-1.5 py-0.5 text-[0.65rem] font-medium text-emerald-500"
                : autoProvisioned
                  ? "text-muted-foreground bg-muted ml-auto rounded px-1.5 py-0.5 text-[0.65rem] font-medium"
                  : "bg-warning/10 text-warning ml-auto rounded px-1.5 py-0.5 text-[0.65rem] font-medium"
            }
          >
            {configured
              ? t("integration.oauthClient.configured")
              : autoProvisioned
                ? t("integration.oauthClient.autoProvisioned")
                : t("integration.oauthClient.notConfigured")}
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent className="px-4 pb-4">
          {autoProvisioned && !client && (
            <p
              className="text-muted-foreground mb-3 text-xs"
              data-testid={`oauth-client-auto-hint-${authKey}`}
            >
              {t("integration.oauthClient.autoProvisionedHint")}
            </p>
          )}
          {autoProvisioned && client && (
            <div
              className="bg-warning/10 mb-3 space-y-2 rounded-md p-3"
              data-testid={`oauth-client-auto-warning-${authKey}`}
            >
              <p className="text-warning text-xs">
                {t("integration.oauthClient.autoProvisionedManualWarning")}
              </p>
              <p className="text-muted-foreground text-xs">
                {t("integration.oauthClient.registered", { clientId: client.client_id })}
              </p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setConfirmDelete(true)}
                disabled={del.isPending}
                data-testid={`oauth-client-auto-delete-${authKey}`}
              >
                <Trash2 size={14} className="text-destructive" />
                {t("integration.oauthClient.btnDelete")}
              </Button>
            </div>
          )}
          {!autoProvisioned && client && (
            <p className="text-muted-foreground mb-3 text-xs">
              {t("integration.oauthClient.registered", { clientId: client.client_id })}
            </p>
          )}
          {autoProvisioned && !showManualForm && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mb-2"
              onClick={() => setShowManualForm(true)}
              data-testid={`oauth-client-manual-toggle-${authKey}`}
            >
              {t("integration.oauthClient.registerManually")}
            </Button>
          )}
          {showManualClientForm && (
            <form className="grid gap-3 sm:grid-cols-2" onSubmit={submit}>
              <div className="space-y-1">
                <Label htmlFor={`cid-${authKey}`} className="text-xs">
                  {t("integration.oauthClient.clientId")}
                </Label>
                <Input
                  id={`cid-${authKey}`}
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  placeholder={client?.client_id ?? ""}
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
                  placeholder={client?.has_client_secret ? "••••••••" : ""}
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
                  placeholder={client?.redirect_uri ?? ""}
                />
                {/* AFPS §7.10 — surface `auths.<key>.callback_url_hint`.
                  Read-only display; the actual redirectUri value lives in
                  the input above. */}
                {authDecl?.callback_url_hint && (
                  <p
                    className="text-muted-foreground text-[0.7rem]"
                    data-testid={`callback-url-hint-${authKey}`}
                  >
                    <span className="font-semibold">
                      {t("integration.oauthClient.callbackUrlHint")}:
                    </span>{" "}
                    <span className="font-mono">{authDecl.callback_url_hint}</span>
                  </p>
                )}
              </div>
              <label className="flex items-center gap-2 text-sm sm:col-span-2">
                <Checkbox
                  checked={publicClient}
                  onCheckedChange={(c) => setPublicClient(Boolean(c))}
                />
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
                {client && !autoProvisioned && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setConfirmDelete(true)}
                    disabled={del.isPending}
                  >
                    <Trash2 size={14} className="text-destructive" />
                    {t("integration.oauthClient.btnDelete")}
                  </Button>
                )}
              </div>
            </form>
          )}
        </CollapsibleContent>
      </Collapsible>
      <ConfirmModal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={t("btn.confirm", { ns: "common" })}
        description={t("integration.oauthClient.delete.confirm")}
        isPending={del.isPending}
        onConfirm={() =>
          del.mutate(
            { params: { path: { packageId, authKey } } },
            { onSuccess: () => setConfirmDelete(false) },
          )
        }
      />
    </>
  );
}

// ─────────────────────────────────────────────
// Available OAuth clients (system + custom)
// ─────────────────────────────────────────────

/**
 * Read-only list of every OAuth client that can mint a connection for this
 * auth: the org's custom (BYO-app) client plus any platform-provided system
 * clients (`SYSTEM_INTEGRATION_CLIENTS`). Surfaces WHY connecting is possible
 * even when the org has not registered its own client — the platform ships a
 * shared one. The default (the one connect uses absent an explicit pick) is
 * badged. Secrets are never returned by the endpoint. Renders nothing when no
 * client exists (the registration form below carries the "configure" CTA).
 */
function ClientsTable({ packageId, authKey }: { packageId: string; authKey: string }) {
  const { t } = useTranslation("settings");
  const { data: clients } = useIntegrationClients(packageId, authKey);
  const setDefault = useSetDefaultIntegrationClient();
  if (!clients || clients.length === 0) return null;
  // Choosing a default only matters when more than one client can mint connections.
  const canChooseDefault = clients.length > 1;

  return (
    <div className="mb-3" data-testid={`oauth-clients-list-${authKey}`}>
      <h4 className="text-muted-foreground mb-2 text-xs font-semibold">
        {t("integration.clients.title")}
      </h4>
      <div className="overflow-hidden rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-xs">{t("integration.clients.col.source")}</TableHead>
              <TableHead className="text-xs">{t("integration.clients.col.clientId")}</TableHead>
              <TableHead className="w-px text-right text-xs">
                {t("integration.clients.col.default")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {clients.map((client) => (
              <TableRow
                key={client.client_ref}
                data-testid={`oauth-client-row-${client.client_ref}`}
              >
                <TableCell>
                  <Badge variant={client.source === "built-in" ? "secondary" : "outline"}>
                    {client.source === "built-in"
                      ? t("integration.clients.sourceBuiltIn")
                      : t("integration.clients.sourceCustom")}
                  </Badge>
                </TableCell>
                <TableCell className="font-mono text-xs">{client.client_id}</TableCell>
                <TableCell className="text-right">
                  {client.is_default ? (
                    <Badge variant="default">{t("integration.clients.default")}</Badge>
                  ) : canChooseDefault ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs"
                      disabled={setDefault.isPending}
                      onClick={() =>
                        setDefault.mutate({
                          params: { path: { packageId, authKey } },
                          body: { client_ref: client.client_ref },
                        })
                      }
                      data-testid={`set-default-client-${client.client_ref}`}
                    >
                      {t("integration.clients.setDefault.action")}
                    </Button>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
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
 * Per-auth connect surface: the "+ Ajouter" CTA (admin) with the system/custom
 * client picker when several clients coexist, and the table of connected
 * accounts with rename/share/reconnect/disconnect. Runtime view — the OAuth
 * client setup lives in the Configuration tab (see {@link ConfigAuthBlock}).
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
  const isOAuth = status.type === "oauth2";
  // Connectable when a client is usable: org-registered, shared system client,
  // or auto-provisioned at connect time (remote MCP CIMD/DCR). Shared gate.
  const clientMissing = isOAuth && !isOauthAuthConnectable(status);

  // Available clients (system + custom) — only fetched for oauth2 auths. When
  // both a system and a custom client exist the admin picks which one mints the
  // connection; with a single client the backend default is unambiguous (no
  // picker, no explicit client_ref). Shares the query with ClientsTable.
  const { data: clients } = useIntegrationClients(
    isOAuth ? packageId : undefined,
    isOAuth ? status.auth_key : undefined,
  );
  const showClientPicker = isOAuth && isAdmin && (clients?.length ?? 0) > 1;
  const defaultClientRef = clients?.find((c) => c.is_default)?.client_ref;
  const [selectedClientRef, setSelectedClientRef] = useState<string | undefined>(undefined);
  // Effective pick: the admin's choice, else the default. Only sent when a
  // picker is shown — a single-client auth connects via backend precedence.
  const connectClientRef = showClientPicker ? (selectedClientRef ?? defaultClientRef) : undefined;

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
          <div className="flex flex-wrap items-center gap-2">
            {showClientPicker && (
              <Select value={connectClientRef} onValueChange={setSelectedClientRef}>
                <SelectTrigger
                  className="h-8 w-auto text-xs"
                  data-testid={`connect-client-picker-${status.auth_key}`}
                >
                  <SelectValue placeholder={t("integration.clients.connectWith")} />
                </SelectTrigger>
                <SelectContent>
                  {clients!.map((client) => (
                    <SelectItem key={client.client_ref} value={client.client_ref}>
                      {client.source === "built-in"
                        ? t("integration.clients.sourceBuiltIn")
                        : t("integration.clients.sourceCustom")}{" "}
                      · {client.client_id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <InlineConnectButton
              packageId={packageId}
              authKey={status.auth_key}
              intent="connect"
              label={t("integration.auth.addAccount")}
              forceAccountSelect={status.connections.length > 0}
              lockToAuthKey
              {...(connectClientRef ? { clientRef: connectClientRef } : {})}
            />
          </div>
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

      {/* OAuth clients (system + custom) + the BYO-app registration form. */}
      {isOAuth && (
        <div>
          <ClientsTable packageId={packageId} authKey={status.auth_key} />
          <OAuthClientForm
            packageId={packageId}
            authKey={status.auth_key}
            authDecl={authDecl}
            autoProvisioned={status.client_auto_provisioned}
          />
        </div>
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
    return connectionDisplayLabel(c);
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
    return connectionDisplayLabel(c);
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
          <table className="w-full text-xs">
            <thead className="bg-muted/40 text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">
                  {t("integration.admin.pinManagement.colAgent")}
                </th>
                <th className="px-3 py-2 text-left font-medium">
                  {t("integration.admin.pinManagement.colAuth")}
                </th>
                <th className="px-3 py-2 text-left font-medium">
                  {t("integration.admin.pinManagement.colConnection")}
                </th>
                <th className="w-12 px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {(pins ?? []).map((p) => (
                <tr
                  key={`${p.packageId}-${p.auth_key}`}
                  className="border-border border-t"
                  data-testid={`pin-row-${p.packageId}-${p.auth_key}`}
                >
                  <td className="px-3 py-2">{agentDisplayName(p.packageId)}</td>
                  <td className="px-3 py-2">
                    <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 font-mono text-[10px]">
                      {p.auth_key}
                    </span>
                  </td>
                  <td className="px-3 py-2">{connectionDisplay(p.connection_id)}</td>
                  <td className="px-3 py-2">
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
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
  // Which client minted each connection — only meaningful for oauth2 auths. The
  // column resolves `client_ref` → source + client_id; a connection is bound to
  // its client (refresh uses it), so this answers "which client is in use".
  const isOAuth = authType === "oauth2";
  const { data: clients } = useIntegrationClients(
    isOAuth ? packageId : undefined,
    isOAuth ? authKey : undefined,
  );
  if (connections.length === 0)
    return <p className="text-muted-foreground text-sm">{t("integration.auth.noConnection")}</p>;
  return (
    <div className="overflow-hidden rounded-md border" data-testid={`connections-table-${authKey}`}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="text-xs">{t("integration.connection.col.account")}</TableHead>
            {isOAuth && (
              <TableHead className="text-xs">{t("integration.connection.col.client")}</TableHead>
            )}
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
              showClient={isOAuth}
              client={clients?.find((x) => x.client_ref === c.client_ref)}
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
  showClient,
  client,
}: {
  connection: IntegrationConnection;
  packageId: string;
  /** Auth key the connection is bound to — forwarded to the renew CTA. */
  authKey: string;
  /** Auth type from the manifest — gates the renew CTA to oauth2 only. */
  authType: IntegrationAuthType;
  /** False when no OAuth client is usable yet — admin must set one up first. */
  canRenew: boolean;
  /** Render the "Client" cell (oauth2 auths only). */
  showClient: boolean;
  /** The resolved client descriptor for this connection's `client_ref`, if any. */
  client?: IntegrationClient;
}) {
  const { t } = useTranslation("settings");
  const updateConnection = useUpdateIntegrationConnection();
  const disconnect = useDisconnectIntegrationConnection();
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  const [editing, setEditing] = useState(false);
  const [draftLabel, setDraftLabel] = useState(connection.label ?? "");
  const [confirmDelete, setConfirmDelete] = useState(false);
  // `label` is the single source of truth (set at creation to the identity or
  // "Connexion N"); render it verbatim.
  const name = connectionDisplayLabel(connection);
  const isShared = connection.shared_with_org === true;
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
    if (!orgId || !applicationId) return;
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
            </div>
          )}
        </TableCell>

        {/* Client — which registered client minted (and refreshes) this connection */}
        {showClient && (
          <TableCell data-testid={`connection-client-${connection.id}`}>
            {connection.client_ref ? (
              client ? (
                <span className="inline-flex items-center gap-1.5">
                  <Badge variant={client.source === "built-in" ? "secondary" : "outline"}>
                    {client.source === "built-in"
                      ? t("integration.clients.sourceBuiltIn")
                      : t("integration.clients.sourceCustom")}
                  </Badge>
                  <span className="text-muted-foreground font-mono text-[0.65rem]">
                    {client.client_id}
                  </span>
                </span>
              ) : (
                // The pinned client is no longer listed (custom deleted / system
                // entry removed) — show the raw ref so it is not silently hidden.
                <span
                  className="text-muted-foreground font-mono text-[0.65rem]"
                  title={connection.client_ref}
                >
                  {connection.client_ref}
                </span>
              )
            ) : (
              <span className="text-muted-foreground text-xs">—</span>
            )}
          </TableCell>
        )}

        {/* Status — connected / needs reconnection (+ renew) + expiry */}
        <TableCell>
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              {connection.needs_reconnection ? (
                <>
                  <ConnectionStatusBadge tone="needsReconnection">
                    {t("integration.auth.needsReconnection")}
                  </ConnectionStatusBadge>
                  {canRenew && authType === "oauth2" && (
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

        {/* Org-share toggle */}
        <TableCell>
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
        </TableCell>

        {/* Disconnect */}
        <TableCell className="text-right">
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
// Setup guide (admin-only)
// ─────────────────────────────────────────────

/**
 * AFPS §7.10 — `setup_guide.steps` is the canonical place for integration
 * publishers to describe IdP-side prerequisites (create an OAuth app, add a
 * redirect URI, …). Rendered as an ordered list on the admin view next to
 * the OAuth client form so the operator has the publisher's instructions at
 * eye level. Each step is `{ label: string, url?: string }`; the `url`
 * surfaces as a clickable link when present.
 */
function SetupGuideSteps({ steps }: { steps: ReadonlyArray<{ label: string; url?: string }> }) {
  const { t } = useTranslation("settings");
  if (steps.length === 0) return null;
  return (
    <section
      className="bg-muted/20 mb-4 rounded-md border p-4"
      data-testid="setup-guide-steps"
      aria-label={t("integration.setup_guide.step_label")}
    >
      <h3 className="mb-2 text-sm font-semibold">{t("integration.setup_guide.title")}</h3>
      <ol className="text-muted-foreground list-decimal space-y-1 pl-5 text-xs">
        {steps.map((step, i) => (
          <li key={i} data-testid={`setup-guide-step-${i}`}>
            {step.url ? (
              <a
                href={step.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline"
              >
                {step.label}
              </a>
            ) : (
              <span>{step.label}</span>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

// ─────────────────────────────────────────────
// About + metadata blocks
// ─────────────────────────────────────────────

function MetadataBlock({ manifest }: { manifest: IntegrationManifestView }) {
  const { t } = useTranslation("settings");
  const authorRaw = (manifest as { author?: unknown }).author;
  const author =
    typeof authorRaw === "string"
      ? authorRaw
      : authorRaw && typeof authorRaw === "object" && "name" in authorRaw
        ? (((authorRaw as { name?: unknown }).name as string | undefined) ?? "")
        : "";
  const repoRaw = (manifest as { repository?: unknown }).repository;
  const repo =
    typeof repoRaw === "string"
      ? repoRaw
      : repoRaw && typeof repoRaw === "object" && "url" in repoRaw
        ? (((repoRaw as { url?: unknown }).url as string | undefined) ?? "")
        : "";
  const sourceKind = manifest.source?.kind ?? "api";
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
    [t("integration.field.serverType"), <span className="font-mono">{sourceKind}</span>],
    ...(manifest.allow_undeclared_tools === true
      ? ([
          [
            t("integration.field.allowUndeclaredTools"),
            <Badge
              variant="outline"
              className="text-[0.65rem]"
              data-testid="integration-meta-wildcard-badge"
            >
              {t("integration.field.allowUndeclaredToolsBadge")}
            </Badge>,
          ],
        ] as Array<[string, React.ReactNode]>)
      : []),
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

/**
 * Inline prompt shown inside the Connexions tab when the integration is not
 * yet active — connecting and governance are meaningless until the
 * integration is activated for this application.
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
  const { t } = useTranslation(["settings", "common"]);
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
  const [tab, setTab] = useState("connections");
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
              manifest={m}
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

      <Tabs value={tab} onValueChange={setTab} className="mt-2">
        <TabsList>
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
          {!isBuiltIn && (
            <TabsTrigger value="versions" data-testid="tab-versions">
              {t("integration.tabs.versions")}
            </TabsTrigger>
          )}
        </TabsList>

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

        {/* ─── À propos (metadata) ─── */}
        <TabsContent value="about" className="mt-4">
          <div className="max-w-2xl space-y-4">
            <MetadataBlock manifest={m} />
            {m.keywords && m.keywords.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {m.keywords.map((k) => (
                  <Badge key={k} variant="outline" className="text-[0.65rem]">
                    {k}
                  </Badge>
                ))}
              </div>
            )}
          </div>
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
