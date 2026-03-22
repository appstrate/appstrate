import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useForm } from "react-hook-form";
import { Modal } from "./modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "./spinner";
import { WEBHOOK_EVENTS, useCreateWebhook } from "../hooks/use-webhooks";

interface Props {
  open: boolean;
  onClose: () => void;
}

type FormData = {
  url: string;
  payloadMode: "full" | "summary";
};

export function WebhookCreateModal({ open, onClose }: Props) {
  const { t } = useTranslation(["settings", "common"]);
  const createMutation = useCreateWebhook();

  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [selectedEvents, setSelectedEvents] = useState<string[]>([]);

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors },
  } = useForm<FormData>({
    defaultValues: { url: "", payloadMode: "full" },
  });

  const handleClose = () => {
    reset({ url: "", payloadMode: "full" });
    setCreatedSecret(null);
    setCopied(false);
    setSelectedEvents([]);
    createMutation.reset();
    onClose();
  };

  function toggleEvent(event: string) {
    setSelectedEvents((prev) =>
      prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event],
    );
  }

  function onFormSubmit(data: FormData) {
    if (selectedEvents.length === 0) {
      setError("root", { message: t("settings:webhooks.eventsRequired") });
      return;
    }

    createMutation.mutate(
      {
        url: data.url.trim(),
        events: selectedEvents,
        payloadMode: data.payloadMode,
      },
      {
        onSuccess: (result) => {
          setCreatedSecret(result.secret);
        },
        onError: (err) => {
          setError("root", { message: err instanceof Error ? err.message : String(err) });
        },
      },
    );
  }

  const onSubmit = handleSubmit(onFormSubmit);

  const handleCopy = () => {
    if (createdSecret) {
      navigator.clipboard.writeText(createdSecret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // Step 2: show the secret
  if (createdSecret) {
    return (
      <Modal open={open} onClose={handleClose} title={t("settings:webhooks.created")}>
        <p className="text-sm text-warning bg-warning/10 rounded-md px-3 py-2">
          {t("settings:webhooks.secretWarning")}
        </p>
        <div className="flex items-center gap-2 mt-3 rounded-md border border-border bg-muted/50 px-3 py-2">
          <code className="flex-1 text-xs font-mono text-foreground break-all">
            {createdSecret}
          </code>
          <Button
            variant="ghost"
            size="sm"
            className="text-xs text-primary hover:underline shrink-0"
            onClick={handleCopy}
          >
            {copied ? t("common:btn.copied") : t("common:btn.copyLink")}
          </Button>
        </div>
        <div className="flex justify-end gap-2 mt-4 pt-4 border-t border-border">
          <Button onClick={handleClose}>{t("common:btn.done")}</Button>
        </div>
      </Modal>
    );
  }

  // Step 1: creation form
  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={t("settings:webhooks.createTitle")}
      actions={
        <>
          <Button variant="outline" type="button" onClick={handleClose}>
            {t("common:btn.cancel")}
          </Button>
          <Button type="submit" form="create-webhook-form" disabled={createMutation.isPending}>
            {createMutation.isPending ? <Spinner /> : t("settings:webhooks.createBtn")}
          </Button>
        </>
      }
    >
      <form id="create-webhook-form" onSubmit={onSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="webhook-url">{t("settings:webhooks.urlLabel")}</Label>
          <Input
            id="webhook-url"
            type="url"
            {...register("url", {
              required: true,
              pattern: /^https:\/\/.+/,
            })}
            placeholder={t("settings:webhooks.urlPlaceholder")}
            autoFocus
          />
          <p className="text-xs text-muted-foreground">{t("settings:webhooks.urlHint")}</p>
        </div>

        <div className="space-y-2">
          <Label>{t("settings:webhooks.eventsLabel")}</Label>
          <div className="space-y-2">
            {WEBHOOK_EVENTS.map((event) => (
              <label key={event} className="flex items-center gap-2 cursor-pointer">
                <Checkbox
                  checked={selectedEvents.includes(event)}
                  onCheckedChange={() => toggleEvent(event)}
                />
                <span className="text-sm font-mono">{event}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <Label>{t("settings:webhooks.payloadModeLabel")}</Label>
          <div className="space-y-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                value="full"
                {...register("payloadMode")}
                className="accent-primary"
              />
              <span className="text-sm">{t("settings:webhooks.payloadModeFull")}</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                value="summary"
                {...register("payloadMode")}
                className="accent-primary"
              />
              <span className="text-sm">{t("settings:webhooks.payloadModeSummary")}</span>
            </label>
          </div>
        </div>

        {errors.root?.message && <p className="text-sm text-destructive">{errors.root.message}</p>}
      </form>
    </Modal>
  );
}
