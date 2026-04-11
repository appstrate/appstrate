// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useForm } from "react-hook-form";
import { Modal } from "@/components/modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/spinner";
import { WebhookFormFields } from "./webhook-form-fields";
import { toggleEvent } from "../hooks/use-webhooks";
import { SecretRevealModal } from "@/components/secret-reveal-modal";
import { useCreateWebhook } from "../hooks/use-webhooks";

interface Props {
  open: boolean;
  onClose: () => void;
}

type FormData = {
  url: string;
};

export function WebhookCreateModal({ open, onClose }: Props) {
  const { t } = useTranslation(["settings", "common"]);
  const createMutation = useCreateWebhook();

  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const [selectedEvents, setSelectedEvents] = useState<string[]>([]);
  const [payloadMode, setPayloadMode] = useState<"full" | "summary">("full");

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors },
  } = useForm<FormData>({
    defaultValues: { url: "" },
  });

  const handleClose = () => {
    reset({ url: "" });
    setCreatedSecret(null);
    setSelectedEvents([]);
    setPayloadMode("full");
    createMutation.reset();
    onClose();
  };

  function onFormSubmit(data: FormData) {
    if (selectedEvents.length === 0) {
      setError("root", { message: t("settings:webhooks.eventsRequired") });
      return;
    }

    createMutation.mutate(
      {
        url: data.url.trim(),
        events: selectedEvents,
        payloadMode,
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

  // Step 2: show the secret
  if (createdSecret) {
    return (
      <SecretRevealModal
        open={open}
        onClose={handleClose}
        title={t("settings:webhooks.created")}
        secret={createdSecret}
      />
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
          {errors.url ? (
            <p className="text-destructive text-xs">{t("settings:webhooks.urlHint")}</p>
          ) : (
            <p className="text-muted-foreground text-xs">{t("settings:webhooks.urlHint")}</p>
          )}
        </div>

        <WebhookFormFields
          selectedEvents={selectedEvents}
          onToggleEvent={(e) => toggleEvent(e, setSelectedEvents)}
          payloadMode={payloadMode}
          onPayloadModeChange={setPayloadMode}
          idPrefix="create-"
        />

        {errors.root?.message && <p className="text-destructive text-sm">{errors.root.message}</p>}
      </form>
    </Modal>
  );
}
