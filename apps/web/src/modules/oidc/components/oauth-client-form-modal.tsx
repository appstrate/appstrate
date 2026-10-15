// SPDX-License-Identifier: Apache-2.0

/**
 * Dual-mode OAuth client modal (create + edit).
 *
 * - Create: form → `onCreated` hands the plaintext secret to the host, which shows it once
 * - Edit: form → toast success → close
 *
 * Mounted by the host while open, one per client (`key`).
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { FormModal } from "@/components/form-modal";
import { RowsEditor } from "@/components/rows-editor";
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";
import { CheckboxField } from "@appstrate/ui/components/checkbox";
import { FormItem } from "@appstrate/ui/components/field";
import { OptionSelect } from "@appstrate/ui/components/select";
import { useAppForm } from "@/hooks/use-app-form";
import { SpaceAssignmentsField } from "@/components/space-assignments-field";
import { useAssignmentCatalog } from "@/hooks/use-assignment-catalog";
import { spaceRoleValue, type SpaceRoleOption } from "@/hooks/use-roles";
import {
  hasUnavailableAssignments,
  assignmentsFor,
  toSpaceAssignments,
  type AssignmentDraft,
} from "@/lib/space-assignments";
import { usePermissions } from "@/hooks/use-permissions";
import {
  useCreateOAuthClient,
  useUpdateOAuthClient,
  useOAuthScopes,
  type OAuthClient,
} from "../hooks/use-oauth-clients";
import { ASSIGNABLE_ORG_ROLES, type AssignableOrgRole } from "@appstrate/shared-types";
import { looksLoopback } from "../lib/redirect-uri";
import { errorMessage } from "../../../lib/mutation-error";

/** Scopes that are always granted — cannot be unchecked in the UI. */
const REQUIRED_SCOPES = new Set(["openid", "profile", "email"]);

interface Props {
  onClose: () => void;
  client: OAuthClient | null;
  level?: "org" | "space";
  onCreated: (secret: CreatedSecret) => void;
}

interface FormData {
  name: string;
}

export type CreatedSecret = { clientId: string; clientSecret: string };

export function OAuthClientFormModal({ client, level, onClose, onCreated }: Props) {
  const { t } = useTranslation(["settings", "common"]);
  const { can } = usePermissions();
  const isEditing = !!client;

  const effectiveLevel = client?.level === "instance" ? undefined : client?.level;
  const formLevel = effectiveLevel ?? level;
  const isOrgLevel = formLevel === "org";
  // Either catalog feeds the org signup policy only.
  const catalog = useAssignmentCatalog(isOrgLevel);
  const isSpaceLevel = formLevel === "space";
  const createMutation = useCreateOAuthClient(effectiveLevel ?? level);
  const updateMutation = useUpdateOAuthClient({ errorHandledByCaller: true });
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
  // Unified signup opt-in (instance/org/space). Secure-by-default:
  // brand-new clients start with the flag off. On org-level clients the
  // `signupRole` controls the role assigned to the auto-joined user.
  const [allowSignup, setAllowSignup] = useState(client?.allowSignup ?? false);
  const [signupRole, setSignupRole] = useState<AssignableOrgRole>(client?.signupRole ?? "member");
  const [assignments, setAssignments] = useState<AssignmentDraft[]>(() =>
    (client?.signupSpaceAssignments ?? []).map((assignment) => ({
      spaceId: assignment.spaceId,
      role: spaceRoleValue(assignment),
    })),
  );

  const {
    register,
    handleSubmit,
    setError,
    clearErrors,
    formState: { errors },
    showError,
  } = useAppForm<FormData>({
    defaultValues: { name: client?.name ?? "" },
  });

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

  /**
   * Fast-fail UX pre-check, NOT the policy. The server decides
   * (`isValidRedirectUri`, which shares its loopback predicate with the
   * Dynamic Client Registration path) and its rejection surfaces through
   * `onError` below, so this check is deliberately a superset of the server
   * rule: `https:` or `http:` on anything that looks loopback. Being looser
   * than the server only costs a round-trip; being stricter silently blocks
   * URIs the API accepts, `http://127.0.0.1/callback` for instance.
   */
  function validateUris(uris: string[]): string[] | null {
    for (const uri of uris) {
      try {
        const url = new URL(uri);
        if (url.protocol !== "https:" && !looksLoopback(url.hostname)) {
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
    const signupSpaceAssignments = assignmentsFor(signupRole, toSpaceAssignments(assignments));
    if (isOrgLevel && signupRole !== "admin" && assignments.length) {
      if (
        catalog.loading ||
        catalog.error ||
        hasUnavailableAssignments(assignments, catalog.spaces, catalog.roleOptions)
      ) {
        setError("root", {
          message: t(
            catalog.loading || catalog.error
              ? "settings:orgSettings.assignmentsNotReady"
              : "settings:orgSettings.assignmentsUnavailable",
          ),
        });
        return;
      }
    }
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
          params: { path: { clientId: client.clientId } },
          body: {
            redirectUris: cleaned,
            postLogoutRedirectUris: cleanedPostLogout,
            scopes: Array.from(selectedScopes),
            ...(can("oauth-clients:write") ? { isFirstParty } : {}),
            // Unified `allowSignup` (all levels). `signupRole` is org-only.
            allowSignup,
            ...(isOrgLevel ? { signupRole, signupSpaceAssignments } : {}),
          },
        },
        {
          onSuccess: () => {
            toast.success(t("settings:oauthClients.updated"));
            onClose();
          },
          onError: (err) => {
            setError("root", { message: errorMessage(err) });
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
          allowSignup,
          ...(isOrgLevel ? { signupRole, signupSpaceAssignments } : {}),
        },
        {
          onSuccess: (result) => {
            onCreated({ clientId: result.clientId, clientSecret: result.clientSecret });
          },
          onError: (err) => {
            setError("root", { message: errorMessage(err) });
          },
        },
      );
    }
  }

  return (
    <FormModal
      onClose={onClose}
      title={
        isEditing ? t("settings:oauthClients.editTitle") : t("settings:oauthClients.createTitle")
      }
      className="flex max-h-[85dvh] flex-col overflow-hidden"
      onSubmit={handleSubmit(onSubmit)}
      isPending={isPending}
      error={errors.root?.message}
      formProps={{ className: "flex min-h-0 flex-col gap-4 overflow-y-auto pr-1" }}
    >
      <FormItem
        id="oauth-client-name"
        label={t("settings:oauthClients.nameLabel")}
        hint={isEditing ? t("settings:oauthClients.nameReadonlyHint") : undefined}
        error={showError("name") ? t("common:validation.required") : undefined}
      >
        <Input
          type="text"
          {...register("name", { required: !isEditing, maxLength: 200 })}
          placeholder={t("settings:oauthClients.namePlaceholder")}
          disabled={isEditing}
          autoFocus={!isEditing}
        />
      </FormItem>

      <RowsEditor
        label={t("settings:oauthClients.redirectUris")}
        hint={t("settings:oauthClients.redirectUrisHint")}
        rows={redirectUris}
        onChange={setRedirectUris}
        newRow=""
        minRows={1}
        addLabel={t("settings:oauthClients.addRedirectUri")}
        renderRow={(uri, update) => (
          <UriInput
            value={uri}
            onChange={update}
            placeholder="https://example.com/oauth/callback"
          />
        )}
      />

      <RowsEditor
        label={t("settings:oauthClients.postLogoutRedirectUris")}
        hint={t("settings:oauthClients.postLogoutRedirectUrisHint")}
        rows={postLogoutRedirectUris}
        onChange={setPostLogoutRedirectUris}
        newRow=""
        minRows={1}
        addLabel={t("settings:oauthClients.addRedirectUri")}
        renderRow={(uri, update, index) => (
          <UriInput
            value={uri}
            onChange={update}
            placeholder="https://example.com/"
            // An empty first field offers the origin of the redirect URI, on a new client.
            onFocus={
              index === 0 && !isEditing && uri.trim().length === 0
                ? suggestPostLogoutFromRedirects
                : undefined
            }
          />
        )}
      />

      <div className="space-y-2">
        <Label>{t("settings:oauthClients.scopesLabel")}</Label>
        <p className="text-muted-foreground text-xs">{t("settings:oauthClients.scopesHint")}</p>
        <div className="flex flex-col gap-1.5">
          {(availableScopes ?? Array.from(REQUIRED_SCOPES)).map((scope) => {
            const required = REQUIRED_SCOPES.has(scope);
            return (
              <CheckboxField
                key={scope}
                id={`oauth-scope-${scope}`}
                checked={selectedScopes.has(scope)}
                disabled={required}
                onCheckedChange={() => toggleScope(scope)}
                label={
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
                }
                description={<span className="font-mono">{scope}</span>}
              />
            );
          })}
        </div>
      </div>

      {can("oauth-clients:write") && (
        <div className="space-y-2">
          <CheckboxField
            id="oauth-client-first-party"
            checked={isFirstParty}
            onCheckedChange={(checked) => setIsFirstParty(checked === true)}
            label={t("settings:oauthClients.isFirstPartyLabel")}
            description={t("settings:oauthClients.isFirstPartyHint")}
          />
        </div>
      )}

      {(isOrgLevel || isSpaceLevel) && (
        <SignupPolicyFields
          isOrgLevel={isOrgLevel}
          allowSignup={allowSignup}
          onAllowSignupChange={() => setAllowSignup((v) => !v)}
          signupRole={signupRole}
          onSignupRoleChange={(role) => {
            setSignupRole(role);
            clearErrors("root");
          }}
          assignments={assignments}
          onAssignmentsChange={(value) => {
            setAssignments(value);
            clearErrors("root");
          }}
          isPending={isPending}
          spaces={catalog.spaces}
          roleOptions={catalog.roleOptions}
          catalogLoading={catalog.loading}
          catalogError={catalog.error}
          onRetryCatalog={catalog.retry}
        />
      )}
    </FormModal>
  );
}

/**
 * The signup half of the client policy: the opt-in, and — on an org-level
 * client — the role and space grants a self-registered user lands with. The
 * policy is what a signup WOULD receive, so it is edited and validated whether
 * or not the opt-in is on. Split out of the modal body so it can be rendered
 * without the Radix dialog, which needs a DOM.
 */
export function SignupPolicyFields({
  isOrgLevel,
  allowSignup,
  onAllowSignupChange,
  signupRole,
  onSignupRoleChange,
  assignments,
  onAssignmentsChange,
  isPending,
  spaces,
  roleOptions,
  catalogLoading,
  catalogError,
  onRetryCatalog,
}: {
  isOrgLevel: boolean;
  allowSignup: boolean;
  onAllowSignupChange: () => void;
  signupRole: AssignableOrgRole;
  onSignupRoleChange: (role: AssignableOrgRole) => void;
  assignments: AssignmentDraft[];
  onAssignmentsChange: (next: AssignmentDraft[]) => void;
  isPending: boolean;
  spaces: { id: string; name: string }[];
  roleOptions: SpaceRoleOption[];
  catalogLoading: boolean;
  catalogError: unknown;
  onRetryCatalog: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  return (
    <div className="space-y-3 rounded-md border p-3">
      <CheckboxField
        id="oauth-client-allow-signup"
        checked={allowSignup}
        onCheckedChange={onAllowSignupChange}
        label={t("settings:oauthClients.allowSignupLabel")}
        description={t("settings:oauthClients.allowSignupHint")}
      />
      {isOrgLevel && (
        <FormItem
          id="oauth-client-signup-role"
          label={t("settings:oauthClients.signupRoleLabel")}
          hint={
            <>
              {t(`settings:orgSettings.roleHint.${signupRole}`)}
              <br />
              {t("settings:oauthClients.signupRoleHint")}
            </>
          }
        >
          <OptionSelect
            value={signupRole}
            onValueChange={(value) => onSignupRoleChange(value as AssignableOrgRole)}
            disabled={isPending}
            options={ASSIGNABLE_ORG_ROLES.map((role) => ({
              value: role,
              label: t(`settings:oauthClients.signupRoleOption.${role}`),
            }))}
          />
        </FormItem>
      )}
      {isOrgLevel && (
        <SpaceAssignmentsField
          spaces={spaces}
          roleOptions={roleOptions}
          loading={catalogLoading}
          error={catalogError}
          onRetry={onRetryCatalog}
          hint={t(
            signupRole === "admin"
              ? "settings:orgSettings.roleHint.admin"
              : "settings:oauthClients.signupSpacesHint",
          )}
          allSpacesAccess={signupRole === "admin"}
          value={assignments}
          onChange={onAssignmentsChange}
          disabled={isPending || signupRole === "admin"}
        />
      )}
    </div>
  );
}

function UriInput({
  value,
  onChange,
  placeholder,
  onFocus,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  onFocus?: () => void;
}) {
  return (
    <Input
      type="url"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onFocus={onFocus}
      placeholder={placeholder}
    />
  );
}
