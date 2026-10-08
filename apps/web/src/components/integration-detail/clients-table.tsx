// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Trash2, Plus, Pencil, ArrowUpFromLine } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";
import { Checkbox } from "@appstrate/ui/components/checkbox";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@appstrate/ui/components/tooltip";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@appstrate/ui/components/table";
import { CopyBlock } from "../copy-block";
import { CallbackUrlHint } from "../package-detail/callback-url-hint";
import { ConfirmModal } from "../confirm-modal";
import { Modal } from "../modal";
import { SourceBadge } from "../source-badge";
import { DefaultCell } from "../default-cell";
import { usePermissions } from "../../hooks/use-permissions";
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
 * The admin hub for an auth's OAuth clients: every client that can mint a
 * connection — the platform's system client(s) (`SYSTEM_INTEGRATIONS`,
 * read-only) plus N custom (BYO-app) clients — with which is the
 * default. Multi-client: an admin registers as many custom clients as needed,
 * edits or deletes each by id, and picks the default (the model-provider
 * pattern). Auto-provisioned (remote MCP DCR/CIMD) auths keep ONE machine
 * client, shown read-only with a delete action that re-triggers registration;
 * a manual escape hatch (opt-in) covers the rare server needing a pre-registered
 * public client. Secrets are never returned by the endpoint. `tier` picks the
 * routes; only the tier's own rows are editable.
 */
export function ClientsTable({
  tier,
  packageId,
  authKey,
  authDecl,
  autoProvisioned,
}: {
  tier: IntegrationClientTier;
  packageId: string;
  authKey: string;
  authDecl?: IntegrationManifestAuth;
  autoProvisioned: boolean;
}) {
  const { t } = useTranslation("settings");
  const { data: clients } = useIntegrationClients(tier, packageId, authKey);
  // Read from the same query key the page already holds, rather than threading
  // the value down through `ConfigAuthBlock`, which would carry a prop it never
  // reads. React Query dedupes, so this costs no request.
  const { data: detail } = useIntegrationDetail(packageId);
  const platformRedirectUri = detail?.platform_redirect_uri ?? "";
  const setDefault = useSetDefaultIntegrationClient(tier);
  const del = useDeleteIntegrationOAuthClient(tier);
  const promote = usePromoteIntegrationOAuthClient();
  const { can } = usePermissions();
  const [modal, setModal] = useState<
    { mode: "create" } | { mode: "edit"; client: IntegrationClient } | null
  >(null);
  const [confirmDelete, setConfirmDelete] = useState<IntegrationClient | null>(null);
  const [confirmPromote, setConfirmPromote] = useState<IntegrationClient | null>(null);
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
  const canChooseDefault = rows.length > 1;
  // An org row shows in both tables on the page: prefix the org table's test ids.
  const tid = (id: string) => (tier === "space" ? id : `org-${id}`);
  const hasAutoClient = rows.some((c) => c.auto_provisioned);
  // Classic auths always allow registering more custom clients; auto-provisioned
  // auths only via the opt-in escape hatch (and only when none is registered yet).
  const canRegister = !autoProvisioned || (showManual && !hasAutoClient);
  // Auto-provisioned auths have no org tier (their clients are per space).
  const canPromote = tier === "space" && !autoProvisioned && can("org-integrations:configure");

  return (
    <div
      className={tier === "space" ? "mb-3" : "mt-4 mb-3 border-t pt-4"}
      data-testid={tid(`oauth-clients-list-${authKey}`)}
    >
      {/* Registering this exact string on the provider's OAuth app is a
          prerequisite to the FIRST connect attempt, so it is shown before the
          clients table rather than only inside the registration modal — an
          admin setting the app up at the provider needs it before there is any
          client to register. Once per auth: the org table follows this one. */}
      {tier === "space" && (
        <div className="mb-3 space-y-1">
          <p className="text-muted-foreground text-xs font-semibold">
            {t("integration.oauthClient.platformRedirectUri")}
          </p>
          <CopyBlock value={effectiveRedirectUri} testId={`platform-redirect-uri-${authKey}`} />
        </div>
      )}

      <div className="mb-2 flex items-center justify-between gap-2">
        <h4 className="text-muted-foreground text-xs font-semibold">
          {tier === "space" ? t("integration.clients.title") : t("integration.clients.orgTitle")}
        </h4>
        {canRegister && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => setModal({ mode: "create" })}
            data-testid={tid(`oauth-client-register-${authKey}`)}
          >
            <Plus size={14} />
            {t("integration.clients.register")}
          </Button>
        )}
      </div>

      {tier === "org" && (
        <p className="text-muted-foreground mb-2 text-xs">{t("integration.clients.orgHint")}</p>
      )}
      {tier === "space" && rows.some((c) => c.source === "org") && (
        <p className="text-muted-foreground mb-2 text-xs">
          {t("integration.clients.inheritedOrgHint")}
        </p>
      )}

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
                const deletable = client.source === tier;
                const editable = deletable && !client.auto_provisioned;
                return (
                  <TableRow
                    key={client.client_ref}
                    data-testid={tid(`oauth-client-row-${client.client_ref}`)}
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
                        testId={tid(`set-default-client-${client.client_ref}`)}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        {editable && canPromote && (
                          <TooltipProvider delayDuration={300}>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 w-7 p-0"
                                  onClick={() => setConfirmPromote(client)}
                                  disabled={promote.isPending}
                                  data-testid={`oauth-client-promote-${client.client_ref}`}
                                  aria-label={t("integration.clients.promote.action")}
                                >
                                  <ArrowUpFromLine size={14} />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>
                                {t("integration.clients.promote.action")}
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        )}
                        {editable && (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-7 w-7 p-0"
                            onClick={() => setModal({ mode: "edit", client })}
                            data-testid={tid(`oauth-client-edit-${client.client_ref}`)}
                            aria-label={t("integration.oauthClient.btnEdit")}
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
                            data-testid={tid(`oauth-client-delete-${client.client_ref}`)}
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
          key={modal.mode === "edit" ? modal.client.client_ref : "create"}
          tier={tier}
          packageId={packageId}
          authKey={authKey}
          authDecl={authDecl}
          mode={modal.mode}
          existing={modal.mode === "edit" ? modal.client : undefined}
          platformRedirectUri={platformRedirectUri}
          onClose={() => setModal(null)}
        />
      )}
      <ConfirmModal
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        title={t("btn.confirm", { ns: "common" })}
        description={
          tier === "space"
            ? t("integration.oauthClient.delete.confirm")
            : t("integration.oauthClient.delete.confirmOrg")
        }
        isPending={del.isPending}
        onConfirm={() => {
          if (!confirmDelete) return;
          del.mutate(
            { params: { path: { packageId, clientId: confirmDelete.client_ref } } },
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
            { params: { path: { packageId, clientId: confirmPromote.client_ref } } },
            { onSuccess: () => setConfirmPromote(null) },
          );
        }}
      />
    </div>
  );
}
