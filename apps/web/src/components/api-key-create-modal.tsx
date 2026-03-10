import { useState } from "react";
import { useTranslation } from "react-i18next";
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

export function ApiKeyCreateModal({ open, onClose, onKeyCreated }: Props) {
  const { t } = useTranslation(["settings", "common"]);
  const createMutation = useCreateApiKey();

  const [name, setName] = useState("");
  const [expiresIn, setExpiresIn] = useState("90");
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleClose = () => {
    setName("");
    setExpiresIn("90");
    setCreatedKey(null);
    setCopied(false);
    createMutation.reset();
    onClose();
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const expiresAt =
      expiresIn === "never"
        ? null
        : new Date(Date.now() + parseInt(expiresIn, 10) * 24 * 60 * 60 * 1000).toISOString();

    createMutation.mutate(
      { name: name.trim(), expiresAt },
      {
        onSuccess: (data) => {
          setCreatedKey(data.key);
          onKeyCreated?.(data.key);
        },
      },
    );
  };

  const handleCopy = () => {
    if (createdKey) {
      navigator.clipboard.writeText(createdKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
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
            {copied ? t("btn.copied") : t("btn.copyLink")}
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
          <Button
            type="submit"
            form="create-api-key-form"
            disabled={createMutation.isPending || !name.trim()}
          >
            {createMutation.isPending ? <Spinner /> : t("apiKeys.createBtn")}
          </Button>
        </>
      }
    >
      <form id="create-api-key-form" onSubmit={handleSubmit}>
        <div className="space-y-2">
          <Label htmlFor="api-key-name">{t("apiKeys.nameLabel")}</Label>
          <Input
            id="api-key-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("apiKeys.namePlaceholder")}
            maxLength={100}
            required
            autoFocus
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="api-key-expires">{t("apiKeys.expiresLabel")}</Label>
          <Select value={expiresIn} onValueChange={setExpiresIn}>
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
        </div>
        {createMutation.isError && (
          <p className="text-sm text-destructive">{createMutation.error.message}</p>
        )}
      </form>
    </Modal>
  );
}
