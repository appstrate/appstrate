// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Check, KeyRound, Pencil, X } from "lucide-react";
import { Badge } from "@appstrate/ui/components/badge";
import { Button } from "@appstrate/ui/components/button";
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@appstrate/ui/components/select";
import { $api } from "../../api/client";
import { ConfirmModal } from "../../components/confirm-modal";
import { Modal } from "../../components/modal";
import { OAuthPairingBody } from "../../components/oauth-pairing-body";
import { EmptyState, ErrorState, LoadingState } from "../../components/page-states";
import { Spinner } from "../../components/spinner";
import { PROVIDER_ICONS } from "../../components/icons";
import {
  useCreateModelProviderCredential,
  useDeleteModelProviderCredential,
  useUpdateModelProviderCredential,
  type ModelProviderCredentialInfo,
  type ProviderRegistryEntry,
} from "../../hooks/use-model-provider-credentials";
import { useModels } from "../../hooks/use-models";
import { useAppForm } from "../../hooks/use-app-form";
import { useAuth } from "../../hooks/use-auth";
import { useOrgOnlyScope } from "../../hooks/use-org-scope";
import { usePairingDismissConfirm } from "../../hooks/use-pairing-dismiss-confirm";
import { usePermissions } from "../../hooks/use-permissions";
import { formatDateField } from "../../lib/format-date";
import { errorMessage } from "../../lib/mutation-error";
import { quickConnectProviders, resolveProviderEntry } from "../../lib/provider-registry-helpers";

// ─────────────────────────────────────────────
// Pure helpers (pinned by pages/test/preferences-models.test.ts)
// ─────────────────────────────────────────────

/** Providers a personal API key can be added for: key-based, never a custom endpoint. */
export function personalApiKeyProviders<
  T extends { authMode: "api_key" | "oauth2"; baseUrlOverridable: boolean },
>(registry: readonly T[]): T[] {
  return registry.filter((p) => p.authMode === "api_key" && !p.baseUrlOverridable);
}

/** The caller's own personal credentials, out of an org-wide list (a reader gets every member's). */
export function ownPersonalCredentials<
  T extends { owner_type: "org" | "user"; owner_id: string | null },
>(credentials: readonly T[], userId: string | undefined): T[] {
  if (!userId) return [];
  return credentials.filter((c) => c.owner_type === "user" && c.owner_id === userId);
}

/** The organization models the caller's own credentials pay for (`billed_to` is computed for the caller). */
export function modelsPaidByCaller<T extends { billed_to: "user" | "org" | null }>(
  models: readonly T[],
): T[] {
  return models.filter((m) => m.billed_to === "user");
}

/** Body of a personal API-key credential: owned by the caller, so the server refuses a custom endpoint. */
export function personalApiKeyBody(input: { providerId: string; label: string; apiKey: string }) {
  return {
    providerId: input.providerId,
    label: input.label,
    api_key: input.apiKey,
    owner_type: "user" as const,
  };
}

// ─────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────

/** Every credential the caller may see: all of the org for a reader, own personal ones for `connect` only. */
function useCredentialList(enabled: boolean) {
  const scope = useOrgOnlyScope();
  return $api.useQuery(
    "get",
    "/api/model-provider-credentials",
    { params: { header: scope.header } },
    { enabled: scope.enabled && enabled, select: (e) => e.data },
  );
}

/**
 * The registry, read under `connect` too: `useProvidersRegistry` gates on `read`,
 * which a member does not hold, so the picker would stay empty for them.
 */
function usePersonalRegistry(enabled: boolean) {
  const scope = useOrgOnlyScope();
  return $api.useQuery(
    "get",
    "/api/model-provider-credentials/registry",
    { params: { header: scope.header } },
    {
      enabled: scope.enabled && enabled,
      staleTime: 5 * 60 * 1000,
      select: (e) => e.data as ProviderRegistryEntry[],
    },
  );
}

// ─────────────────────────────────────────────
// Inline label edit (same behaviour as the connection label editor)
// ─────────────────────────────────────────────

function LabelEditor({
  current,
  saving,
  onSave,
}: {
  current: string;
  saving: boolean;
  /** Calls `onSuccess` once saved: a refused label stays open to fix. */
  onSave: (next: string, onSuccess: () => void) => void;
}) {
  const { t } = useTranslation("settings");
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(current);

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          setValue(current);
          setEditing(true);
        }}
        className="text-foreground inline-flex items-center gap-1.5 text-sm font-medium"
        title={t("credentials.edit")}
      >
        <span>{current}</span>
        <Pencil className="text-muted-foreground h-3 w-3" />
      </button>
    );
  }

  const commit = () => {
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed === current) setEditing(false);
    else onSave(trimmed, () => setEditing(false));
  };

  return (
    <div className="flex items-center gap-1">
      <Input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setEditing(false);
        }}
        className="h-7 w-44 text-xs"
        disabled={saving}
        placeholder={t("modelCredentials.labelPlaceholder")}
      />
      <Button size="icon" variant="ghost" className="h-6 w-6" onClick={commit} disabled={saving}>
        <Check className="h-3 w-3" />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="h-6 w-6"
        onClick={() => setEditing(false)}
        disabled={saving}
      >
        <X className="h-3 w-3" />
      </Button>
    </div>
  );
}

// ─────────────────────────────────────────────
// Credential row
// ─────────────────────────────────────────────

function CredentialRow({
  credential,
  registry,
  editable,
  saving,
  onRename,
  onDelete,
}: {
  credential: ModelProviderCredentialInfo;
  registry: readonly ProviderRegistryEntry[];
  editable: boolean;
  saving: boolean;
  onRename: (label: string, onSuccess: () => void) => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  // Inline lookup, as `react-hooks/static-components` requires (see credential-form-modal).
  const ProviderIcon = PROVIDER_ICONS[resolveProviderEntry(credential, registry)?.iconUrl ?? ""];
  const isOauth = credential.authMode === "oauth2";

  return (
    <div
      className="border-border bg-card flex items-start justify-between gap-4 rounded-md border p-3"
      data-testid={`model-credential-row-${credential.id}`}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          {ProviderIcon && <ProviderIcon className="text-muted-foreground size-4 shrink-0" />}
          {editable ? (
            <LabelEditor current={credential.label} saving={saving} onSave={onRename} />
          ) : (
            <span className="text-sm font-medium">{credential.label}</span>
          )}
          <Badge variant="secondary">
            {isOauth ? t("credentials.oauth.badgeOauth") : t("credentials.form.apiKey")}
          </Badge>
          {credential.needs_reconnection && (
            <Badge variant="destructive">
              {isOauth
                ? t("credentials.oauth.needsReconnection")
                : t("models.credentialUnavailable")}
            </Badge>
          )}
        </div>
        {isOauth && credential.oauth_email && (
          <span className="text-muted-foreground text-xs">
            {t("credentials.oauth.connectedAs", { email: credential.oauth_email })}
          </span>
        )}
        {credential.createdAt && (
          <span className="text-muted-foreground text-xs">
            {t("connections.connectedAtLabel")} {formatDateField(credential.createdAt)}
          </span>
        )}
      </div>
      {editable && (
        <Button
          variant="destructive"
          size="sm"
          className="shrink-0"
          onClick={onDelete}
          disabled={saving}
        >
          {t("credentials.delete")}
        </Button>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// API key modal
// ─────────────────────────────────────────────

interface ApiKeyFields {
  label: string;
  apiKey: string;
}

function ApiKeyModal({
  open,
  onClose,
  providers,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  providers: ProviderRegistryEntry[];
  onCreated: () => void;
}) {
  // Re-mounted on every opening, so the form starts empty.
  if (!open) return null;
  return <ApiKeyForm onClose={onClose} providers={providers} onCreated={onCreated} />;
}

function ApiKeyForm({
  onClose,
  providers,
  onCreated,
}: {
  onClose: () => void;
  providers: ProviderRegistryEntry[];
  onCreated: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const [providerId, setProviderId] = useState(providers[0]?.providerId ?? "");
  const createCredential = useCreateModelProviderCredential();
  const {
    register,
    handleSubmit,
    showError,
    formState: { errors },
  } = useAppForm<ApiKeyFields>({ defaultValues: { label: "", apiKey: "" } });
  const required = (v: string) =>
    !v.trim() ? t("validation.required", { ns: "common" }) : undefined;

  const onFormSubmit = handleSubmit((data) => {
    if (!providerId) return;
    createCredential.mutate(
      {
        body: personalApiKeyBody({
          providerId,
          label: data.label.trim(),
          apiKey: data.apiKey.trim(),
        }),
      },
      {
        onSuccess: () => {
          onCreated();
          onClose();
        },
      },
    );
  });

  return (
    <Modal
      open
      onClose={onClose}
      title={t("modelCredentials.apiKeyTitle")}
      actions={
        <>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("btn.cancel", { ns: "common" })}
          </Button>
          <Button type="submit" form="pmc-api-key-form" disabled={createCredential.isPending}>
            {createCredential.isPending ? <Spinner /> : t("btn.save", { ns: "common" })}
          </Button>
        </>
      }
    >
      <form id="pmc-api-key-form" onSubmit={onFormSubmit} noValidate className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="pmc-provider">{t("credentials.form.provider")}</Label>
          <Select value={providerId} onValueChange={setProviderId}>
            <SelectTrigger id="pmc-provider">
              <SelectValue placeholder={t("models.form.providerPlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              {providers.map((p) => {
                const Icon = PROVIDER_ICONS[p.iconUrl];
                return (
                  <SelectItem key={p.providerId} value={p.providerId}>
                    <span className="flex items-center gap-2">
                      {Icon && <Icon className="size-4" />}
                      {p.displayName}
                    </span>
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="pmc-label">{t("credentials.form.label")}</Label>
          <Input
            id="pmc-label"
            type="text"
            {...register("label", { validate: required })}
            placeholder={t("modelCredentials.labelPlaceholder")}
            aria-invalid={showError("label") ? true : undefined}
          />
          {showError("label") && errors.label?.message && (
            <div className="text-destructive text-sm">{errors.label.message}</div>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="pmc-api-key">{t("credentials.form.apiKey")}</Label>
          <Input
            id="pmc-api-key"
            type="password"
            {...register("apiKey", { validate: required })}
            placeholder="sk-..."
            aria-invalid={showError("apiKey") ? true : undefined}
          />
          <p className="text-muted-foreground text-xs">{t("modelCredentials.apiKeyHint")}</p>
          {showError("apiKey") && errors.apiKey?.message && (
            <div className="text-destructive text-sm">{errors.apiKey.message}</div>
          )}
        </div>
      </form>
    </Modal>
  );
}

// ─────────────────────────────────────────────
// Subscription (OAuth pairing) modal
// ─────────────────────────────────────────────

function SubscriptionModal({
  open,
  onClose,
  providers,
}: {
  open: boolean;
  onClose: () => void;
  providers: ProviderRegistryEntry[];
}) {
  if (!open) return null;
  return <SubscriptionPairing onClose={onClose} providers={providers} />;
}

function SubscriptionPairing({
  onClose,
  providers,
}: {
  onClose: () => void;
  providers: ProviderRegistryEntry[];
}) {
  const { t } = useTranslation(["settings", "common"]);
  const [providerId, setProviderId] = useState(providers[0]?.providerId ?? "");
  const dismiss = usePairingDismissConfirm(onClose);

  return (
    <>
      <Modal
        open
        onClose={dismiss.requestClose}
        title={t("modelCredentials.subscriptionTitle")}
        actions={
          <Button type="button" variant="outline" onClick={dismiss.requestClose}>
            {t("credentials.oauth.close")}
          </Button>
        }
      >
        <div className="space-y-4">
          <p className="text-muted-foreground text-sm">{t("modelCredentials.subscriptionHint")}</p>
          {providers.length > 1 && (
            <div className="space-y-2">
              <Label htmlFor="pmc-subscription">{t("credentials.form.provider")}</Label>
              <Select value={providerId} onValueChange={setProviderId}>
                <SelectTrigger id="pmc-subscription">
                  <SelectValue placeholder={t("models.form.providerPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {providers.map((p) => (
                    <SelectItem key={p.providerId} value={p.providerId}>
                      {p.displayName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {providerId && (
            <OAuthPairingBody
              key={providerId}
              providerId={providerId}
              onConnected={() => onClose()}
              onBusyChange={dismiss.onBusyChange}
            />
          )}
        </div>
      </Modal>
      {dismiss.confirmDialog}
    </>
  );
}

// ─────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────

export function PreferencesModelsPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { can } = usePermissions();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const canConnect = can("model-provider-credentials:connect");
  const canList = canConnect || can("model-provider-credentials:read");
  const credentialsQuery = useCredentialList(canList);
  const registryQuery = usePersonalRegistry(canConnect);
  const modelsQuery = useModels();
  const updateCredential = useUpdateModelProviderCredential();
  const deleteCredential = useDeleteModelProviderCredential();

  const [apiKeyOpen, setApiKeyOpen] = useState(false);
  const [subscriptionOpen, setSubscriptionOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<ModelProviderCredentialInfo | null>(null);

  if (credentialsQuery.isLoading) return <LoadingState />;
  if (credentialsQuery.error) return <ErrorState error={credentialsQuery.error} />;

  const registry = registryQuery.data ?? [];
  const apiKeyProviders = personalApiKeyProviders(registry);
  const subscriptionProviders = quickConnectProviders(registry);
  const credentials = ownPersonalCredentials(credentialsQuery.data ?? [], user?.id);
  const paidByCaller = modelsPaidByCaller(modelsQuery.data ?? []);

  // A credential's add, rename or delete changes which models the caller pays for.
  const refreshModels = () => {
    void queryClient.invalidateQueries({ queryKey: ["get", "/api/models"] });
  };

  const addButtons = canConnect ? (
    <>
      {apiKeyProviders.length > 0 && (
        <Button onClick={() => setApiKeyOpen(true)}>{t("modelCredentials.add")}</Button>
      )}
      {subscriptionProviders.length > 0 && (
        <Button variant="outline" onClick={() => setSubscriptionOpen(true)}>
          {t("modelCredentials.connect")}
        </Button>
      )}
    </>
  ) : null;

  return (
    <>
      <p className="text-muted-foreground mb-4 text-sm">{t("modelCredentials.description")}</p>

      {credentials.length > 0 ? (
        <>
          {canConnect && (
            <div className="mb-4 flex flex-wrap items-center justify-end gap-2">{addButtons}</div>
          )}
          <div className="flex flex-col gap-3">
            {credentials.map((credential) => (
              <CredentialRow
                key={credential.id}
                credential={credential}
                registry={registry}
                editable={canConnect}
                saving={updateCredential.isPending || deleteCredential.isPending}
                onRename={(label, onSuccess) =>
                  updateCredential.mutate(
                    { params: { path: { id: credential.id } }, body: { label } },
                    { onSuccess },
                  )
                }
                onDelete={() => setConfirmDelete(credential)}
              />
            ))}
          </div>
        </>
      ) : (
        <EmptyState
          message={t("modelCredentials.empty")}
          hint={t("modelCredentials.emptyHint")}
          icon={KeyRound}
          compact
        >
          {addButtons}
        </EmptyState>
      )}

      <div className="border-border bg-card mt-6 rounded-lg border p-5">
        <h3 className="text-sm font-medium">{t("modelCredentials.billedTitle")}</h3>
        {modelsQuery.error ? (
          <p className="text-destructive mt-2 text-xs">{errorMessage(modelsQuery.error)}</p>
        ) : paidByCaller.length > 0 ? (
          <ul className="mt-3 flex flex-col gap-1.5">
            {paidByCaller.map((m) => (
              <li key={m.id} className="text-sm">
                {m.label}
                {m.provider_name && (
                  <span className="text-muted-foreground text-xs"> · {m.provider_name}</span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground mt-2 text-sm">{t("modelCredentials.billedNone")}</p>
        )}
      </div>

      <ApiKeyModal
        open={apiKeyOpen}
        onClose={() => setApiKeyOpen(false)}
        providers={apiKeyProviders}
        onCreated={refreshModels}
      />
      <SubscriptionModal
        open={subscriptionOpen}
        onClose={() => {
          setSubscriptionOpen(false);
          refreshModels();
        }}
        providers={subscriptionProviders}
      />

      <ConfirmModal
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        title={t("btn.confirm", { ns: "common" })}
        description={
          confirmDelete ? t("modelCredentials.deleteConfirm", { label: confirmDelete.label }) : ""
        }
        isPending={deleteCredential.isPending}
        onConfirm={() => {
          if (!confirmDelete) return;
          deleteCredential.mutate(
            { params: { path: { id: confirmDelete.id } } },
            {
              onSuccess: () => {
                setConfirmDelete(null);
                refreshModels();
              },
            },
          );
        }}
      >
        <p className="text-muted-foreground text-sm">{t("modelCredentials.deleteImpact")}</p>
      </ConfirmModal>
    </>
  );
}
