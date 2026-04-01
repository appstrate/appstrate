import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useForm, Controller } from "react-hook-form";
import { useCopyToClipboard } from "../hooks/use-copy-to-clipboard";
import { Modal } from "./modal";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "./spinner";
import { ScopeMultiSelect } from "./scope-multi-select";
import { useCreateApiKey, useAvailableScopes } from "../hooks/use-api-keys";

interface Props {
  open: boolean;
  onClose: () => void;
  onKeyCreated?: (rawKey: string) => void;
}

type FormData = { name: string; expiresIn: string };

function computeExpiresAt(expiresIn: string): string | null {
  if (expiresIn === "never") return null;
  return new Date(Date.now() + parseInt(expiresIn, 10) * 24 * 60 * 60 * 1000).toISOString();
}

/** Build compact resource summary from scopes (e.g. ["flows", "executions (2/3)"]). */
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

export function ApiKeyCreateModal({ open, onClose, onKeyCreated }: Props) {
  const { t } = useTranslation(["settings", "common"]);
  const createMutation = useCreateApiKey();
  const { data: availableScopes } = useAvailableScopes();

  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [createdScopes, setCreatedScopes] = useState<string[]>([]);
  const [selectedScopes, setSelectedScopes] = useState<string[] | null>(null);
  const { copied, copy } = useCopyToClipboard();

  const {
    register,
    handleSubmit,
    reset,
    control,
    setError,
    formState: { errors },
  } = useForm<FormData>({
    defaultValues: { name: "", expiresIn: "90" },
  });

  const handleClose = () => {
    reset({ name: "", expiresIn: "90" });
    setCreatedKey(null);
    setCreatedScopes([]);
    setSelectedScopes(null);
    createMutation.reset();
    onClose();
  };

  const effectiveScopes = selectedScopes !== null ? selectedScopes : (availableScopes ?? []);
  const allSelected = availableScopes ? effectiveScopes.length === availableScopes.length : true;

  function onFormSubmit(data: FormData) {
    const expiresAt = computeExpiresAt(data.expiresIn);

    createMutation.mutate(
      {
        name: data.name.trim(),
        expiresAt,
        scopes: allSelected ? undefined : effectiveScopes,
      },
      {
        onSuccess: (result) => {
          setCreatedKey(result.key);
          setCreatedScopes(result.scopes);
          onKeyCreated?.(result.key);
        },
        onError: (err) => {
          setError("root", { message: err instanceof Error ? err.message : String(err) });
        },
      },
    );
  }

  const onSubmit = handleSubmit(onFormSubmit);

  const handleCopy = () => {
    if (createdKey) copy(createdKey);
  };

  // ── Success state ──
  if (createdKey) {
    const summary =
      availableScopes && createdScopes.length > 0
        ? buildResourceSummary(createdScopes, availableScopes)
        : [];
    const isFullAccess = availableScopes ? createdScopes.length === availableScopes.length : true;

    return (
      <Modal open={open} onClose={handleClose} title={t("apiKeys.created")} className="sm:max-w-lg">
        <p className="text-warning bg-warning/10 rounded-md px-3 py-2 text-sm">
          {t("apiKeys.createdWarning")}
        </p>
        <div className="border-border bg-muted/50 mt-3 flex items-center gap-2 rounded-md border px-3 py-2">
          <code className="text-foreground flex-1 font-mono text-xs break-all">{createdKey}</code>
          <Button
            variant="ghost"
            size="sm"
            className="text-primary shrink-0 text-xs hover:underline"
            onClick={handleCopy}
          >
            {copied ? t("btn.copied") : t("btn.copy")}
          </Button>
        </div>

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
                  {g.resource}
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
          <Button onClick={handleClose}>{t("btn.done")}</Button>
        </div>
      </Modal>
    );
  }

  // ── Creation form ──
  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={t("apiKeys.createTitle")}
      className="sm:max-w-lg"
      actions={
        <>
          <Button variant="outline" type="button" onClick={handleClose}>
            {t("btn.cancel")}
          </Button>
          <Button
            type="submit"
            form="create-api-key-form"
            disabled={createMutation.isPending || effectiveScopes.length === 0}
          >
            {createMutation.isPending ? <Spinner /> : t("apiKeys.createBtn")}
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
