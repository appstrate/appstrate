// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
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
import { PROVIDER_ICONS } from "./icons";
import { Modal } from "./modal";
import { OAuthPairingBody } from "./oauth-pairing-body";
import { Spinner } from "./spinner";
import {
  useCreateModelProviderCredential,
  type ProviderRegistryEntry,
} from "../hooks/use-model-provider-credentials";
import { useAppForm } from "../hooks/use-app-form";
import { usePairingDismissConfirm } from "../hooks/use-pairing-dismiss-confirm";
import { personalApiKeyBody } from "../lib/personal-model-credentials";

function ProviderSelect({
  id,
  value,
  onChange,
  providers,
  withIcon,
}: {
  id: string;
  value: string;
  onChange: (providerId: string) => void;
  providers: ProviderRegistryEntry[];
  withIcon: boolean;
}) {
  const { t } = useTranslation("settings");
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id}>
        <SelectValue placeholder={t("models.form.providerPlaceholder")} />
      </SelectTrigger>
      <SelectContent>
        {providers.map((p) => {
          const Icon = PROVIDER_ICONS[p.iconUrl];
          return (
            <SelectItem key={p.providerId} value={p.providerId}>
              <span className="flex items-center gap-2">
                {withIcon && Icon && <Icon className="size-4" />}
                {p.displayName}
              </span>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

interface ApiKeyFields {
  label: string;
  apiKey: string;
}

/** Personal API-key credential. Mounted only while open, so the form starts empty. */
export function ApiKeyForm({
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
          <ProviderSelect
            id="pmc-provider"
            value={providerId}
            onChange={setProviderId}
            providers={providers}
            withIcon
          />
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

/** Subscription (OAuth pairing) credential. Mounted only while open. */
export function SubscriptionPairing({
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
              <ProviderSelect
                id="pmc-subscription"
                value={providerId}
                onChange={setProviderId}
                providers={providers}
                withIcon={false}
              />
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
