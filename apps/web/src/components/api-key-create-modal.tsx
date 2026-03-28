import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useForm, Controller } from "react-hook-form";
import { useCopyToClipboard } from "../hooks/use-copy-to-clipboard";
import { Modal } from "./modal";
import { Button } from "@/components/ui/button";
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
import { useCreateApiKey } from "../hooks/use-api-keys";

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

export function ApiKeyCreateModal({ open, onClose, onKeyCreated }: Props) {
  const { t } = useTranslation(["settings", "common"]);
  const createMutation = useCreateApiKey();

  const [createdKey, setCreatedKey] = useState<string | null>(null);
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
    createMutation.reset();
    onClose();
  };

  function onFormSubmit(data: FormData) {
    const expiresAt = computeExpiresAt(data.expiresIn);

    createMutation.mutate(
      { name: data.name.trim(), expiresAt },
      {
        onSuccess: (result) => {
          setCreatedKey(result.key);
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

  // After creation: show the key
  if (createdKey) {
    return (
      <Modal open={open} onClose={handleClose} title={t("apiKeys.created")}>
        <p className="text-sm text-warning bg-warning/10 rounded-md px-3 py-2">
          {t("apiKeys.createdWarning")}
        </p>
        <div className="flex items-center gap-2 mt-3 rounded-md border border-border bg-muted/50 px-3 py-2">
          <code className="flex-1 text-xs font-mono text-foreground break-all">{createdKey}</code>
          <Button
            variant="ghost"
            size="sm"
            className="text-xs text-primary hover:underline shrink-0"
            onClick={handleCopy}
          >
            {copied ? t("btn.copied") : t("btn.copy")}
          </Button>
        </div>
        <div className="flex justify-end gap-2 mt-4 pt-4 border-t border-border">
          <Button onClick={handleClose}>{t("btn.done")}</Button>
        </div>
      </Modal>
    );
  }

  // Creation form
  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={t("apiKeys.createTitle")}
      actions={
        <>
          <Button variant="outline" type="button" onClick={handleClose}>
            {t("btn.cancel")}
          </Button>
          <Button type="submit" form="create-api-key-form" disabled={createMutation.isPending}>
            {createMutation.isPending ? <Spinner /> : t("apiKeys.createBtn")}
          </Button>
        </>
      }
    >
      <form id="create-api-key-form" onSubmit={onSubmit}>
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
        {errors.root?.message && <p className="text-sm text-destructive">{errors.root.message}</p>}
      </form>
    </Modal>
  );
}
