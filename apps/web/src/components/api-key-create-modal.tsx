// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useForm, Controller } from "react-hook-form";
import { FormModal } from "./form-modal";
import { SecretRevealModal } from "./secret-reveal-modal";
import { useModalParam } from "../hooks/use-modal-param";
import { Badge } from "@appstrate/ui/components/badge";
import { FormItem } from "@/components/app-ui/form-item";
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";
import { OptionSelect } from "@/components/app-ui/option-select";
import { TextSkeleton } from "./loading-skeletons";
import { ScopeMultiSelect } from "./scope-multi-select";
import { useCreateApiKey, useAvailableScopes } from "../hooks/use-api-keys";
import { errorMessage } from "../lib/mutation-error";
import { permissionResourceLabel } from "../lib/permission-labels";

/** The URL parameter that opens the modal. The created key has no URL of its own. */
export const NEW_API_KEY_PARAM = "newApiKey";

type FormData = { name: string; expiresIn: string };

function computeExpiresAt(expiresIn: string): string | null {
  if (expiresIn === "never") return null;
  return new Date(Date.now() + parseInt(expiresIn, 10) * 24 * 60 * 60 * 1000).toISOString();
}

/** Build compact resource summary from scopes (e.g. ["agents", "runs (2/3)"]). */
function buildResourceSummary(
  scopes: string[],
  allScopes: string[],
): Array<{ resource: string; full: boolean; count: number; total: number }> {
  const byResource = new Map<string, { count: number; total: number }>();
  const allSet = new Set(allScopes);
  for (const s of allScopes) {
    const r = s.split(":")[0]!;
    const entry = byResource.get(r) ?? { count: 0, total: 0 };
    entry.total++;
    byResource.set(r, entry);
  }
  const selectedSet = new Set(scopes);
  for (const s of allSet) {
    if (selectedSet.has(s)) {
      const r = s.split(":")[0]!;
      byResource.get(r)!.count++;
    }
  }
  return [...byResource.entries()]
    .filter(([, v]) => v.count > 0)
    .map(([resource, { count, total }]) => ({
      resource,
      full: count === total,
      count,
      total,
    }));
}

export function ApiKeyCreateModal() {
  const { t } = useTranslation(["settings", "common"]);
  const param = useModalParam(NEW_API_KEY_PARAM);
  const { data: availableScopes } = useAvailableScopes();
  const [created, setCreated] = useState<{ key: string; scopes: string[] } | null>(null);

  if (created) {
    const summary =
      availableScopes && created.scopes.length > 0
        ? buildResourceSummary(created.scopes, availableScopes)
        : [];
    const isFullAccess = availableScopes ? created.scopes.length === availableScopes.length : true;

    return (
      <SecretRevealModal
        onClose={() => setCreated(null)}
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
          {isFullAccess ? (
            <Badge variant="success">{t("apiKeys.fullAccess")}</Badge>
          ) : (
            <div className="flex flex-wrap gap-1">
              {summary.map((g) => (
                <Badge key={g.resource} variant="secondary" className="px-1.5 py-0 text-[0.65rem]">
                  {permissionResourceLabel(g.resource, t)}
                  {!g.full && (
                    <span className="ml-0.5 opacity-60">
                      {g.count}/{g.total}
                    </span>
                  )}
                </Badge>
              ))}
            </div>
          )}
        </div>
      </SecretRevealModal>
    );
  }

  // The form exists only while the modal is open, so any way of closing it (Annuler, a click
  // outside, Escape, Back) abandons what was typed.
  if (param.value === null) return null;
  return (
    <ApiKeyCreateForm
      availableScopes={availableScopes}
      onClose={param.close}
      onCreated={(key, scopes) => {
        setCreated({ key, scopes });
        param.close();
      }}
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

  const {
    register,
    handleSubmit,
    control,
    setError,
    formState: { errors },
  } = useForm<FormData>({
    defaultValues: { name: "", expiresIn: "90" },
  });

  const effectiveScopes = selectedScopes !== null ? selectedScopes : (availableScopes ?? []);
  const allSelected = availableScopes ? effectiveScopes.length === availableScopes.length : true;

  function onFormSubmit(data: FormData) {
    const expiresAt = computeExpiresAt(data.expiresIn);

    createMutation.mutate(
      {
        body: {
          name: data.name.trim(),
          expiresAt,
          scopes: allSelected ? undefined : effectiveScopes,
        },
      },
      {
        onSuccess: (result) => {
          if (result.key) onCreated(result.key, result.scopes ?? []);
        },
        onError: (err) => {
          setError("root", { message: errorMessage(err) });
        },
      },
    );
  }

  return (
    <FormModal
      onClose={onClose}
      title={t("apiKeys.createTitle")}
      className="sm:max-w-lg"
      onSubmit={handleSubmit(onFormSubmit)}
      isPending={createMutation.isPending}
      submitLabel={t("btn.create", { ns: "common" })}
      submitDisabled={effectiveScopes.length === 0}
      error={errors.root?.message}
    >
      {/* Name */}
      <FormItem id="api-key-name" label={t("apiKeys.nameLabel")}>
        <Input
          type="text"
          {...register("name", { required: true })}
          placeholder={t("apiKeys.namePlaceholder")}
          maxLength={100}
          required
          autoFocus
        />
      </FormItem>

      {/* Expiration */}
      <Controller
        name="expiresIn"
        control={control}
        render={({ field }) => (
          <FormItem id="api-key-expires" label={t("apiKeys.expiresLabel")}>
            <OptionSelect
              value={field.value}
              onValueChange={field.onChange}
              options={[
                { value: "30", label: t("apiKeys.expires30") },
                { value: "90", label: t("apiKeys.expires90") },
                { value: "180", label: t("apiKeys.expires180") },
                { value: "365", label: t("apiKeys.expires365") },
                { value: "never", label: t("apiKeys.expiresNever") },
              ]}
            />
          </FormItem>
        )}
      />

      {/* Permissions */}
      <div className="space-y-2">
        <Label>{t("apiKeys.permissionSummary")}</Label>
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
