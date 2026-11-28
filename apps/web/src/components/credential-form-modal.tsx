// SPDX-License-Identifier: Apache-2.0

/**
 * A connection of a model configuration: an API key typed here, or a subscription paired through
 * the helper (`PairingModal`). A new connection joins its configuration, owned by the
 * organization or by the caller; an existing key is changed in place, an existing subscription
 * re-paired. Renaming is never done here (`InlineEditableLabel`), nor is the configuration's
 * endpoint: a connection carries only its secret.
 *
 * The form owns its write: its refusal is shown under the field, never toasted.
 */

import { PendingButton } from "@/components/app-ui/pending-button";
import { useState } from "react";
import { useWatch } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { Input } from "@appstrate/ui/components/input";
import type { TestResult } from "@appstrate/shared-types";
import { FormItem } from "@/components/app-ui/form-item";
import { useAppForm } from "../hooks/use-app-form";
import {
  useCreateModelProviderCredential,
  useTestModelProviderCredentialInline,
  useUpdateModelProviderCredential,
  type ModelProviderCredentialInfo,
  type ProviderRegistryEntry,
} from "../hooks/use-model-provider-credentials";
import type { ModelConfigInfo } from "../lib/model-configs";
import { connectionBody, keyUpdateBody } from "../lib/model-configs";
import { errorMessage } from "../lib/mutation-error";
import { FormModal } from "./form-modal";
import { PairingModal } from "./pairing-modal";
import { TestResultSpan } from "./test-result-span";

/** What the form connects: a new connection of a configuration, or an existing one. */
export type ConnectionFormTarget =
  | {
      kind: "create";
      config: Pick<ModelConfigInfo, "id" | "label" | "base_url">;
      provider: ProviderRegistryEntry;
      ownerType: "org" | "user";
    }
  | { kind: "edit"; credential: ModelProviderCredentialInfo };

/** Mounted by the caller while open, one per target (`key`): the typed key starts fresh. */
export function CredentialFormModal({
  target,
  onClose,
}: {
  target: ConnectionFormTarget;
  onClose: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);

  if (target.kind === "create" && target.provider.authMode === "oauth2") {
    return (
      <PairingModal
        title={t("modelConfigs.connect.title", { label: target.config.label })}
        onClose={onClose}
        providerId={target.provider.providerId}
        target={{ ownerType: target.ownerType, configId: target.config.id }}
        onConnected={() => onClose()}
      >
        <p className="text-muted-foreground text-sm">{payerSentence(t, target.ownerType)}</p>
      </PairingModal>
    );
  }
  if (target.kind === "edit" && target.credential.authMode === "oauth2") {
    // The menu opens this only for a caller holding the connection's `reconnect` action.
    return (
      <PairingModal
        title={t("credentials.form.reconnectTitle", { label: target.credential.label })}
        onClose={onClose}
        providerId={target.credential.providerId ?? ""}
        target={{ credentialId: target.credential.id }}
        onConnected={() => onClose()}
      />
    );
  }
  return <ApiKeyForm target={target} onClose={onClose} />;
}

function payerSentence(t: (key: string) => string, ownerType: "org" | "user"): string {
  return t(ownerType === "org" ? "modelConfigs.payer.org" : "modelConfigs.payer.user");
}

function ApiKeyForm({ target, onClose }: { target: ConnectionFormTarget; onClose: () => void }) {
  const { t } = useTranslation(["settings", "common"]);
  const credential = target.kind === "edit" ? target.credential : null;
  const providerId =
    target.kind === "edit" ? (target.credential.providerId ?? "") : target.provider.providerId;
  const baseUrl =
    target.kind === "edit"
      ? target.credential.base_url
      : (target.config.base_url ?? target.provider.defaultBaseUrl);

  const create = useCreateModelProviderCredential({ errorHandledByCaller: true });
  const update = useUpdateModelProviderCredential({ errorHandledByCaller: true });
  const mutation = credential ? update : create;

  const {
    register,
    handleSubmit,
    control,
    showError,
    formState: { errors },
  } = useAppForm<{ apiKey: string }>({ defaultValues: { apiKey: "" } });
  const apiKey = useWatch({ control, name: "apiKey" });

  const testMutation = useTestModelProviderCredentialInline();
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const canTest = !!baseUrl && (!!apiKey.trim() || !!credential);

  const handleTest = () => {
    if (!baseUrl) return;
    setTestResult(null);
    testMutation.mutate(
      {
        body: {
          providerId,
          base_url: baseUrl,
          ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
          ...(credential ? { credentialId: credential.id } : {}),
        },
      },
      {
        onSuccess: (result) => setTestResult(result),
        onError: () =>
          setTestResult({
            ok: false,
            latency: 0,
            error: "INTERNAL_ERROR",
            message: t("test.failed", { ns: "common" }),
          }),
      },
    );
  };

  const onSubmit = handleSubmit((data) => {
    if (credential) {
      update.mutate(
        { params: { path: { id: credential.id } }, body: keyUpdateBody(data.apiKey) },
        { onSuccess: onClose },
      );
      return;
    }
    if (target.kind !== "create") return;
    create.mutate(
      {
        body: connectionBody({
          providerId,
          configId: target.config.id,
          apiKey: data.apiKey,
          ownerType: target.ownerType,
        }),
      },
      { onSuccess: onClose },
    );
  });

  const title = credential
    ? t("credentials.form.editTitle", { label: credential.label })
    : t("modelConfigs.connect.title", {
        label: target.kind === "create" ? target.config.label : "",
      });

  return (
    <FormModal
      onClose={onClose}
      title={title}
      onSubmit={onSubmit}
      error={mutation.error ? errorMessage(mutation.error) : null}
      isPending={mutation.isPending}
      formProps={{ noValidate: true }}
      secondaryActions={
        <PendingButton
          type="button"
          variant="outline"
          className="sm:mr-auto"
          onClick={handleTest}
          pending={testMutation.isPending}
          disabled={!canTest}
        >
          {t("credentials.test")}
        </PendingButton>
      }
    >
      {target.kind === "create" && (
        <p className="text-muted-foreground text-sm">{payerSentence(t, target.ownerType)}</p>
      )}
      <FormItem
        id="pk-apiKey"
        label={t("credentials.form.apiKey")}
        error={showError("apiKey") ? errors.apiKey?.message : undefined}
      >
        <Input
          type="password"
          autoComplete="off"
          {...register("apiKey", {
            validate: (v) => (!v.trim() ? t("validation.required", { ns: "common" }) : undefined),
          })}
          placeholder={t("credentials.form.apiKeyPlaceholder")}
        />
      </FormItem>
      {/* Its own line in the body: a refusal is a sentence, and beside the footer's buttons it
          pushed « Annuler » and « Enregistrer » out of the dialog. */}
      {testResult && (
        <div role="status">
          <TestResultSpan
            result={testResult}
            successKey="credentials.testSuccess"
            failedKey="credentials.testFailed"
            wrap
          />
        </div>
      )}
    </FormModal>
  );
}
