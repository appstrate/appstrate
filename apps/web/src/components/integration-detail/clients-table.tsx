// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, KeyRound, Plus } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";
import { Checkbox } from "@appstrate/ui/components/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@appstrate/ui/components/dropdown-menu";
import { CopyBlock } from "../copy-block";
import { CallbackUrlHint } from "../package-detail/callback-url-hint";
import { ConfirmModal } from "../confirm-modal";
import { Modal } from "../modal";
import { DataTable } from "../data-table";
import { EmptyState, ErrorState } from "../page-states";
import { usePermissions } from "../../hooks/use-permissions";
import { useModalParam } from "../../hooks/use-modal-param";
import { useIntegrationClientColumns } from "../../pages/integration-columns";
import { mergeClientTiers, type ClientRow } from "../../lib/integration-clients";
import {
  useIntegrationDetail,
  useIntegrationClients,
  useSetDefaultIntegrationClient,
  useCreateIntegrationOAuthClient,
  useUpdateIntegrationOAuthClient,
  useDeleteIntegrationOAuthClient,
  usePromoteIntegrationOAuthClient,
  type IntegrationClient,
  type IntegrationClientTier,
  type IntegrationManifestAuth,
} from "../../hooks/use-integrations";

// ─────────────────────────────────────────────
// OAuth client (admin) — create / edit modal
// ─────────────────────────────────────────────

/**
 * Register a new custom OAuth client (`mode: "create"`) or edit an existing
 * one in place (`mode: "edit"`, preloaded from its descriptor). The parent
 * mounts this only while open, keyed by mode+clientRef, so field state resets
 * cleanly between invocations. The client secret is write-only — never echoed
 * back, shown as a placeholder when one is already set.
 */
type ModalState =
  | { mode: "create"; tier: IntegrationClientTier }
  | { mode: "edit"; tier: IntegrationClientTier; client: IntegrationClient }
  | null;

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
  mode: "create" | "edit";
  existing?: IntegrationClient;
  platformRedirectUri: string;
  onClose: () => void;
}) {
  const { t } = useTranslation("settings");
  const create = useCreateIntegrationOAuthClient(tier);
  const update = useUpdateIntegrationOAuthClient(tier);
  const pending = mode === "create" ? create.isPending : update.isPending;
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
  // An edit is exempt: there an untouched secret field means PRESERVE.
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
    // from a blank secret. And on an edit an untouched secret field is OMITTED
    // rather than sent as `""` — sending it would clear the stored credential
    // and flip a confidential client public, for an edit that only meant to
    // change the redirect URI.
    const method = publicClient ? { token_endpoint_auth_method: "none" as const } : {};
    if (mode === "create") {
      // A public client declares itself with `token_endpoint_auth_method: none`
      // and sends NO secret; a confidential one sends the typed secret. Neither
      // branch ships a blank the server would have to interpret.
      const common = {
        client_id: clientId,
        ...method,
        ...(redirectUri ? { redirect_uri: redirectUri } : {}),
      };
      const body = publicClient ? common : { ...common, client_secret: clientSecret };
      create.mutate({ params: { path: { packageId, authKey } }, body }, { onSuccess: onClose });
    } else {
      // PATCH: `client_id` is immutable and never sent; a cleared redirect URI
      // is `null`; an untouched secret field is OMITTED rather than sent as `""`.
      const body = {
        ...method,
        redirect_uri: redirectUri || null,
        ...(publicClient
          ? { client_secret: "" }
          : clientSecret
            ? { client_secret: clientSecret }
            : {}),
      };
      update.mutate(
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
          : t("integration.oauthClient.modalEditTitle")
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
            disabled={mode === "edit"}
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
              : t("integration.oauthClient.btnEdit")}
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
 * organisation's; edits or deletes each; and picks the one in use (the
 * model-provider pattern). Auto-provisioned (remote MCP DCR/CIMD) auths have no
 * organisation level and keep ONE machine client, shown read-only with a delete
 * action that re-triggers registration; a manual escape hatch (opt-in) covers
 * the rare server needing a pre-registered public client. Secrets are never
 * returned by the endpoint.
 */
export function ClientsTable({
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
  // Several tables can share a page (one per auth): each answers only the parameters
  // scoped to its own `authKey` (`?newOauthClient=<authKey>:<tier>`,
  // `?editOauthClient=<authKey>:<client_ref>`).
  const newClient = useModalParam("newOauthClient");
  const editClient = useModalParam("editOauthClient");
  const scopedValue = (value: string | null) =>
    value?.startsWith(`${authKey}:`) ? value.slice(authKey.length + 1) : null;
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
  const editedRow = rows.find((row) => row.client.client_ref === scopedValue(editClient.value));
  const newTier = scopedValue(newClient.value);
  const modal: ModalState = editedRow
    ? { mode: "edit", tier: tierOf(editedRow), client: editedRow.client }
    : newTier === "space" || newTier === "org"
      ? { mode: "create", tier: newTier }
      : null;
  const closeModal = editedRow ? editClient.close : newClient.close;
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
    onEdit: (row) => editClient.open(`${authKey}:${row.client.client_ref}`),
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
                <DropdownMenuItem onSelect={() => newClient.open(`${authKey}:space`)}>
                  {t("integration.clients.registerSpace")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => newClient.open(`${authKey}:org`)}
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
              onClick={() => newClient.open(`${authKey}:space`)}
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
        error={<ErrorState error={spaceClients.error} compact />}
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
          key={modal.mode === "edit" ? modal.client.client_ref : `create-${modal.tier}`}
          tier={modal.tier}
          packageId={packageId}
          authKey={authKey}
          authDecl={authDecl}
          mode={modal.mode}
          existing={modal.mode === "edit" ? modal.client : undefined}
          platformRedirectUri={platformRedirectUri}
          onClose={closeModal}
        />
      )}
      <ConfirmModal
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        title={t("integration.oauthClient.delete.title")}
        confirmLabel={t("btn.delete", { ns: "common" })}
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
