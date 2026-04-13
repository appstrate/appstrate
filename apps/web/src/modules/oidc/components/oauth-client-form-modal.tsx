// SPDX-License-Identifier: Apache-2.0

/**
 * Dual-mode OAuth client modal (create + edit).
 *
 * - Create: form → SecretRevealModal (plaintext secret shown once)
 * - Edit: form → toast success → close
 *
 * Follows the ProxyFormModal pattern: outer shell with key-based remount,
 * inner body holding all form state.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Plus, X } from "lucide-react";
import { Modal } from "@/components/modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/spinner";
import { SecretRevealModal } from "@/components/secret-reveal-modal";
import { useAppForm } from "@/hooks/use-app-form";
import { usePermissions } from "@/hooks/use-permissions";
import {
  useCreateOAuthClient,
  useUpdateOAuthClient,
  useOAuthScopes,
  type OAuthClient,
  type SignupRole,
} from "../hooks/use-oauth-clients";

/** Role allowlist for org-level auto-provisioning. `owner` deliberately excluded. */
const SIGNUP_ROLE_OPTIONS: SignupRole[] = ["member", "admin", "viewer"];

/** Scopes that are always granted — cannot be unchecked in the UI. */
const REQUIRED_SCOPES = new Set(["openid", "profile", "email"]);

interface Props {
  open: boolean;
  onClose: () => void;
  client: OAuthClient | null;
  level?: "org" | "application";
}

interface FormData {
  name: string;
}

export function OAuthClientFormModal({ open, onClose, client, level }: Props) {
  if (!open) return null;
  const key = client?.clientId ?? "__create__";
  return <OAuthClientFormBody key={key} client={client} level={level} onClose={onClose} />;
}

function OAuthClientFormBody({
  client,
  level,
  onClose,
}: {
  client: OAuthClient | null;
  level?: "org" | "application";
  onClose: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const { isAdmin } = usePermissions();
  const isEditing = !!client;

  const effectiveLevel = client?.level === "instance" ? undefined : client?.level;
  const formLevel = effectiveLevel ?? level;
  const isOrgLevel = formLevel === "org";
  const createMutation = useCreateOAuthClient(effectiveLevel ?? level);
  const updateMutation = useUpdateOAuthClient();
  const { data: availableScopes } = useOAuthScopes();
  const isPending = createMutation.isPending || updateMutation.isPending;

  const [redirectUris, setRedirectUris] = useState<string[]>(() =>
    client?.redirectUris?.length ? [...client.redirectUris] : [""],
  );
  const [postLogoutRedirectUris, setPostLogoutRedirectUris] = useState<string[]>(() =>
    client?.postLogoutRedirectUris?.length ? [...client.postLogoutRedirectUris] : [""],
  );
  const [selectedScopes, setSelectedScopes] = useState<Set<string>>(
    () => new Set(client?.scopes?.length ? client.scopes : REQUIRED_SCOPES),
  );
  const [isFirstParty, setIsFirstParty] = useState(client?.isFirstParty ?? false);
  // Org-level auto-provisioning policy. Controls whether non-members of the
  // referenced organization are auto-joined on first sign-in, and with what
  // role. Ignored for application/instance clients (defaults kept but the UI
  // section stays hidden).
  const [allowSignup, setAllowSignup] = useState(client?.allowSignup ?? false);
  const [signupRole, setSignupRole] = useState<SignupRole>(client?.signupRole ?? "member");
  const [createdSecret, setCreatedSecret] = useState<{
    clientId: string;
    clientSecret: string;
  } | null>(null);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useAppForm<FormData>({
    defaultValues: { name: client?.name ?? "" },
  });

  function handleClose() {
    createMutation.reset();
    updateMutation.reset();
    onClose();
  }

  function toggleScope(scope: string) {
    if (REQUIRED_SCOPES.has(scope)) return;
    setSelectedScopes((prev) => {
      const next = new Set(prev);
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
      return next;
    });
  }

  /**
   * Derive a sensible post-logout redirect URI default from the first
   * redirect URI's origin. Called when the user blurs the post-logout
   * field while it's empty — pure suggestion, they can still edit.
   */
  function suggestPostLogoutFromRedirects(): void {
    const firstRedirect = redirectUris.find((u) => u.trim().length > 0);
    if (!firstRedirect) return;
    const alreadyFilled = postLogoutRedirectUris.some((u) => u.trim().length > 0);
    if (alreadyFilled) return;
    try {
      const origin = new URL(firstRedirect.trim()).origin;
      setPostLogoutRedirectUris([`${origin}/`]);
    } catch {
      // First redirect URI is not a valid URL — skip the suggestion.
    }
  }

  function validateUris(uris: string[]): string[] | null {
    for (const uri of uris) {
      try {
        const url = new URL(uri);
        if (url.protocol !== "https:" && url.hostname !== "localhost") {
          setError("root", { message: t("settings:oauthClients.httpsRequired") });
          return null;
        }
      } catch {
        setError("root", { message: t("settings:oauthClients.invalidUri") });
        return null;
      }
    }
    return uris;
  }

  function onSubmit(data: FormData) {
    const cleaned = redirectUris.map((u) => u.trim()).filter((u) => u.length > 0);
    if (cleaned.length === 0) {
      setError("root", { message: t("settings:oauthClients.redirectUrisRequired") });
      return;
    }
    if (!validateUris(cleaned)) return;

    const cleanedPostLogout = postLogoutRedirectUris
      .map((u) => u.trim())
      .filter((u) => u.length > 0);
    if (cleanedPostLogout.length > 0 && !validateUris(cleanedPostLogout)) return;

    if (isEditing) {
      updateMutation.mutate(
        {
          clientId: client!.clientId,
          data: {
            redirectUris: cleaned,
            postLogoutRedirectUris: cleanedPostLogout,
            scopes: Array.from(selectedScopes),
            ...(isAdmin ? { isFirstParty } : {}),
            // Signup policy is meaningful only on org-level clients; the
            // backend rejects these fields with a 400 on app/instance
            // clients, so we strictly gate on `isOrgLevel` here.
            ...(isOrgLevel ? { allowSignup, signupRole } : {}),
          },
        },
        {
          onSuccess: () => {
            toast.success(t("settings:oauthClients.updated"));
            handleClose();
          },
          onError: (err) => {
            setError("root", { message: err instanceof Error ? err.message : String(err) });
          },
        },
      );
    } else {
      createMutation.mutate(
        {
          name: data.name.trim(),
          redirectUris: cleaned,
          ...(cleanedPostLogout.length > 0 && { postLogoutRedirectUris: cleanedPostLogout }),
          scopes: Array.from(selectedScopes),
          ...(isFirstParty && { isFirstParty: true }),
          ...(isOrgLevel ? { allowSignup, signupRole } : {}),
        },
        {
          onSuccess: (result) => {
            setCreatedSecret({ clientId: result.clientId, clientSecret: result.clientSecret });
          },
          onError: (err) => {
            setError("root", { message: err instanceof Error ? err.message : String(err) });
          },
        },
      );
    }
  }

  // Create mode: show secret reveal after successful creation
  if (createdSecret) {
    return (
      <SecretRevealModal
        open
        onClose={handleClose}
        title={t("settings:oauthClients.createdTitle")}
        secret={`Client ID: ${createdSecret.clientId}\nClient Secret: ${createdSecret.clientSecret}`}
      />
    );
  }

  const title = isEditing
    ? t("settings:oauthClients.editTitle")
    : t("settings:oauthClients.createTitle");

  const submitLabel = isEditing ? t("common:btn.save") : t("settings:oauthClients.createBtn");

  return (
    <Modal
      open
      onClose={handleClose}
      title={title}
      actions={
        <>
          <Button variant="outline" type="button" onClick={handleClose}>
            {t("common:btn.cancel")}
          </Button>
          <Button type="submit" form="oauth-client-form" disabled={isPending}>
            {isPending ? <Spinner /> : submitLabel}
          </Button>
        </>
      }
    >
      <form id="oauth-client-form" onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="oauth-client-name">{t("settings:oauthClients.nameLabel")}</Label>
          <Input
            id="oauth-client-name"
            type="text"
            {...register("name", { required: !isEditing, maxLength: 200 })}
            placeholder={t("settings:oauthClients.namePlaceholder")}
            disabled={isEditing}
            autoFocus={!isEditing}
          />
          {isEditing && (
            <p className="text-muted-foreground text-xs">
              {t("settings:oauthClients.nameReadonlyHint")}
            </p>
          )}
          {errors.name && (
            <p className="text-destructive text-xs">{t("common:validation.required")}</p>
          )}
        </div>

        <UriListField
          label={t("settings:oauthClients.redirectUris")}
          hint={t("settings:oauthClients.redirectUrisHint")}
          uris={redirectUris}
          onChange={setRedirectUris}
          placeholder="https://example.com/oauth/callback"
          addLabel={t("settings:oauthClients.addRedirectUri")}
        />

        <UriListField
          label={t("settings:oauthClients.postLogoutRedirectUris")}
          hint={t("settings:oauthClients.postLogoutRedirectUrisHint")}
          uris={postLogoutRedirectUris}
          onChange={setPostLogoutRedirectUris}
          placeholder="https://example.com/"
          addLabel={t("settings:oauthClients.addRedirectUri")}
          onFirstInputFocus={isEditing ? undefined : suggestPostLogoutFromRedirects}
        />

        <div className="space-y-2">
          <Label>{t("settings:oauthClients.scopesLabel")}</Label>
          <p className="text-muted-foreground text-xs">{t("settings:oauthClients.scopesHint")}</p>
          <div className="flex flex-col gap-1.5">
            {(availableScopes ?? Array.from(REQUIRED_SCOPES)).map((scope) => {
              const required = REQUIRED_SCOPES.has(scope);
              const checked = selectedScopes.has(scope);
              return (
                <label key={scope} className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={required}
                    onChange={() => toggleScope(scope)}
                    className="accent-primary mt-0.5 h-4 w-4"
                  />
                  <span className="flex flex-col">
                    <span className="flex items-center gap-2">
                      <span>
                        {t(`oauthClients.scopeLabels.${scope}`, {
                          ns: "settings",
                          keySeparator: false,
                          nsSeparator: false,
                          defaultValue: scope,
                        })}
                      </span>
                      {required && (
                        <span className="text-muted-foreground text-xs">
                          ({t("settings:oauthClients.scopeRequired")})
                        </span>
                      )}
                    </span>
                    <span className="text-muted-foreground font-mono text-xs">{scope}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </div>

        {isAdmin && (
          <div className="space-y-2">
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={isFirstParty}
                onChange={() => setIsFirstParty((v) => !v)}
                className="accent-primary mt-0.5 h-4 w-4"
              />
              <span className="flex flex-col">
                <span>{t("settings:oauthClients.isFirstPartyLabel")}</span>
                <span className="text-muted-foreground text-xs">
                  {t("settings:oauthClients.isFirstPartyHint")}
                </span>
              </span>
            </label>
          </div>
        )}

        {isOrgLevel && (
          <div className="space-y-3 rounded-md border p-3">
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={allowSignup}
                onChange={() => setAllowSignup((v) => !v)}
                className="accent-primary mt-0.5 h-4 w-4"
              />
              <span className="flex flex-col">
                <span>{t("settings:oauthClients.allowSignupLabel")}</span>
                <span className="text-muted-foreground text-xs">
                  {t("settings:oauthClients.allowSignupHint")}
                </span>
              </span>
            </label>
            <div className="space-y-1">
              <Label htmlFor="oauth-client-signup-role">
                {t("settings:oauthClients.signupRoleLabel")}
              </Label>
              <select
                id="oauth-client-signup-role"
                value={signupRole}
                onChange={(e) => setSignupRole(e.target.value as SignupRole)}
                disabled={!allowSignup}
                className="border-input bg-background ring-offset-background focus-visible:ring-ring flex h-9 w-full rounded-md border px-3 py-1 text-sm shadow-sm focus-visible:ring-1 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
              >
                {SIGNUP_ROLE_OPTIONS.map((role) => (
                  <option key={role} value={role}>
                    {t(`settings:oauthClients.signupRoleOption.${role}`)}
                  </option>
                ))}
              </select>
              <p className="text-muted-foreground text-xs">
                {t("settings:oauthClients.signupRoleHint")}
              </p>
            </div>
          </div>
        )}

        {errors.root && <p className="text-destructive text-sm">{errors.root.message}</p>}
      </form>
    </Modal>
  );
}

/** Reusable URI list field with add/remove controls. */
function UriListField({
  label,
  hint,
  uris,
  onChange,
  placeholder,
  addLabel,
  onFirstInputFocus,
}: {
  label: string;
  hint: string;
  uris: string[];
  onChange: (uris: string[]) => void;
  placeholder: string;
  addLabel: string;
  /**
   * Called when the first input receives focus while empty. Used to offer
   * a suggested default (e.g. derive post-logout URI from redirect URI
   * origin) without forcing a value on the user.
   */
  onFirstInputFocus?: () => void;
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <p className="text-muted-foreground text-xs">{hint}</p>
      <div className="flex flex-col gap-2">
        {uris.map((uri, index) => (
          <div key={index} className="flex gap-2">
            <Input
              type="url"
              value={uri}
              onChange={(e) => {
                const next = [...uris];
                next[index] = e.target.value;
                onChange(next);
              }}
              onFocus={
                index === 0 && uri.trim().length === 0 && onFirstInputFocus
                  ? onFirstInputFocus
                  : undefined
              }
              placeholder={placeholder}
            />
            {uris.length > 1 && (
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => onChange(uris.filter((_, i) => i !== index))}
              >
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" onClick={() => onChange([...uris, ""])}>
          <Plus className="h-4 w-4" /> {addLabel}
        </Button>
      </div>
    </div>
  );
}
