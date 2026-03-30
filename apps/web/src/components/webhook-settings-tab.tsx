import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Modal } from "./modal";
import { Spinner } from "./spinner";
import { WebhookFormFields } from "./webhook-form-fields";
import { toggleEvent } from "../hooks/use-webhooks";
import { SecretRevealModal } from "./secret-reveal-modal";
import { toast } from "../hooks/use-toast";
import {
  useUpdateWebhook,
  useDeleteWebhook,
  useTestWebhook,
  useRotateWebhookSecret,
} from "../hooks/use-webhooks";
import type { WebhookInfo } from "../hooks/use-webhooks";

/**
 * Settings tab for a webhook detail page.
 * Receives the loaded webhook — the parent must guard against undefined.
 */
export function WebhookSettingsTab({ webhook }: { webhook: WebhookInfo }) {
  const { t } = useTranslation(["settings", "common"]);
  const navigate = useNavigate();
  const updateMutation = useUpdateWebhook();
  const deleteMutation = useDeleteWebhook();
  const testMutation = useTestWebhook();
  const rotateMutation = useRotateWebhookSecret();

  const [selectedEvents, setSelectedEvents] = useState<string[]>(webhook.events);
  const [payloadMode, setPayloadMode] = useState<"full" | "summary">(webhook.payloadMode);
  const [active, setActive] = useState(webhook.active);
  const [rotateOpen, setRotateOpen] = useState(false);
  const [rotatedSecret, setRotatedSecret] = useState<string | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  function handleSave() {
    updateMutation.mutate(
      {
        id: webhook.id,
        data: { events: selectedEvents, payloadMode, active },
      },
      {
        onSuccess: () => {
          toast({ title: t("common:btn.save") });
        },
      },
    );
  }

  function handleTest() {
    testMutation.mutate(webhook.id, {
      onSuccess: () => {
        toast({ title: t("settings:webhooks.testSuccess") });
      },
      onError: () => {
        toast({ title: t("settings:webhooks.testFailed"), variant: "destructive" });
      },
    });
  }

  function handleRotate() {
    rotateMutation.mutate(webhook.id, {
      onSuccess: (result) => {
        setRotateOpen(false);
        setRotatedSecret(result.secret);
      },
    });
  }

  function handleDelete() {
    deleteMutation.mutate(webhook.id, {
      onSuccess: () => {
        navigate("/webhooks");
      },
    });
  }

  return (
    <div className="space-y-6">
      {/* URL (read-only) */}
      <div className="space-y-2">
        <Label>{t("settings:webhooks.urlLabel")}</Label>
        <div className="font-mono text-sm bg-muted rounded px-3 py-2 break-all">{webhook.url}</div>
      </div>

      <WebhookFormFields
        selectedEvents={selectedEvents}
        onToggleEvent={(e) => toggleEvent(e, setSelectedEvents)}
        payloadMode={payloadMode}
        onPayloadModeChange={setPayloadMode}
        idPrefix="edit-"
      />

      {/* Active toggle */}
      <div className="flex items-center gap-2">
        <Checkbox
          id="webhook-active"
          checked={active}
          onCheckedChange={(checked) => setActive(checked === true)}
        />
        <Label htmlFor="webhook-active" className="cursor-pointer">
          {t("settings:webhooks.active")}
        </Label>
      </div>

      {/* Save */}
      <Button onClick={handleSave} disabled={updateMutation.isPending}>
        {updateMutation.isPending ? <Spinner /> : t("settings:webhooks.saveSettings")}
      </Button>

      {/* Secret section */}
      <div className="space-y-2 pt-4 border-t border-border">
        <Label>{t("settings:webhooks.secret")}</Label>
        <div className="font-mono text-sm bg-muted rounded px-3 py-2">whsec_****...</div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setRotateOpen(true)}
          disabled={rotateMutation.isPending}
        >
          {t("settings:webhooks.rotateSecret")}
        </Button>
      </div>

      {/* Rotate confirmation modal */}
      <Modal
        open={rotateOpen}
        onClose={() => setRotateOpen(false)}
        title={t("settings:webhooks.rotateConfirmTitle")}
        actions={
          <>
            <Button variant="outline" onClick={() => setRotateOpen(false)}>
              {t("common:btn.cancel")}
            </Button>
            <Button onClick={handleRotate} disabled={rotateMutation.isPending}>
              {rotateMutation.isPending ? <Spinner /> : t("common:btn.confirm")}
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted-foreground">{t("settings:webhooks.rotateConfirm")}</p>
      </Modal>

      {/* Rotated secret display */}
      {rotatedSecret && (
        <SecretRevealModal
          open={!!rotatedSecret}
          onClose={() => setRotatedSecret(null)}
          title={t("settings:webhooks.newSecret")}
          secret={rotatedSecret}
        />
      )}

      {/* Test */}
      <div className="pt-4 border-t border-border">
        <Button variant="outline" size="sm" onClick={handleTest} disabled={testMutation.isPending}>
          {testMutation.isPending ? <Spinner /> : t("settings:webhooks.sendTest")}
        </Button>
      </div>

      {/* Danger zone */}
      <div className="pt-4 border-t border-border space-y-3">
        <h3 className="text-sm font-semibold text-destructive">
          {t("settings:webhooks.dangerZone")}
        </h3>
        <Button
          variant="destructive"
          size="sm"
          onClick={() => setDeleteConfirmOpen(true)}
          disabled={deleteMutation.isPending}
        >
          {deleteMutation.isPending ? <Spinner /> : t("settings:webhooks.deleteBtn")}
        </Button>
      </div>

      {/* Delete confirmation */}
      <Modal
        open={deleteConfirmOpen}
        onClose={() => setDeleteConfirmOpen(false)}
        title={t("settings:webhooks.deleteConfirm")}
        actions={
          <>
            <Button variant="outline" onClick={() => setDeleteConfirmOpen(false)}>
              {t("common:btn.cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? <Spinner /> : t("common:btn.confirm")}
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted-foreground">{t("settings:webhooks.deleteConfirm")}</p>
      </Modal>
    </div>
  );
}
