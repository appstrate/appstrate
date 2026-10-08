// SPDX-License-Identifier: Apache-2.0

/**
 * Integration detail: capabilities and usage, connected accounts, tools,
 * authentication/access settings, and the read-only artifact. Technical auth
 * identifiers never stand in for navigation or capability activation.
 * OAuth clients are listed per tier (the space's own, then the organisation's,
 * inherited by every space); client and connection mutations retain their
 * ownership gates.
 */

import { lazy, Suspense, useState } from "react";
import { useTabWithHash } from "../hooks/use-tab-with-hash";
import { CopyBlock } from "../components/copy-block";
import { IntegrationOverview } from "../components/package-detail/integration-overview";
import {
  IntegrationFunctioning,
  IntegrationMap,
} from "../components/package-detail/integration-structure";
import { PackageFilesView } from "../components/package-files/package-files-view";
import { PackageFilesSection } from "../components/package-files/package-files-section";
import { IntegrationToolsSection } from "../components/integration-editor/integration-tools-section";
import { CallbackUrlHint } from "../components/package-detail/callback-url-hint";

/** Keep legacy fragments readable after moving files into settings. */
const INTEGRATION_TABS = [
  "overview",
  "connections",
  "configuration",
  "tools",
  "about",
  "content",
  "versions",
] as const;
import { useTranslation } from "react-i18next";
import { Navigate, useParams, useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import type { OrgPackageItemDetail } from "@appstrate/shared-types";
import type { IntegrationDefinitionSection } from "./package-editor";
import {
  Trash2,
  ShieldCheck,
  Plus,
  KeyRound,
  Plug,
  FolderTree,
  Wrench,
  Workflow,
  History,
  FileArchive,
  IdCard,
  Server,
  AlertTriangle,
  ChevronDown,
} from "lucide-react";
import { authMethodLabel } from "../lib/integration-presentation";
import { AddIntegrationConnection } from "../components/integration-connect/add-integration-connection";
import { Button } from "@appstrate/ui/components/button";
import { Badge } from "@appstrate/ui/components/badge";
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";
import { Checkbox } from "@appstrate/ui/components/checkbox";
import { SettingsHeading } from "../components/settings/settings-heading";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@appstrate/ui/components/select";
import { Tabs, TabsContent } from "@appstrate/ui/components/tabs";
import { Alert, AlertDescription } from "@appstrate/ui/components/alert";
import { MAX_CONNECTIONS_PER_INTEGRATION } from "@appstrate/core/integration";
import { getErrorMessage } from "@appstrate/core/errors";
import { LoadingState, ErrorState, EmptyState } from "../components/page-states";
import { DataTable } from "../components/data-table";
import { useIntegrationClientColumns, useConnectionColumns } from "./integration-columns";
import { mergeClientTiers, type ClientRow } from "../lib/integration-clients";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@appstrate/ui/components/dropdown-menu";
import { DetailTabsList, DetailTabsTrigger } from "../components/agent-detail/agent-local-tabs";
import { ListToolbar } from "../components/list-toolbar";
import {
  AgentDetailSplit,
  AgentDetailSectionHeader,
} from "../components/agent-detail/agent-detail-split";
import { RailLink } from "../components/settings/rail-link";
import { SharedHeader } from "../components/package-detail/shared-header";
import { PackageActionsDropdown } from "../components/package-detail/package-actions-dropdown";
import { SetupGuideSteps } from "../components/package-detail/setup-guide-steps";
import { PackageVersionsSection } from "../components/package-detail/package-versions-section";
import { ForkPackageModal } from "../components/fork-package-modal";
import { ConfirmModal } from "../components/confirm-modal";
import { keepAvailable, toggleCapped, unavailableConnectionIds } from "../lib/connection-set";
import { Modal } from "../components/modal";
import { usePermissions, useHomeSpaceName, useCurrentSpaceGrant } from "../hooks/use-permissions";
import { maySetPackageActive } from "../lib/package-permissions";
import {
  usePackageDetail,
  useDeletePackage,
  usePackageDownload,
  type Versioned,
} from "../hooks/use-packages";
import {
  useIntegrationDetail,
  useIntegrationClients,
  useSetDefaultIntegrationClient,
  useCreateIntegrationOAuthClient,
  useRotateIntegrationOAuthClient,
  useDeleteIntegrationOAuthClient,
  usePromoteIntegrationOAuthClient,
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
  type IntegrationClient,
  type IntegrationClientTier,
  type IntegrationConnection,
  type IntegrationManifestAuth,
  type IntegrationDetailWire,
} from "../hooks/use-integrations";
import { useCurrentSpaceId } from "../hooks/use-current-space";
import { useSetPackageActive } from "../hooks/use-library";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@appstrate/ui/components/table";
import { useIntegrations } from "../hooks/use-integrations";
import { useAuth } from "../hooks/use-auth";

const IntegrationDefinitionEditor = lazy(() =>
  import("./package-editor").then((module) => ({
    default: module.IntegrationDefinitionEditor,
  })),
);

/** Rail id → editor section. Contenu (`bundle`) is not one: it reads the bundle. */
const DEFINITION_RAIL: Record<string, IntegrationDefinitionSection> = {
  identity: "general",
  source: "source",
  "auth-methods": "auths",
  tools: "tools",
};

/** Sections that moved: the policy joined the catalog, the document the files table. */
const RENAMED_SECTIONS: Record<string, string> = {
  "tool-policies": "tools",
  documentation: "files",
};
import { isOauthAuthConnectable } from "../components/integration-connect/connectable-auth-keys";

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
  tier,
  packageId,
  authKey,
  authDecl,
  mode,
  existing,
  platformRedirectUri,
  onClose,
}: {
  tier: IntegrationClientTier;
  packageId: string;
  authKey: string;
  authDecl?: IntegrationManifestAuth;
  mode: "create" | "rotate";
  existing?: IntegrationClient;
  platformRedirectUri: string;
  onClose: () => void;
}) {
  const { t } = useTranslation("settings");
  const create = useCreateIntegrationOAuthClient(tier);
  const rotate = useRotateIntegrationOAuthClient(tier);
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
 * The admin hub for an auth's OAuth clients, in ONE table: the space's own
 * clients, the organisation's (inherited by every space) and the platform's
 * system client — each once, with the one new connections here will use marked
 * and named above the table. Multi-client: an admin registers as many clients
 * as needed, at the space's level or, for an org integrations admin, the
 * organisation's; rotates or deletes each; and picks the one in use (the
 * model-provider pattern). Auto-provisioned (remote MCP DCR/CIMD) auths have no
 * organisation level and keep ONE machine client, shown read-only with a delete
 * action that re-triggers registration; a manual escape hatch (opt-in) covers
 * the rare server needing a pre-registered public client. Secrets are never
 * returned by the endpoint.
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
  const { can } = usePermissions();
  // Auto-provisioned clients are per space: such an auth has no org level.
  const canManageOrg = !autoProvisioned && can("org-integrations:configure");
  const spaceClients = useIntegrationClients("space", packageId, authKey);
  const orgClients = useIntegrationClients("org", canManageOrg ? packageId : undefined, authKey);
  // Read from the same query key the page already holds, rather than threading
  // the value down through `ConfigAuthBlock`, which would carry a prop it never
  // reads. React Query dedupes, so this costs no request.
  const { data: detail } = useIntegrationDetail(packageId);
  const platformRedirectUri = detail?.platform_redirect_uri ?? "";
  const setSpaceDefault = useSetDefaultIntegrationClient("space");
  const setOrgDefault = useSetDefaultIntegrationClient("org");
  const deleteSpaceClient = useDeleteIntegrationOAuthClient("space");
  const deleteOrgClient = useDeleteIntegrationOAuthClient("org");
  const promote = usePromoteIntegrationOAuthClient();
  const [modal, setModal] = useState<
    | { mode: "create"; tier: IntegrationClientTier }
    | { mode: "rotate"; tier: IntegrationClientTier; client: IntegrationClient }
    | null
  >(null);
  const [confirmDelete, setConfirmDelete] = useState<ClientRow | null>(null);
  const [confirmPromote, setConfirmPromote] = useState<ClientRow | null>(null);
  // Auto-provisioned auths hide the manual register button by default — their
  // token endpoint only accepts a DCR/CIMD-acquired client, so a hand-entered
  // one usually points at the wrong server and disables auto-registration. Keep
  // an opt-in escape hatch for the rare server needing a pre-registered client.
  const [showManual, setShowManual] = useState(false);

  const rows = mergeClientTiers(
    spaceClients.data ?? [],
    canManageOrg ? orgClients.data : undefined,
  );
  const inUse = rows.find((row) => row.usedHere);
  const hasAutoClient = rows.some((row) => row.client.auto_provisioned);
  // Classic auths always allow registering more clients; auto-provisioned
  // auths only via the opt-in escape hatch (and only when none is registered yet).
  const canRegister = !autoProvisioned || (showManual && !hasAutoClient);
  const tierOf = (row: ClientRow): IntegrationClientTier => (row.level === "org" ? "org" : "space");
  const pending = [
    setSpaceDefault,
    setOrgDefault,
    deleteSpaceClient,
    deleteOrgClient,
    promote,
  ].find((mutation) => mutation.isPending);
  const pendingClientRef = !pending
    ? null
    : pending === setSpaceDefault || pending === setOrgDefault
      ? ((pending.variables as { body: { client_ref: string } } | undefined)?.body.client_ref ??
        null)
      : ((pending.variables as { params: { path: { clientId: string } } } | undefined)?.params.path
          .clientId ?? null);
  const columns = useIntegrationClientColumns({
    canUseHere: (spaceClients.data?.length ?? 0) > 1,
    canManageOrg,
    canChooseOrgDefault: canManageOrg && (orgClients.data?.length ?? 0) > 1,
    canPromote: canManageOrg,
    pendingClientRef,
    onUseHere: (row) =>
      setSpaceDefault.mutate({
        params: { path: { packageId, authKey } },
        body: { client_ref: row.client.client_ref },
      }),
    onUseForOrg: (row) =>
      setOrgDefault.mutate({
        params: { path: { packageId, authKey } },
        body: { client_ref: row.client.client_ref },
      }),
    onRotate: (row) => setModal({ mode: "rotate", tier: tierOf(row), client: row.client }),
    onPromote: (row) => setConfirmPromote(row),
    onDelete: (row) => setConfirmDelete(row),
  });
  const levelLabel = (row: ClientRow) =>
    row.level === "system"
      ? t("source.builtIn")
      : row.level === "org"
        ? t("source.org")
        : t("source.space");
  const deleteMutation =
    confirmDelete && tierOf(confirmDelete) === "org" ? deleteOrgClient : deleteSpaceClient;

  return (
    <div className="mb-3" data-testid={`oauth-clients-list-${authKey}`}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h4 className="text-sm font-medium">{t("integration.clients.title")}</h4>
        {canRegister &&
          (canManageOrg ? (
            // Two levels to register at: the choice is made before the form,
            // not inside it, so the form stays the one it always was.
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  data-testid={`oauth-client-register-${authKey}`}
                >
                  <Plus size={14} />
                  {t("integration.clients.register")}
                  <ChevronDown size={14} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setModal({ mode: "create", tier: "space" })}>
                  {t("integration.clients.registerSpace")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => setModal({ mode: "create", tier: "org" })}
                  data-testid={`org-oauth-client-register-${authKey}`}
                >
                  {t("integration.clients.registerOrg")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => setModal({ mode: "create", tier: "space" })}
              data-testid={`oauth-client-register-${authKey}`}
            >
              <Plus size={14} />
              {t("integration.clients.register")}
            </Button>
          ))}
      </div>

      {/* The one answer the table exists for, then the rule in one line. */}
      {inUse && (
        <p className="mb-1 text-sm" data-testid={`oauth-client-in-use-${authKey}`}>
          {t("integration.clients.inUse", {
            client: inUse.client.client_id,
            level: levelLabel(inUse),
          })}
        </p>
      )}
      {!autoProvisioned && (
        <p className="text-muted-foreground mb-3 text-sm">{t("integration.clients.levels")}</p>
      )}

      <DataTable
        surface="integrated"
        columnMode="scroll"
        label={t("integration.clients.title")}
        columns={columns}
        rows={rows}
        rowKey={(row) => row.client.client_ref}
        isLoading={spaceClients.isLoading}
        isError={spaceClients.isError}
        // The reason, not just the fact: `DataTable` owes a default when the
        // caller writes no message, and a default is all this had.
        error={<ErrorState message={getErrorMessage(spaceClients.error)} compact />}
        // The register button above is the way out of an empty list, and it is
        // already written out — the empty state does not re-offer it. On an
        // auto-provisioned auth the reason the list is empty IS the state, so
        // it is the empty state's hint rather than a second sentence above a
        // table saying the same thing in other words.
        empty={
          <EmptyState
            message={t("integration.clients.empty")}
            hint={
              autoProvisioned ? (
                <span data-testid={`oauth-client-auto-hint-${authKey}`}>
                  {t("integration.oauthClient.autoProvisionedHint")}
                </span>
              ) : undefined
            }
            icon={KeyRound}
            compact
          />
        }
      />

      {autoProvisioned && !showManual && !hasAutoClient && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setShowManual(true)}
          data-testid={`oauth-client-manual-toggle-${authKey}`}
        >
          {t("integration.oauthClient.registerManually")}
        </Button>
      )}

      {modal && (
        <OAuthClientModal
          key={modal.mode === "rotate" ? modal.client.client_ref : `create-${modal.tier}`}
          tier={modal.tier}
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
        description={
          confirmDelete && tierOf(confirmDelete) === "org"
            ? t("integration.oauthClient.delete.confirmOrg")
            : t("integration.oauthClient.delete.confirm")
        }
        isPending={deleteMutation.isPending}
        onConfirm={() => {
          if (!confirmDelete) return;
          deleteMutation.mutate(
            { params: { path: { packageId, clientId: confirmDelete.client.client_ref } } },
            { onSuccess: () => setConfirmDelete(null) },
          );
        }}
      />
      <ConfirmModal
        open={confirmPromote !== null}
        onClose={() => setConfirmPromote(null)}
        title={t("integration.clients.promote.action")}
        description={t("integration.clients.promote.confirm")}
        variant="default"
        isPending={promote.isPending}
        onConfirm={() => {
          if (!confirmPromote) return;
          promote.mutate(
            { params: { path: { packageId, clientId: confirmPromote.client.client_ref } } },
            { onSuccess: () => setConfirmPromote(null) },
          );
        }}
      />
    </div>
  );
}

// ─────────────────────────────────────────────
// Configuration tab — per-auth metadata + OAuth clients
// ─────────────────────────────────────────────

/**
 * The redirect URI an admin registers at the provider, once per auth, under
 * both client tables.
 */
function AuthTechnicalSettings({ packageId, authKey }: { packageId: string; authKey: string }) {
  const { t } = useTranslation("settings");
  // Same query keys the tables above hold: React Query dedupes, no request.
  const { data: clients } = useIntegrationClients("space", packageId, authKey);
  const { data: detail } = useIntegrationDetail(packageId);
  // What connect will ACTUALLY send. A registered client may carry its own
  // `redirect_uri`, and `OAuth2Strategy.begin` prefers it over the platform
  // callback (`clientRedirectUri ?? redirectUri`) — so showing the platform
  // value unconditionally would hand the admin the wrong string to register in
  // exactly the setup this display exists to get right. New connections always
  // use the space's default client (its own or the org's it inherits), so that
  // client's override is the one that decides.
  const redirectUri =
    clients?.find((c) => c.is_default)?.redirect_uri || detail?.platform_redirect_uri;
  if (!redirectUri) return null;
  return (
    <section className="mt-8">
      <h4 className="mb-4 text-sm font-medium">{t("integration.presentation.technicalDetails")}</h4>
      {redirectUri && (
        <div className="mb-4 space-y-2">
          <p className="text-muted-foreground text-sm">
            {t("integration.oauthClient.platformRedirectUri")}
          </p>
          <CopyBlock value={redirectUri} testId={`platform-redirect-uri-${authKey}`} />
        </div>
      )}
    </section>
  );
}

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
    <section data-testid={`auth-config-${status.auth_key}`}>
      <p className="text-muted-foreground mb-5 text-sm">
        {t(
          isOAuth
            ? "integration.presentation.oauthDescription"
            : "integration.presentation.credentialsDescription",
        )}
      </p>
      {isOAuth && (
        <ClientsTable
          packageId={packageId}
          authKey={status.auth_key}
          authDecl={authDecl}
          autoProvisioned={status.client_auto_provisioned}
        />
      )}
      {isOAuth && <AuthTechnicalSettings packageId={packageId} authKey={status.auth_key} />}
    </section>
  );
}

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
  const location = useLocation();
  const navigate = useNavigate();
  const params = new URLSearchParams(location.search);
  const requestedRaw = params.get("integrationSettings");
  const requested = (requestedRaw && RENAMED_SECTIONS[requestedRaw]) ?? requestedRaw;
  const requestedFile = params.get("file") ?? undefined;
  const sectionHref = (id: string, extra: Record<string, string> = {}) => {
    const next = new URLSearchParams(location.search);
    next.set("integrationSettings", id);
    // A modal, or the file a link opened, belongs to the section it was opened in.
    for (const key of ["edit", "editManifest", "file", "toolPolicy"]) next.delete(key);
    for (const [key, value] of Object.entries(extra)) next.set(key, value);
    return `?${next.toString()}#configuration`;
  };
  const active =
    requested === "tools" ||
    requested === "functioning" ||
    requested === "map" ||
    (requested === "versions" && isOwned) ||
    requested === "bundle" ||
    (definition && requested && requested in DEFINITION_RAIL)
      ? requested
      : requested === "files" || !canConfigure
        ? "files"
        : requested === "access"
          ? "access"
          : "authentication";
  const steps = detail.manifest.setup_guide?.steps ?? [];
  // Same order as an agent's: Explorer (see it: map, files, versions), then
  // what is set here, then the AFPS package, what the integration IS for every
  // space, edited in place when the reader may. The tool catalogue belongs to
  // the package: nothing about it is set per organisation or per space.
  const groups = [
    {
      label: t("detail.settings.exploreGroup", { ns: "agents" }),
      items: [
        { id: "map", label: t("integration.structure.map"), icon: Workflow },
        { id: "files", label: t("detail.overview.explorer", { ns: "agents" }), icon: FolderTree },
        ...(isOwned
          ? [
              {
                id: "versions",
                label: t("detail.settings.versions", { ns: "agents" }),
                icon: History,
              },
            ]
          : []),
      ],
    },
    ...(canConfigure
      ? [
          {
            label: t("detail.settings.configurationGroup", { ns: "agents" }),
            items: [
              {
                id: "authentication",
                label: t("integration.presentation.authentication"),
                icon: KeyRound,
              },
              { id: "access", label: t("integration.admin.accessRules.title"), icon: ShieldCheck },
            ],
          },
        ]
      : []),
    {
      label: t("detail.settings.definitionGroup", { ns: "agents" }),
      items: definition
        ? [
            { id: "identity", label: t("editor.tabGeneral", { ns: "agents" }), icon: IdCard },
            {
              id: "source",
              label: t("integrationEditor.tabSource", { ns: "agents" }),
              icon: Server,
            },
            {
              id: "auth-methods",
              label: t("integrationEditor.tabAuthMethods", { ns: "agents" }),
              icon: KeyRound,
            },
            { id: "tools", label: t("integrationEditor.tabTools", { ns: "agents" }), icon: Wrench },
            {
              id: "bundle",
              label: t("editor.tabPackageFiles", { ns: "agents" }),
              icon: FileArchive,
            },
          ]
        : [
            { id: "functioning", label: t("integration.structure.functioning"), icon: Plug },
            { id: "tools", label: t("integrationEditor.tabTools", { ns: "agents" }), icon: Wrench },
            {
              id: "bundle",
              label: t("editor.tabPackageFiles", { ns: "agents" }),
              icon: FileArchive,
            },
          ],
    },
  ];
  const definitionSection = definition ? DEFINITION_RAIL[active] : undefined;
  return (
    <AgentDetailSplit
      className="max-lg:grid-cols-1"
      railClassName="p-6 max-lg:border-r-0 max-lg:border-b"
      rail={
        <nav className="space-y-5" aria-label={t("integration.tabs.configuration")}>
          {groups.map((group) => (
            <section key={group.label}>
              <h2 className="text-muted-foreground mb-1 px-2 text-[11px] font-semibold tracking-wide uppercase">
                {group.label}
              </h2>
              <div className="flex flex-col gap-0.5">
                {group.items.map((section) => {
                  return (
                    <RailLink
                      key={section.id}
                      item={{
                        to: sectionHref(section.id),
                        icon: section.icon,
                        labelKey: section.label,
                      }}
                      label={section.label}
                      active={active === section.id}
                    />
                  );
                })}
              </div>
            </section>
          ))}
        </nav>
      }
    >
      {definition && definitionSection ? (
        <Suspense fallback={<LoadingState />}>
          <IntegrationDefinitionEditor
            detail={definition}
            section={definitionSection}
            onSection={(next) => {
              const railId = Object.keys(DEFINITION_RAIL).find(
                (id) => DEFINITION_RAIL[id] === next,
              );
              if (railId) void navigate(sectionHref(railId));
            }}
            toolInspection={detail.tool_catalog_inspection}
          />
        </Suspense>
      ) : active === "bundle" ? (
        <PackageFilesSection
          type="integration"
          packageId={packageId}
          manifest={detail.manifest}
          filesHref={(path) => sectionHref("files", { file: path })}
        />
      ) : active === "versions" ? (
        <PackageVersionsSection type="integration" packageId={packageId} {...versionGrants} />
      ) : active === "files" ? (
        <PackageFilesView
          key={requestedFile}
          type="integration"
          packageId={packageId}
          initialPath={requestedFile}
          editable={Boolean(definition)}
          editHref={
            definition
              ? (path) =>
                  path === "manifest.json"
                    ? sectionHref("identity", { editManifest: "1" })
                    : undefined
              : undefined
          }
        />
      ) : active === "functioning" || active === "map" ? (
        <div className="p-6">
          <AgentDetailSectionHeader
            title={t(
              active === "map" ? "integration.structure.map" : "integration.structure.functioning",
            )}
            description={null}
          />
          {active === "map" ? (
            <IntegrationMap
              detail={detail}
              packageId={packageId}
              renderPanel={(section, openPanel) => {
                if (section === "files")
                  return <PackageFilesView type="integration" packageId={packageId} />;
                if (section === "tools")
                  return (
                    <IntegrationToolsSection
                      inspection={detail.tool_catalog_inspection}
                      allowUndeclaredTools={detail.allow_undeclared_tools}
                    />
                  );
                if (section === "functioning") return <IntegrationGeneral detail={detail} />;
                if (section.startsWith("connections:"))
                  return (
                    <ConnectionsTable
                      key={section}
                      packageId={packageId}
                      detail={detail}
                      canConfigure={canConfigure}
                      initialMethod={section.slice("connections:".length)}
                      onConfigure={(authKey) =>
                        openPanel(`auth:${authKey ?? detail.auths[0]?.auth_key ?? ""}`)
                      }
                    />
                  );
                if (!canConfigure)
                  return (
                    <p className="text-muted-foreground text-sm">
                      {t("integration.health.adminRequired")}
                    </p>
                  );
                if (!detail.active)
                  return (
                    <ActivationHint
                      onActivate={onActivate}
                      pending={activationPending}
                      canActivate={canActivate}
                    />
                  );
                if (section === "access")
                  return (
                    <IntegrationAccessRules
                      packageId={packageId}
                      blockUserConnections={blockUserConnections}
                    />
                  );
                const authKey = section.slice("auth:".length);
                const status = detail.auths.find((auth) => auth.auth_key === authKey);
                const authDecl = detail.manifest.auths?.[authKey];
                return status && authDecl ? (
                  <ConfigAuthBlock
                    key={authKey}
                    packageId={packageId}
                    status={status}
                    authDecl={authDecl}
                  />
                ) : null;
              }}
            />
          ) : (
            <IntegrationGeneral detail={detail} />
          )}
        </div>
      ) : active === "tools" ? (
        <div className="p-6">
          <AgentDetailSectionHeader
            title={t("integrationEditor.tabTools", { ns: "agents" })}
            description={t("integrationEditor.description.tools", { ns: "agents" })}
          />
          <IntegrationToolsSection
            inspection={detail.tool_catalog_inspection}
            allowUndeclaredTools={detail.allow_undeclared_tools}
            showBasis={false}
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
          <AgentDetailSectionHeader
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
              {detail.auths.length === 0 && <p className="text-sm">{t("integration.auth.none")}</p>}
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
                      <ConfigAuthBlock packageId={packageId} status={status} authDecl={authDecl} />
                    </section>
                  );
                })}
              </div>
            </div>
          )}
          {active === "access" && (
            <IntegrationAccessRules
              packageId={packageId}
              blockUserConnections={blockUserConnections}
            />
          )}
        </div>
      )}
    </AgentDetailSplit>
  );
}

function IntegrationAccessRules({
  packageId,
  blockUserConnections,
}: {
  packageId: string;
  blockUserConnections: boolean;
}) {
  const { t } = useTranslation("settings");
  return (
    <div className="space-y-8" data-testid="access-rules-section">
      <section>
        <SettingsHeading level="group" title={t("integration.admin.accounts.title")} />
        <BlockUserConnectionsToggle packageId={packageId} initialBlocked={blockUserConnections} />
        <OrgDefaultSection packageId={packageId} />
      </section>
      <PinManagementSection packageId={packageId} />
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
  const { data: orgDefault, isLoading, isError } = useIntegrationOrgDefault(packageId);
  const forced = orgDefault?.enforce === true;
  // Drives the control from server state. A pending mutation reads the
  // about-to-be-applied value, idle reads the latest fetched value.
  const blocked =
    updateSettings.isPending && updateSettings.variables?.params.path.packageId === packageId
      ? updateSettings.variables.body.block_user_connections
      : initialBlocked;
  return (
    <div className="grid gap-6 pb-8 md:grid-cols-2" data-testid="block-user-connections-section">
      <div className="min-w-0">
        <p id="account-creation-label" className="mb-3 text-sm font-medium">
          {t("integration.admin.creation.title")}
        </p>
        <Select
          value={blocked || forced ? "admins" : "members"}
          disabled={forced || isLoading || isError || updateSettings.isPending}
          onValueChange={(value) =>
            updateSettings.mutate(
              {
                params: { path: { packageId } },
                body: { block_user_connections: value === "admins" },
              },
              {
                onError: (error) => toast.error(getErrorMessage(error)),
              },
            )
          }
        >
          <SelectTrigger
            aria-labelledby="account-creation-label"
            data-testid="block-user-connections-toggle"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(["admins", "members"] as const).map((value) => (
              <SelectItem key={value} value={value}>
                {t(`integration.admin.creation.${value}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {forced && (
          <p className="text-muted-foreground mt-2 text-sm">
            {t("integration.admin.creation.forced")}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Option label for the two admin pickers (org default, pins). Those lists
 * are org-wide — since the connections endpoint returns shared connections
 * owned by other members, an admin choosing a cross-agent default is picking
 * between rows whose labels can collide ("Connexion 1" for two members), so
 * the owner is part of the identity here. The per-row table carries the same
 * information as a badge instead, where a suffix would fight the rename UI.
 */
function connectionOptionLabel(c: IntegrationConnection): string {
  return c.owner_name ? `${c.label} — ${c.owner_name}` : c.label;
}

/**
 * Org-wide default connections for this integration — the cross-agent
 * baseline every consuming agent uses unless a per-agent exception (pin)
 * overrides it. `enforce` locks members; otherwise it's a soft default a
 * member can still override with their own pick.
 *
 * The default is a SET (up to {@link MAX_CONNECTIONS_PER_INTEGRATION}), and
 * every subset is a valid default on its own, so each tick commits alone —
 * the rule for a list of independently valid values.
 */
function OrgDefaultSection({ packageId }: { packageId: string }) {
  const { t } = useTranslation("settings");
  const { data: orgDefault, isLoading, isError, refetch } = useIntegrationOrgDefault(packageId);
  const { data: connections } = useIntegrationConnections(packageId);
  const upsert = useUpsertIntegrationOrgDefault();
  const remove = useDeleteIntegrationOrgDefault();

  const shared = (connections ?? []).filter((c) => c.shared_with_org === true);
  const sharedIds = shared.map((c) => c.id);
  const storedIds = orgDefault?.connection_ids ?? [];
  // Stored members no longer shared are named apart: every run falling back on
  // them is refused. Until the list loads, every member would read as unavailable.
  const unavailableIds = connections ? unavailableConnectionIds(storedIds, sharedIds) : [];

  const [pendingValue, setPendingValue] = useState<{
    connection_ids: string[];
    enforce: boolean;
  } | null>(null);
  // Only what is still shared is ticked, so the next write is what the list shows.
  const connectionIds = pendingValue?.connection_ids ?? keepAvailable(storedIds, sharedIds);
  const enforce = pendingValue?.enforce ?? orgDefault?.enforce ?? false;
  const hasDefault = pendingValue ? pendingValue.connection_ids.length > 0 : !!orgDefault;
  const [draftMode, setDraftMode] = useState<string | null>(null);
  const mode = draftMode ?? (hasDefault ? (enforce ? "forced" : "default") : "choice");
  /** An empty set removes the default; `keepMode` holds the mode while the list is empty. */
  const save = async (nextIds: string[], nextEnforce: boolean, keepMode: string | null = null) => {
    setPendingValue({ connection_ids: nextIds, enforce: nextEnforce });
    if (nextIds.length === 0) setDraftMode(keepMode);
    try {
      if (nextIds.length > 0)
        await upsert.mutateAsync({
          params: { path: { packageId } },
          body: { connection_ids: nextIds, enforce: nextEnforce },
        });
      else await remove.mutateAsync({ params: { path: { packageId } } });
      await refetch();
    } catch {
      // The mutation's own `onError` has already said why.
    } finally {
      setPendingValue(null);
      if (nextIds.length > 0) setDraftMode(null);
    }
  };
  const connectionsLabel = t(
    `integration.admin.orgDefault.connection.${mode === "forced" ? "forced" : "default"}`,
  );

  return (
    <div className="space-y-4" data-testid="org-default-section">
      {unavailableIds.length > 0 && (
        <Alert variant="warning" data-testid="org-default-unavailable-warning">
          <AlertTriangle className="size-4" />
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>
              {t("integration.admin.orgDefault.unavailableWarning", {
                count: unavailableIds.length,
              })}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={pendingValue !== null}
              onClick={() => void save(connectionIds, enforce)}
              data-testid="org-default-drop-unavailable"
            >
              {t("integration.admin.orgDefault.dropUnavailable", {
                count: unavailableIds.length,
              })}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      <div className="grid items-start gap-6 md:grid-cols-2">
        <div className="min-w-0">
          <div className="mb-3">
            <p className="text-sm font-medium">{t("integration.admin.usage.title")}</p>
          </div>

          <Select
            value={mode}
            disabled={isLoading || isError || pendingValue !== null}
            onValueChange={(value) => {
              if (value === "choice") {
                setDraftMode(null);
                if (orgDefault) void save([], false);
              } else if (connectionIds.length > 0) void save(connectionIds, value === "forced");
              else setDraftMode(value);
            }}
          >
            <SelectTrigger aria-label={t("integration.admin.usage.title")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(["choice", "default", "forced"] as const).map((value) => (
                <SelectItem
                  key={value}
                  value={value}
                  disabled={value !== "choice" && shared.length === 0}
                >
                  {t(`integration.admin.usage.${value}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-muted-foreground mt-2 text-sm">
            {t(`integration.admin.usage.${mode}Help`)}
          </p>
          {shared.length === 0 ? (
            <p className="text-muted-foreground text-xs italic">
              {t("integration.admin.orgDefault.noPinnableConnections")}
            </p>
          ) : null}
        </div>
        {shared.length > 0 && mode !== "choice" ? (
          <div className="min-w-0">
            <p id="org-default-connections-label" className="mb-3 text-sm font-medium">
              {connectionsLabel}
            </p>
            <ConnectionSetChecklist
              connections={shared}
              value={connectionIds}
              onChange={(next) => void save(next, mode === "forced", mode)}
              idPrefix="org-default-connection"
              labelledBy="org-default-connections-label"
              unavailableIds={unavailableIds}
              disabled={isLoading || isError || pendingValue !== null}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Checkbox set capped at {@link MAX_CONNECTIONS_PER_INTEGRATION}. `unavailableIds` are stored
 * members no longer offered: listed unticked, so the next write visibly drops them.
 */
function ConnectionSetChecklist({
  connections,
  value,
  onChange,
  idPrefix,
  labelledBy,
  unavailableIds,
  disabled = false,
}: {
  connections: IntegrationConnection[];
  value: string[];
  onChange: (next: string[]) => void;
  idPrefix: string;
  labelledBy: string;
  unavailableIds?: string[];
  disabled?: boolean;
}) {
  const { t } = useTranslation("settings");
  return (
    <div
      role="group"
      aria-labelledby={labelledBy}
      className="flex flex-col gap-2"
      data-testid={`${idPrefix}s`}
    >
      {connections.map((c) => {
        const id = `${idPrefix}-${c.id}`;
        const isChecked = value.includes(c.id);
        return (
          <div key={c.id} className="flex items-center gap-2 text-sm">
            <Checkbox
              id={id}
              checked={isChecked}
              disabled={disabled || (!isChecked && value.length >= MAX_CONNECTIONS_PER_INTEGRATION)}
              onCheckedChange={() => onChange(toggleCapped(value, c.id))}
              data-testid={id}
            />
            <label htmlFor={id} className="min-w-0 truncate">
              {connectionOptionLabel(c)}
            </label>
          </div>
        );
      })}
      {unavailableIds?.map((id) => (
        <div
          key={id}
          className="flex items-center gap-2 text-sm"
          data-testid={`${idPrefix}-unavailable-${id}`}
        >
          <Checkbox checked={false} disabled aria-hidden />
          <span className="text-muted-foreground line-through">
            {t("integration.admin.unavailableConnection")}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Per-agent pins: one per (agent, integration), holding the whole bound SET, replaced on
 * write. With an org default in place, these are per-agent EXCEPTIONS.
 */
function PinManagementSection({ packageId }: { packageId: string }) {
  const { t } = useTranslation("settings");
  const { data: pins } = useIntegrationPins(packageId);
  const { data: connections } = useIntegrationConnections(packageId);
  const { data: consumingAgents } = useAgentsConsumingIntegration(packageId);
  const upsertPin = useUpsertIntegrationPin();
  const deletePin = useDeleteIntegrationPin();

  const [newAgent, setNewAgent] = useState("");
  const [adding, setAdding] = useState(false);
  const [newConnectionIds, setNewConnectionIds] = useState<string[]>([]);

  const pinnableConnections = (connections ?? []).filter((c) => c.shared_with_org === true);

  // Lookup helpers for the table
  const agentDisplayName = (id: string): string =>
    consumingAgents?.find((a) => a.packageId === id)?.display_name ?? id;

  const canAddPin = !!newAgent && newConnectionIds.length > 0;

  const onSubmitNewPin = () => {
    if (!canAddPin) return;
    upsertPin.mutate(
      {
        params: { path: { packageId, agentPackageId: newAgent } },
        body: { connection_ids: newConnectionIds },
      },
      {
        onSuccess: () => {
          setNewAgent("");
          setNewConnectionIds([]);
          setAdding(false);
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
    <div className="pb-0" data-testid="pin-management-section">
      <SettingsHeading
        level="group"
        title={t("integration.admin.exceptions.title")}
        description={t("integration.admin.exceptions.help")}
      />

      {/* Existing pins */}
      {(pins ?? []).length > 0 ? (
        <div className="mb-4 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("integration.admin.pinManagement.colAgent")}</TableHead>
                <TableHead>{t("integration.admin.pinManagement.colConnections")}</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(pins ?? []).map((p) => (
                <TableRow key={p.packageId} data-testid={`pin-row-${p.packageId}`}>
                  <TableCell>{agentDisplayName(p.packageId)}</TableCell>
                  <TableCell>
                    {p.connection_ids.map((id, i) => {
                      const c = pinnableConnections.find((x) => x.id === id);
                      return (
                        <span key={id}>
                          {i > 0 && " · "}
                          {c ? (
                            connectionOptionLabel(c)
                          ) : connections === undefined ? null : (
                            // No longer shared or deleted: every run of this agent is refused.
                            <span className="text-warning">
                              {t("integration.admin.unavailableConnection")}
                            </span>
                          )}
                        </span>
                      );
                    })}
                  </TableCell>
                  <TableCell>
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
      ) : !adding ? (
        <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
          {t("integration.admin.pinManagement.add")}
        </Button>
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[12rem] flex-1">
            <Label htmlFor="pin-add-agent" className="mb-2 block text-sm">
              {t("integration.admin.pinManagement.colAgent")}
            </Label>
            <Select value={newAgent} onValueChange={setNewAgent}>
              <SelectTrigger id="pin-add-agent" data-testid="pin-add-agent">
                <SelectValue placeholder={t("integration.admin.pinManagement.colAgent")} />
              </SelectTrigger>
              <SelectContent>
                {pinnableAgents.map((a) => (
                  <SelectItem key={a.packageId} value={a.packageId}>
                    {a.display_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="min-w-[12rem] flex-1">
            <p id="pin-add-connections-label" className="mb-2 block text-sm font-medium">
              {t("integration.admin.pinManagement.colConnections")}
            </p>
            <ConnectionSetChecklist
              connections={pinnableConnections}
              value={newConnectionIds}
              onChange={setNewConnectionIds}
              idPrefix="pin-add-connection"
              labelledBy="pin-add-connections-label"
            />
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={onSubmitNewPin}
            disabled={!canAddPin || upsertPin.isPending}
            data-testid="pin-add-submit"
          >
            {t("integration.admin.pinManagement.add")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={upsertPin.isPending}
            onClick={() => setAdding(false)}
          >
            {t("btn.cancel", { ns: "common" })}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * Connected accounts across all authentication methods.
 *
 * The rows come from the detail query the page already awaits, so the table has
 * no loading or failure of its own to draw — an empty auth is an ANSWER, and it
 * is the only state left for the body to show. Every control on a row lives in
 * its column (`integration-columns.tsx`), which is where the ownership rules
 * that gate them are written down.
 */
function ConnectionsTable({
  packageId,
  detail,
  canConfigure,
  onConfigure,
  initialMethod,
}: {
  packageId: string;
  detail: IntegrationDetailWire;
  canConfigure: boolean;
  onConfigure: (authKey?: string) => void;
  initialMethod?: string;
}) {
  const { t } = useTranslation("settings");
  const { can } = usePermissions();
  const canConnect = can("integrations:connect");
  const [search, setSearch] = useState("");
  const [sharing, setSharing] = useState<string[]>([]);
  const location = useLocation();
  const [methods, setMethods] = useState<string[]>(() => {
    const method = initialMethod ?? new URLSearchParams(location.search).get("connectionMethod");
    return detail.auths.some((auth) => auth.auth_key === method) ? [method!] : [];
  });
  const { user } = useAuth();
  const connections = detail.auths.flatMap((auth) =>
    auth.connections.map((connection) => ({ ...connection, auth_key: auth.auth_key })),
  );
  const labelFor = (auth: IntegrationAuthStatus) =>
    authMethodLabel(auth, detail.auths, t(`integration.auth.type.${auth.type}`));
  const columns = useConnectionColumns({
    packageId,
    authKey: "",
    authType: "custom",
    canRenew: false,
    userId: user?.id,
    isAdmin: canConfigure,
    authForConnection: (connection) => {
      const auth = detail.auths.find((item) => item.auth_key === connection.auth_key);
      return {
        authKey: connection.auth_key,
        authType: auth?.type ?? "custom",
        canRenew: auth?.type === "oauth2" && isOauthAuthConnectable(auth),
      };
    },
  });
  const displayColumns = [
    columns[0]!,
    {
      id: "method",
      header: t("integration.presentation.method"),
      width: "minmax(150px,1fr)" as const,
      cell: (connection: IntegrationConnection) => {
        const auth = detail.auths.find((item) => item.auth_key === connection.auth_key);
        return (
          <span className="text-muted-foreground text-xs">
            {auth ? labelFor(auth) : connection.auth_key}
          </span>
        );
      },
    },
    ...columns.slice(1),
  ];
  const rows = connections.filter((connection) => {
    const auth = detail.auths.find((item) => item.auth_key === connection.auth_key);
    return (
      `${connectionOptionLabel(connection)} ${connection.owner_name ?? ""} ${auth ? labelFor(auth) : ""}`
        .toLocaleLowerCase()
        .includes(search.trim().toLocaleLowerCase()) &&
      (sharing.length === 0 ||
        sharing.includes(connection.shared_with_org ? "shared" : "private")) &&
      (methods.length === 0 || methods.includes(connection.auth_key))
    );
  });
  return (
    <div data-testid="integration-connections-table">
      <ListToolbar
        placement="panel"
        panelFiltersAdjacent
        search={{
          value: search,
          onChange: setSearch,
          placeholder: t("detail.connectionsTable.search", { ns: "agents" }),
        }}
        filters={[
          {
            id: "sharing",
            label: t("integration.connection.col.shared"),
            values: sharing,
            options: [
              { value: "shared", label: t("detail.sharingShared", { ns: "agents" }) },
              { value: "private", label: t("detail.sharingPrivate", { ns: "agents" }) },
            ],
            onChange: setSharing,
          },
          ...(detail.auths.length > 1
            ? [
                {
                  id: "method",
                  label: t("integration.presentation.method"),
                  values: methods,
                  options: detail.auths.map((auth) => ({
                    value: auth.auth_key,
                    label: labelFor(auth),
                  })),
                  onChange: setMethods,
                },
              ]
            : []),
        ]}
        onReset={() => {
          setSearch("");
          setSharing([]);
          setMethods([]);
        }}
        actions={
          canConfigure || canConnect ? (
            <AddIntegrationConnection
              packageId={packageId}
              detail={detail}
              userId={user?.id}
              onConfigure={onConfigure}
              canConfigure={canConfigure}
              canConnect={canConnect}
            />
          ) : undefined
        }
      />
      <DataTable
        surface="integrated"
        columnMode="scroll"
        label={t("integration.connection.tableLabel")}
        columns={displayColumns}
        rows={rows}
        rowKey={(connection) => connection.id}
        empty={
          <EmptyState
            message={t(
              search || sharing.length || methods.length
                ? "integration.presentation.noMatch"
                : "integration.auth.noConnection",
            )}
            icon={Plug}
            compact
          />
        }
      />
    </div>
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
  const { data: pkg } = usePackageDetail("integration", packageId || undefined);
  const { data: integrations } = useIntegrations();
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
  const [storedTab, setTab] = useTabWithHash(INTEGRATION_TABS, "overview");
  // Keep legacy #about links useful without retaining a duplicate destination.
  const tab = storedTab === "about" ? "overview" : storedTab;
  const navigate = useNavigate();
  const location = useLocation();
  const openAuthentication = (authKey?: string) => {
    const params = new URLSearchParams(location.search);
    params.set("integrationSettings", authKey ? `auth:${authKey}` : "authentication");
    void navigate({ search: params.toString(), hash: "configuration" });
  };
  const openConnections = (authKey?: string) => {
    const params = new URLSearchParams(location.search);
    if (authKey) params.set("connectionMethod", authKey);
    else params.delete("connectionMethod");
    void navigate({ search: params.toString(), hash: "connections" });
  };
  const [forkOpen, setForkOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);

  // Versions moved into Paramètres › Explorer.
  if (storedTab === "versions") {
    const params = new URLSearchParams(location.search);
    params.set("integrationSettings", "versions");
    return <Navigate replace to={{ search: params.toString(), hash: "#configuration" }} />;
  }
  if (storedTab === "content" || storedTab === "tools") {
    const params = new URLSearchParams(location.search);
    params.set("integrationSettings", storedTab === "tools" ? "tools" : "files");
    return <Navigate replace to={{ search: params.toString(), hash: "#configuration" }} />;
  }

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={String(error)} />;
  if (!detail) return <ErrorState message={t("packages.detailNotFound")} />;

  const summary = integrations?.find((i) => i.id === packageId);
  const active = detail.active;
  const m = detail.manifest;
  const source = pkg?.source ?? summary?.source ?? "local";
  const version = pkg?.version ?? m.version;
  const isBuiltIn = source === "system";
  // Org-owned packages are editable regardless of scope name; only system packages are read-only.
  const isOwned = !isBuiltIn;
  const setActivation = (next: boolean, onSuccess?: () => void) => {
    if (!currentSpaceId) return;
    setActive.mutate(
      { spaceId: currentSpaceId, packageId, active: next },
      {
        onSuccess: () => {
          toast.success(
            t(next ? "integrations.activate.success" : "integrations.deactivate.success"),
          );
          onSuccess?.();
        },
        onError: () =>
          toast.error(t(next ? "integrations.activate.error" : "integrations.deactivate.error")),
      },
    );
  };
  const onActivate = () => setActivation(true);

  return (
    <div>
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
              labelledTrigger
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
              // The definition is edited in Paramètres › Définition.
              showEdit={false}
              canDeactivate={active}
              onDeactivate={() => setConfirmDeactivate(true)}
              activationPending={setActive.isPending}
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
        <DetailTabsList className="mt-6 mb-3">
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
            definition={isOwned && can("integrations:write") && pkg ? pkg : undefined}
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
            agents={pkg?.agents}
            onOpenConnections={openConnections}
            onConfigureAuth={canConfigure ? openAuthentication : undefined}
          />
        </TabsContent>
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
            onError: (err) =>
              toast.error(err instanceof Error ? err.message : t("packages.deleteDependedOn")),
          })
        }
      />
    </div>
  );
}
