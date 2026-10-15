// SPDX-License-Identifier: Apache-2.0

import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { FormModal } from "./form-modal";
import { SecretRevealModal } from "./secret-reveal-modal";
import { Badge } from "@appstrate/ui/components/badge";
import { FormItem } from "@/components/app-ui/form-item";
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";
import { OptionSelect } from "@/components/app-ui/option-select";
import { TextSkeleton } from "./loading-skeletons";
import { ScopeMultiSelect, ScopeSummaryBadges } from "./scope-multi-select";
import { useCreateApiKey, useAvailableScopes } from "../hooks/use-api-keys";
import { errorMessage } from "../lib/mutation-error";

function computeExpiresAt(expiresIn: string): string | null {
  if (expiresIn === "never") return null;
  return new Date(Date.now() + parseInt(expiresIn, 10) * 24 * 60 * 60 * 1000).toISOString();
}

export function ApiKeyCreateModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation(["settings", "common"]);
  const { data: availableScopes } = useAvailableScopes();
  const [created, setCreated] = useState<{ key: string; scopes: string[] } | null>(null);

  if (created) {
    const isFullAccess = availableScopes ? created.scopes.length === availableScopes.length : true;

    return (
      <SecretRevealModal
        onClose={onClose}
        title={t("apiKeys.created")}
        className="sm:max-w-lg"
        secret={created.key}
        warning={t("apiKeys.createdWarning")}
      >
        {/* Scopes granted */}
        <div className="border-border border-t pt-3">
          <p className="text-muted-foreground mb-2 text-xs font-medium">
            {t("apiKeys.scopesGranted")}
          </p>
          {isFullAccess || !availableScopes ? (
            <Badge variant="success">{t("apiKeys.fullAccess")}</Badge>
          ) : (
            <ScopeSummaryBadges available={availableScopes} selected={created.scopes} />
          )}
        </div>
      </SecretRevealModal>
    );
  }

  return (
    <ApiKeyCreateForm
      availableScopes={availableScopes}
      onClose={onClose}
      onCreated={(key, scopes) => setCreated({ key, scopes })}
    />
  );
}

function ApiKeyCreateForm({
  availableScopes,
  onClose,
  onCreated,
}: {
  availableScopes: string[] | undefined;
  onClose: () => void;
  onCreated: (key: string, scopes: string[]) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const createMutation = useCreateApiKey();
  const [selectedScopes, setSelectedScopes] = useState<string[] | null>(null);

  const [name, setName] = useState("");
  const [expiresIn, setExpiresIn] = useState("90");
  const [error, setError] = useState<string | null>(null);

  const effectiveScopes = selectedScopes !== null ? selectedScopes : (availableScopes ?? []);
  const allSelected = availableScopes ? effectiveScopes.length === availableScopes.length : true;

  function onFormSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    createMutation.mutate(
      {
        body: {
          name: name.trim(),
          expiresAt: computeExpiresAt(expiresIn),
          scopes: allSelected ? undefined : effectiveScopes,
        },
      },
      {
        onSuccess: (result) => {
          if (result.key) onCreated(result.key, result.scopes ?? []);
        },
        onError: (err) => setError(errorMessage(err)),
      },
    );
  }

  return (
    <FormModal
      onClose={onClose}
      title={t("apiKeys.createTitle")}
      className="sm:max-w-lg"
      onSubmit={onFormSubmit}
      isPending={createMutation.isPending}
      submitLabel={t("btn.create", { ns: "common" })}
      submitDisabled={effectiveScopes.length === 0}
      error={error}
    >
      {/* Name */}
      <FormItem id="api-key-name" label={t("spaces.nameLabel")}>
        <Input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("apiKeys.namePlaceholder")}
          maxLength={100}
          required
          autoFocus
        />
      </FormItem>

      {/* Expiration */}
      <FormItem id="api-key-expires" label={t("apiKeys.expiresLabel")}>
        <OptionSelect
          value={expiresIn}
          onValueChange={setExpiresIn}
          options={[
            { value: "30", label: t("apiKeys.expires30") },
            { value: "90", label: t("apiKeys.expires90") },
            { value: "180", label: t("apiKeys.expires180") },
            { value: "365", label: t("apiKeys.expires365") },
            { value: "never", label: t("apiKeys.expiresNever") },
          ]}
        />
      </FormItem>

      {/* Permissions */}
      <div className="flex flex-col gap-2">
        <Label className="mb-0">{t("roles.permissionsLabel")}</Label>
        {availableScopes ? (
          <ScopeMultiSelect
            available={availableScopes}
            selected={effectiveScopes}
            onChange={setSelectedScopes}
          />
        ) : (
          <TextSkeleton lines={4} />
        )}
      </div>
    </FormModal>
  );
}
