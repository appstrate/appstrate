// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useForm } from "react-hook-form";
import { useModalParam } from "@/hooks/use-modal-param";
import { FormModal } from "@/components/form-modal";
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";
import { FormItem } from "@appstrate/ui/components/field";
import { WebhookFormFields } from "./webhook-form-fields";
import { toggleValue } from "@/lib/toggle-value";
import { SecretRevealModal } from "@/components/secret-reveal-modal";
import { useCreateWebhook } from "../hooks/use-webhooks";
import { errorMessage } from "../../../lib/mutation-error";
import { RadioGroup, RadioGroupItem } from "@appstrate/ui/components/radio-group";
import type { WebhookInfo } from "../hooks/use-webhooks";

type Level = WebhookInfo["level"];

/** The URL parameter that opens the modal. The secret step has no URL of its own. */
export const NEW_WEBHOOK_PARAM = "newWebhook";

interface Props {
  /** Levels the caller may create at — never empty (the page gates the button). */
  levels: readonly Level[];
}

type FormData = {
  url: string;
};

export function WebhookCreateModal({ levels }: Props) {
  const { t } = useTranslation(["settings"]);
  const param = useModalParam(NEW_WEBHOOK_PARAM);
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);

  // Step 2: the secret, shown once. It has no address: the creation's one goes away as it appears.
  if (createdSecret) {
    return (
      <SecretRevealModal
        onClose={() => setCreatedSecret(null)}
        title={t("settings:webhooks.created")}
        secret={createdSecret}
        warning={t("settings:webhooks.secretWarning")}
      />
    );
  }
  // The form exists only while the modal is open, so any way of closing it (Annuler, a click
  // outside, Escape, Back) abandons what was typed.
  if (param.value === null) return null;
  return (
    <WebhookCreateForm
      levels={levels}
      onClose={param.close}
      onCreated={(secret) => {
        setCreatedSecret(secret);
        param.close();
      }}
    />
  );
}

function WebhookCreateForm({
  levels,
  onClose,
  onCreated,
}: Props & { onClose: () => void; onCreated: (secret: string) => void }) {
  const { t } = useTranslation(["settings", "common"]);
  const createMutation = useCreateWebhook();
  const [selectedEvents, setSelectedEvents] = useState<string[]>([]);
  const [payloadMode, setPayloadMode] = useState<"full" | "summary">("full");
  const [chosenLevel, setChosenLevel] = useState<Level>("space");
  // Keys spelled out: the locale-key scan cannot follow a template literal.
  const levelLabels: Record<Level, string> = {
    space: t("settings:webhooks.level.space"),
    org: t("settings:webhooks.level.org"),
  };
  // A caller holding one grant only has no choice to make.
  const level = levels.includes(chosenLevel) ? chosenLevel : levels[0]!;

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<FormData>({
    defaultValues: { url: "" },
  });

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
        onSuccess: (result) => onCreated(result.secret),
        onError: (err) => {
          setError("root", { message: errorMessage(err) });
        },
      },
    );
  }

  return (
    <FormModal
      onClose={onClose}
      title={t("settings:webhooks.createTitle")}
      onSubmit={handleSubmit(onFormSubmit)}
      isPending={createMutation.isPending}
      submitLabel={t("settings:webhooks.createBtn")}
      error={errors.root?.message}
    >
      <FormItem
        id="webhook-url"
        label={t("settings:webhooks.urlLabel")}
        hint={errors.url ? undefined : t("settings:webhooks.urlHint")}
        error={errors.url ? t("settings:webhooks.urlHint") : undefined}
      >
        <Input
          type="url"
          {...register("url", {
            required: true,
            pattern: /^https:\/\/.+/,
          })}
          placeholder={t("settings:webhooks.urlPlaceholder")}
          autoFocus
        />
      </FormItem>

      {/* Never create an organization-wide webhook without saying so. */}
      {levels.length === 1 && level === "org" && (
        <div className="space-y-2">
          <Label>{t("settings:webhooks.levelLabel")}</Label>
          <p className="text-sm">{levelLabels.org}</p>
        </div>
      )}

      {levels.length > 1 && (
        <div className="space-y-2">
          <Label>{t("settings:webhooks.levelLabel")}</Label>
          <RadioGroup value={level} onValueChange={(v) => setChosenLevel(v as Level)}>
            {levels.map((l) => (
              <div key={l} className="flex items-center gap-2">
                <RadioGroupItem value={l} id={`create-level-${l}`} />
                <Label htmlFor={`create-level-${l}`} className="cursor-pointer font-normal">
                  {levelLabels[l]}
                </Label>
              </div>
            ))}
          </RadioGroup>
        </div>
      )}

      <WebhookFormFields
        selectedEvents={selectedEvents}
        onToggleEvent={(e) => setSelectedEvents((prev) => toggleValue(prev, e))}
        payloadMode={payloadMode}
        onPayloadModeChange={setPayloadMode}
        idPrefix="create-"
      />
    </FormModal>
  );
}
