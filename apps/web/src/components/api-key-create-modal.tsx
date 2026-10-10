// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useForm, Controller } from "react-hook-form";
import { Modal } from "./modal";
import { useModalParam } from "../hooks/use-modal-param";
import { RevealedSecret } from "./revealed-secret";
import { Button } from "@appstrate/ui/components/button";
import { Badge } from "@appstrate/ui/components/badge";
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@appstrate/ui/components/select";
import { Spinner } from "./spinner";
import { ScopeMultiSelect } from "./scope-multi-select";
import { useCreateApiKey, useAvailableScopes } from "../hooks/use-api-keys";
import { errorMessage } from "../lib/mutation-error";
import { permissionResourceLabel } from "../lib/permission-labels";

/** The URL parameter that opens the modal. The created key has no URL of its own. */
export const NEW_API_KEY_PARAM = "newApiKey";

interface Props {
  onKeyCreated?: (rawKey: string) => void;
}

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

export function ApiKeyCreateModal({ onKeyCreated }: Props) {
  const { t } = useTranslation(["settings", "common"]);
  const param = useModalParam(NEW_API_KEY_PARAM);
  const { data: availableScopes } = useAvailableScopes();
  const [created, setCreated] = useState<{ key: string; scopes: string[] } | null>(null);

  // ── Success state ──
  if (created) {
    const summary =
      availableScopes && created.scopes.length > 0
        ? buildResourceSummary(created.scopes, availableScopes)
        : [];
    const isFullAccess = availableScopes ? created.scopes.length === availableScopes.length : true;
    const done = () => setCreated(null);

    return (
      <Modal open onClose={done} title={t("apiKeys.created")} className="sm:max-w-lg">
        <RevealedSecret secret={created.key} warning={t("apiKeys.createdWarning")} />

        {/* Scopes granted */}
        <div className="border-border mt-4 border-t pt-3">
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

        <div className="border-border mt-4 flex justify-end gap-2 border-t pt-4">
          <Button onClick={done}>{t("btn.done")}</Button>
        </div>
      </Modal>
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
        onKeyCreated?.(key);
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

  const onSubmit = handleSubmit(onFormSubmit);

  // ── Creation form ──
  return (
    <Modal
      open
      onClose={onClose}
      title={t("apiKeys.createTitle")}
      className="sm:max-w-lg"
      actions={
        <>
          <Button variant="outline" type="button" onClick={onClose}>
            {t("btn.cancel")}
          </Button>
          <Button
            type="submit"
            form="create-api-key-form"
            disabled={createMutation.isPending || effectiveScopes.length === 0}
          >
            {createMutation.isPending ? <Spinner /> : t("btn.create", { ns: "common" })}
          </Button>
        </>
      }
    >
      <form id="create-api-key-form" onSubmit={onSubmit} className="space-y-4">
        {/* Name */}
        <div className="space-y-2">
          <Label htmlFor="api-key-name">{t("apiKeys.nameLabel")}</Label>
          <Input
            id="api-key-name"
            type="text"
            {...register("name", { required: true })}
            placeholder={t("apiKeys.namePlaceholder")}
            maxLength={100}
            required
            autoFocus
          />
        </div>

        {/* Expiration */}
        <div className="space-y-2">
          <Label htmlFor="api-key-expires">{t("apiKeys.expiresLabel")}</Label>
          <Controller
            name="expiresIn"
            control={control}
            render={({ field }) => (
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger id="api-key-expires">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="30">{t("apiKeys.expires30")}</SelectItem>
                  <SelectItem value="90">{t("apiKeys.expires90")}</SelectItem>
                  <SelectItem value="180">{t("apiKeys.expires180")}</SelectItem>
                  <SelectItem value="365">{t("apiKeys.expires365")}</SelectItem>
                  <SelectItem value="never">{t("apiKeys.expiresNever")}</SelectItem>
                </SelectContent>
              </Select>
            )}
          />
        </div>

        {/* Permissions */}
        {availableScopes && (
          <div className="space-y-2">
            <Label>{t("apiKeys.permissionSummary")}</Label>
            <ScopeMultiSelect
              available={availableScopes}
              selected={effectiveScopes}
              onChange={setSelectedScopes}
            />
          </div>
        )}

        {errors.root?.message && <p className="text-destructive text-sm">{errors.root.message}</p>}
      </form>
    </Modal>
  );
}
