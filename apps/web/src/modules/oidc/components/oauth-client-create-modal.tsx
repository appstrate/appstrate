// SPDX-License-Identifier: Apache-2.0

/**
 * Two-step OAuth client creation modal:
 *   1. Form — name + redirect URIs
 *   2. Secret reveal — plaintext clientSecret shown exactly once
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useForm } from "react-hook-form";
import { Plus, X } from "lucide-react";
import { Modal } from "@/components/modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/spinner";
import { SecretRevealModal } from "@/components/secret-reveal-modal";
import { useCreateOAuthClient, useOAuthScopes } from "../hooks/use-oauth-clients";

/** Scopes that are always granted — cannot be unchecked in the UI. */
const REQUIRED_SCOPES = new Set(["openid", "profile", "email"]);

interface Props {
  open: boolean;
  onClose: () => void;
}

interface FormData {
  name: string;
}

export function OAuthClientCreateModal({ open, onClose }: Props) {
  const { t } = useTranslation(["settings", "common"]);
  const createMutation = useCreateOAuthClient();
  const { data: availableScopes } = useOAuthScopes();
  const [redirectUris, setRedirectUris] = useState<string[]>([""]);
  const [selectedScopes, setSelectedScopes] = useState<Set<string>>(() => new Set(REQUIRED_SCOPES));
  const [createdSecret, setCreatedSecret] = useState<{
    clientId: string;
    clientSecret: string;
  } | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors },
  } = useForm<FormData>({ defaultValues: { name: "" } });

  function handleClose() {
    reset({ name: "" });
    setRedirectUris([""]);
    setSelectedScopes(new Set(REQUIRED_SCOPES));
    setCreatedSecret(null);
    createMutation.reset();
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

  function onSubmit(data: FormData) {
    const cleaned = redirectUris.map((u) => u.trim()).filter((u) => u.length > 0);
    if (cleaned.length === 0) {
      setError("root", { message: t("settings:oauthClients.redirectUrisRequired") });
      return;
    }
    for (const uri of cleaned) {
      try {
        const url = new URL(uri);
        if (url.protocol !== "https:" && url.hostname !== "localhost") {
          setError("root", { message: t("settings:oauthClients.httpsRequired") });
          return;
        }
      } catch {
        setError("root", { message: t("settings:oauthClients.invalidUri") });
        return;
      }
    }

    createMutation.mutate(
      {
        name: data.name.trim(),
        redirectUris: cleaned,
        scopes: Array.from(selectedScopes),
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

  if (createdSecret) {
    return (
      <SecretRevealModal
        open={open}
        onClose={handleClose}
        title={t("settings:oauthClients.createdTitle")}
        secret={`Client ID: ${createdSecret.clientId}\nClient Secret: ${createdSecret.clientSecret}`}
      />
    );
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={t("settings:oauthClients.createTitle")}
      actions={
        <>
          <Button variant="outline" type="button" onClick={handleClose}>
            {t("common:btn.cancel")}
          </Button>
          <Button type="submit" form="create-oauth-client-form" disabled={createMutation.isPending}>
            {createMutation.isPending ? <Spinner /> : t("settings:oauthClients.createBtn")}
          </Button>
        </>
      }
    >
      <form id="create-oauth-client-form" onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="oauth-client-name">{t("settings:oauthClients.nameLabel")}</Label>
          <Input
            id="oauth-client-name"
            type="text"
            {...register("name", { required: true, maxLength: 200 })}
            placeholder={t("settings:oauthClients.namePlaceholder")}
            autoFocus
          />
          {errors.name && (
            <p className="text-destructive text-xs">{t("common:validation.required")}</p>
          )}
        </div>

        <div className="space-y-2">
          <Label>{t("settings:oauthClients.redirectUris")}</Label>
          <p className="text-muted-foreground text-xs">
            {t("settings:oauthClients.redirectUrisHint")}
          </p>
          <div className="flex flex-col gap-2">
            {redirectUris.map((uri, index) => (
              <div key={index} className="flex gap-2">
                <Input
                  type="url"
                  value={uri}
                  onChange={(e) => {
                    const next = [...redirectUris];
                    next[index] = e.target.value;
                    setRedirectUris(next);
                  }}
                  placeholder="https://example.com/oauth/callback"
                />
                {redirectUris.length > 1 && (
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={() => setRedirectUris(redirectUris.filter((_, i) => i !== index))}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setRedirectUris([...redirectUris, ""])}
            >
              <Plus className="h-4 w-4" /> {t("settings:oauthClients.addRedirectUri")}
            </Button>
          </div>
        </div>

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

        {errors.root && <p className="text-destructive text-sm">{errors.root.message}</p>}
      </form>
    </Modal>
  );
}
