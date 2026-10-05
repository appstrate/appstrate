// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useForm } from "react-hook-form";
import { Modal } from "@/components/modal";
import { Button } from "@appstrate/ui/components/button";
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";
import { Spinner } from "@/components/spinner";
import { WebhookFormFields } from "./webhook-form-fields";
import { toggleEvent } from "../hooks/use-webhooks";
import { SecretRevealModal } from "@/components/secret-reveal-modal";
import { useCreateWebhook } from "../hooks/use-webhooks";
import { getErrorMessage } from "@appstrate/core/errors";
import { RadioGroup, RadioGroupItem } from "@appstrate/ui/components/radio-group";
import type { WebhookInfo } from "../hooks/use-webhooks";

type Level = WebhookInfo["level"];

interface Props {
  open: boolean;
  onClose: () => void;
  /** Levels the caller may create at — never empty (the page gates the button). */
  levels: readonly Level[];
}

type FormData = {
  url: string;
};

export function WebhookCreateModal({ open, onClose, levels }: Props) {
  const { t } = useTranslation(["settings", "common"]);
  const createMutation = useCreateWebhook();

  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const [selectedEvents, setSelectedEvents] = useState<string[]>([]);
  const [payloadMode, setPayloadMode] = useState<"full" | "summary">("full");
  const [chosenLevel, setChosenLevel] = useState<Level>("space");
  // A caller holding one grant only has no choice to make.
  const level = levels.includes(chosenLevel) ? chosenLevel : levels[0]!;

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
    setChosenLevel("space");
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
        level,
        url: data.url.trim(),
        events: selectedEvents,
        payloadMode,
      },
      {
        onSuccess: (result) => {
          setCreatedSecret(result.secret);
        },
        onError: (err) => {
          setError("root", { message: getErrorMessage(err) });
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

        {levels.length > 1 && (
          <div className="space-y-2">
            <Label>{t("settings:webhooks.levelLabel")}</Label>
            <RadioGroup value={level} onValueChange={(v) => setChosenLevel(v as Level)}>
              {levels.map((l) => (
                <div key={l} className="flex items-center gap-2">
                  <RadioGroupItem value={l} id={`create-level-${l}`} />
                  <Label htmlFor={`create-level-${l}`} className="cursor-pointer font-normal">
                    {t(`settings:webhooks.level.${l}`)}
                  </Label>
                </div>
              ))}
            </RadioGroup>
          </div>
        )}

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
