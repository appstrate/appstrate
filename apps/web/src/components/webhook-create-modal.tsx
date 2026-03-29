import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useForm } from "react-hook-form";
import { Modal } from "./modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "./spinner";
import { WebhookFormFields } from "./webhook-form-fields";
import { toggleEvent } from "../hooks/use-webhooks";
import { SecretRevealModal } from "./secret-reveal-modal";
import { useCreateWebhook } from "../hooks/use-webhooks";
import { useApplications } from "../hooks/use-applications";

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
  const { data: applications } = useApplications();

  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const [scope, setScope] = useState<"organization" | "application">("organization");
  const [applicationId, setApplicationId] = useState<string>("");
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
    setScope("organization");
    setApplicationId("");
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

    if (scope === "application" && !applicationId) {
      setError("root", { message: t("settings:webhooks.applicationRequired") });
      return;
    }

    createMutation.mutate(
      {
        scope,
        ...(scope === "application" ? { applicationId } : {}),
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
        {/* Scope */}
        <div className="space-y-2">
          <Label>{t("settings:webhooks.scopeLabel")}</Label>
          <RadioGroup
            value={scope}
            onValueChange={(v) => setScope(v as "organization" | "application")}
          >
            <div className="flex items-start gap-2">
              <RadioGroupItem value="organization" id="scope-org" className="mt-0.5" />
              <div>
                <Label htmlFor="scope-org" className="font-normal cursor-pointer">
                  {t("settings:webhooks.scopeOrganization")}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t("settings:webhooks.scopeOrganizationDesc")}
                </p>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <RadioGroupItem value="application" id="scope-app" className="mt-0.5" />
              <div>
                <Label htmlFor="scope-app" className="font-normal cursor-pointer">
                  {t("settings:webhooks.scopeApplication")}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t("settings:webhooks.scopeApplicationDesc")}
                </p>
              </div>
            </div>
          </RadioGroup>
        </div>

        {/* Application selector (only when scope = application) */}
        {scope === "application" && (
          <div className="space-y-2">
            <Label>{t("settings:webhooks.applicationLabel")}</Label>
            <Select value={applicationId} onValueChange={setApplicationId}>
              <SelectTrigger>
                <SelectValue placeholder={t("settings:webhooks.applicationLabel")} />
              </SelectTrigger>
              <SelectContent>
                {(applications ?? []).map((app) => (
                  <SelectItem key={app.id} value={app.id}>
                    {app.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

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
            <p className="text-xs text-destructive">{t("settings:webhooks.urlHint")}</p>
          ) : (
            <p className="text-xs text-muted-foreground">{t("settings:webhooks.urlHint")}</p>
          )}
        </div>

        <WebhookFormFields
          selectedEvents={selectedEvents}
          onToggleEvent={(e) => toggleEvent(e, setSelectedEvents)}
          payloadMode={payloadMode}
          onPayloadModeChange={setPayloadMode}
          idPrefix="create-"
        />

        {errors.root?.message && <p className="text-sm text-destructive">{errors.root.message}</p>}
      </form>
    </Modal>
  );
}
