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
 *   - Connexions — per-auth cards grouped by authKey. Each card carries its
 *     own setup: for oauth2, the admin OAuth client form sits inside the card
 *     (a missing client locks the connection list right below it). A collapsed
 *     admin "Règles d'accès" section at the bottom holds the org-wide policy
 *     (block member connections, default connection, per-agent pin exceptions).
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
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { LoadingState, ErrorState } from "../components/page-states";
import { SharedHeader } from "../components/package-detail/shared-header";
import { PackageActionsDropdown } from "../components/package-detail/package-actions-dropdown";
import { VersionHistory } from "../components/version-history";
import { ForkPackageModal } from "../components/fork-package-modal";
import { ConfirmModal } from "../components/confirm-modal";
import { usePermissions } from "../hooks/use-permissions";
import { usePackageDetail, useDeletePackage, usePackageDownload } from "../hooks/use-packages";
import { usePackageOwnership } from "../hooks/use-org";
import {
  useIntegrationDetail,
  useActivateIntegration,
  useDeactivateIntegration,
  useIntegrationOAuthClient,
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
  // Accordion: collapsed once a client is registered, open while it still
  // needs configuring. `null` = follow that default; a boolean = user toggled.
  const [open, setOpen] = useState<boolean | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

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

  const configured = !!client;
  const isOpen = open === null ? !configured : open;

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
                : "bg-warning/10 text-warning ml-auto rounded px-1.5 py-0.5 text-[0.65rem] font-medium"
            }
          >
            {configured
              ? t("integration.oauthClient.configured")
              : t("integration.oauthClient.notConfigured")}
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent className="px-4 pb-4">
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
              {client && (
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
        </CollapsibleContent>
      </Collapsible>
      <ConfirmModal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={t("btn.confirm", { ns: "common" })}
        description={t("integration.oauthClient.delete.confirm")}
        isPending={del.isPending}
        onConfirm={() =>
          del.mutate({ packageId, authKey }, { onSuccess: () => setConfirmDelete(false) })
        }
      />
    </>
  );
}

// ─────────────────────────────────────────────
// Auth section (per declared auth in manifest)
// ─────────────────────────────────────────────

/**
 * Per-auth card, grouped by authKey. Self-contained setup + connections:
 *   - Auth metadata: type, required flag, default scopes, audience,
 *     authorized URIs.
 *   - For oauth2 + admin: the OAuth client registration form sits INSIDE
 *     the card, directly above the connection list — a missing client
 *     locks connecting, so the cause and the fix are co-located.
 *   - Connection list with "+ Ajouter", rename/share/disconnect per row.
 *
 * Scope-aware connect/upgrade still also lives on the agent surfaces
 * (AgentIntegrationsBlock + MissingConnectionsModal) where the per-agent
 * scope context is known; the "+ Ajouter" here connects with default scopes.
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
  const clientMissing = isOAuth && !status.hasOAuthClient;

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

      {/* OAuth client setup (admin only) — the precondition for any oauth2
          connection. Lives inside the card so the lock state below points at
          a fix that's right here, not in another tab. */}
      {isOAuth && isAdmin && (
        <div className="mb-3">
          <OAuthClientForm packageId={packageId} authKey={status.authKey} />
        </div>
      )}

      {/* Connect button / locked state. A missing oauth2 client blocks
          connecting: admins see the form above, members get a pointer. */}
      {clientMissing ? (
        <p
          className="text-muted-foreground mb-2 text-xs"
          data-testid={`no-oauth-client-hint-${status.authKey}`}
        >
          {isAdmin ? t("integration.auth.noClientHintAdmin") : t("integration.auth.noClientHint")}
        </p>
      ) : (
        <div className="mb-2 flex items-center justify-end">
          <InlineConnectButton
            packageId={packageId}
            authKey={status.authKey}
            intent="connect"
            label={t("integration.auth.addAccount")}
            forceAccountSelect={status.connections.length > 0}
            lockToAuthKey
          />
        </div>
      )}
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

  const shared = (connections ?? []).filter((c) => c.sharedWithOrg === true);
  const connectionDisplay = (id: string): string => {
    const c = (connections ?? []).find((x) => x.id === id);
    if (!c) return id;
    return connectionDisplayLabel(c);
  };

  const [connectionId, setConnectionId] = useState("");
  const [enforce, setEnforce] = useState(false);

  // Seed the form from the persisted default once loaded.
  const seededFor = orgDefault?.connectionId ?? null;
  const [seeded, setSeeded] = useState<string | null>(null);
  if (seededFor !== seeded) {
    setSeeded(seededFor);
    setConnectionId(orgDefault?.connectionId ?? "");
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
            onClick={() => connectionId && upsert.mutate({ packageId, connectionId, enforce })}
            disabled={!connectionId || upsert.isPending}
            data-testid="org-default-save"
          >
            {t("integration.admin.orgDefault.save")}
          </Button>
          {orgDefault ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => remove.mutate({ packageId })}
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

  const pinnableConnections = (connections ?? []).filter((c) => c.sharedWithOrg === true);

  // Lookup helpers for the table
  const agentDisplayName = (id: string): string =>
    consumingAgents?.find((a) => a.packageId === id)?.displayName ?? id;
  const connectionDisplay = (id: string): string => {
    const c = (connections ?? []).find((x) => x.id === id);
    if (!c) return id;
    return connectionDisplayLabel(c);
  };

  const onSubmitNewPin = () => {
    if (!newAgent || !newConnectionId) return;
    upsertPin.mutate(
      {
        packageId,
        agentPackageId: newAgent,
        connectionId: newConnectionId,
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
    (pins ?? []).filter((p) => p.integrationPackageId === packageId).map((p) => p.packageId),
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
                  key={`${p.packageId}-${p.authKey}`}
                  className="border-border border-t"
                  data-testid={`pin-row-${p.packageId}-${p.authKey}`}
                >
                  <td className="px-3 py-2">{agentDisplayName(p.packageId)}</td>
                  <td className="px-3 py-2">
                    <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 font-mono text-[10px]">
                      {p.authKey}
                    </span>
                  </td>
                  <td className="px-3 py-2">{connectionDisplay(p.connectionId)}</td>
                  <td className="px-3 py-2">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6"
                      disabled={deletePin.isPending}
                      onClick={() =>
                        deletePin.mutate({
                          packageId,
                          agentPackageId: p.packageId,
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
                  {a.displayName}
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

function ConnectionRow({
  connection,
  packageId,
}: {
  connection: IntegrationConnection;
  packageId: string;
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
  const onDelete = () => {
    if (!orgId || !applicationId) return;
    setConfirmDelete(true);
  };
  return (
    <>
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
          <Button
            size="icon"
            variant="ghost"
            className="ml-auto size-7"
            onClick={onDelete}
            disabled={disconnect.isPending}
            title={t("integration.connection.delete")}
            data-testid={`connection-delete-${connection.id}`}
          >
            <Trash2 className="text-destructive size-3.5" />
          </Button>
        </div>
      </div>
      <ConfirmModal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={t("btn.confirm", { ns: "common" })}
        description={t("integration.connection.deleteConfirm")}
        isPending={disconnect.isPending}
        onConfirm={() =>
          disconnect.mutate(
            { connectionId: connection.id },
            { onSuccess: () => setConfirmDelete(false) },
          )
        }
      />
    </>
  );
}

// ─────────────────────────────────────────────
// About + metadata blocks
// ─────────────────────────────────────────────

function MetadataBlock({ manifest }: { manifest: IntegrationManifestView }) {
  const { t } = useTranslation("settings");
  // AFPS 2.0: author moved under `_meta["dev.appstrate/package"].author`,
  // repository is now a top-level string, and the old `server`/`compatibility`
  // fields are gone — server type is expressed by the `source.kind` discriminant.
  const pkgMeta = manifest._meta?.["dev.appstrate/package"] as { author?: unknown } | undefined;
  const author = typeof pkgMeta?.author === "string" ? pkgMeta.author : "";
  const repo = typeof manifest.repository === "string" ? manifest.repository : "";
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
  const { isOwned } = usePackageOwnership(packageId || undefined);
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
  const isImported = !isBuiltIn && !isOwned;
  const onActivate = () => activate.mutate(packageId);

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
              manifest={m as unknown as Record<string, unknown>}
              isOwned={isOwned}
              isImported={isImported}
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
          <TabsTrigger value="about" data-testid="tab-about">
            {t("integration.tabs.about")}
          </TabsTrigger>
          {!isBuiltIn && (
            <TabsTrigger value="versions" data-testid="tab-versions">
              {t("integration.tabs.versions")}
            </TabsTrigger>
          )}
        </TabsList>

        {/* ─── Connexions (per-auth cards + admin access rules) ─── */}
        <TabsContent value="connections" className="mt-4 space-y-4">
          {!active ? (
            <ActivationHint onActivate={onActivate} pending={activate.isPending} />
          ) : (
            <>
              {detail.auths.length === 0 ? (
                <p className="text-muted-foreground text-sm">{t("integration.auth.none")}</p>
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
              {isAdmin && (
                <AccessRulesSection
                  packageId={packageId}
                  blockUserConnections={summary?.blockUserConnections ?? false}
                />
              )}
            </>
          )}
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
          deactivate.mutate(packageId, { onSuccess: () => setConfirmDeactivate(false) })
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
