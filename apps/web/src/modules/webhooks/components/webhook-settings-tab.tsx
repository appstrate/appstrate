// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import { Button } from "@appstrate/ui/components/button";
import { Label } from "@appstrate/ui/components/label";
import { Checkbox } from "@appstrate/ui/components/checkbox";
import { ConfirmModal } from "@/components/confirm-modal";
import { Spinner } from "@/components/spinner";
import { WebhookFormFields } from "./webhook-form-fields";
import { toggleEvent } from "../hooks/use-webhooks";
import { SecretRevealModal } from "@/components/secret-reveal-modal";
import { toast } from "sonner";
import {
  useUpdateWebhook,
  useDeleteWebhook,
  useTestWebhook,
  useRotateWebhookSecret,
} from "../hooks/use-webhooks";
import type { WebhookEvent, WebhookInfo } from "../hooks/use-webhooks";
import { usePermissions } from "@/hooks/use-permissions";
import { webhookResource } from "@/lib/webhook-permissions";

/**
 * Settings tab for a webhook detail page.
 * Receives the loaded webhook — the parent must guard against undefined.
 */
export function WebhookSettingsTab({ webhook }: { webhook: WebhookInfo }) {
  const { t } = useTranslation(["settings", "common"]);
  const location = useLocation();
  const { can } = usePermissions();
  const navigate = useNavigate();
  // Save, test and rotate are all `write`.
  const resource = webhookResource(webhook.level);
  const canWrite = can(`${resource}:write`);
  const canDelete = can(`${resource}:delete`);
  const updateMutation = useUpdateWebhook();
  const deleteMutation = useDeleteWebhook();
  const testMutation = useTestWebhook();
  const rotateMutation = useRotateWebhookSecret();

  const [selectedEvents, setSelectedEvents] = useState<string[]>(webhook.events);
  const [payloadMode, setPayloadMode] = useState<"full" | "summary">(webhook.payloadMode);
  const [active, setActive] = useState(webhook.enabled);
  const [rotateOpen, setRotateOpen] = useState(false);
  const [rotatedSecret, setRotatedSecret] = useState<string | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  function handleSave() {
    updateMutation.mutate(
      {
        params: { path: { id: webhook.id } },
        // Form state holds plain strings; the wire enum cast is the same
        // trust boundary as the legacy untyped helper.
        body: { events: selectedEvents as WebhookEvent[], payloadMode, enabled: active },
      },
      {
        onSuccess: () => {
          toast.success(t("settings:webhooks.saved"));
        },
      },
    );
  }

  function handleTest() {
    testMutation.mutate(
      { params: { path: { id: webhook.id } } },
      {
        onSuccess: () => {
          toast.success(t("settings:webhooks.testSuccess"));
        },
        onError: () => {
          toast.error(t("settings:webhooks.testFailed"));
        },
      },
    );
  }

  function handleRotate() {
    rotateMutation.mutate(
      { params: { path: { id: webhook.id } } },
      {
        onSuccess: (result) => {
          setRotateOpen(false);
          setRotatedSecret(result.secret);
        },
      },
    );
  }

  function handleDelete() {
    deleteMutation.mutate(
      { params: { path: { id: webhook.id } } },
      {
        onSuccess: () => {
          navigate("/workspace-settings/webhooks", { state: location.state });
        },
      },
    );
  }

  return (
    <div className="space-y-6">
      {/* URL (read-only) */}
      <div className="space-y-2">
        <Label>{t("settings:webhooks.urlLabel")}</Label>
        <div className="bg-muted rounded px-3 py-2 font-mono text-sm break-all">{webhook.url}</div>
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
      {canWrite && (
        <Button onClick={handleSave} disabled={updateMutation.isPending}>
          {updateMutation.isPending ? <Spinner /> : t("settings:webhooks.saveSettings")}
        </Button>
      )}

      {/* Secret section */}
      <div className="border-border space-y-2 border-t pt-4">
        <Label>{t("settings:webhooks.secret")}</Label>
        <div className="bg-muted rounded px-3 py-2 font-mono text-sm">whsec_****...</div>
        {canWrite && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setRotateOpen(true)}
            disabled={rotateMutation.isPending}
          >
            {t("settings:webhooks.rotateSecret")}
          </Button>
        )}
      </div>

      {/* Rotate confirmation modal */}
      <ConfirmModal
        open={rotateOpen}
        onClose={() => setRotateOpen(false)}
        title={t("settings:webhooks.rotateConfirmTitle")}
        description={t("settings:webhooks.rotateConfirm")}
        confirmLabel={t("settings:webhooks.rotateSecret")}
        variant="default"
        isPending={rotateMutation.isPending}
        onConfirm={handleRotate}
      />

      {/* Rotated secret display */}
      {rotatedSecret && (
        <SecretRevealModal
          open={!!rotatedSecret}
          onClose={() => setRotatedSecret(null)}
          title={t("settings:webhooks.newSecret")}
          secret={rotatedSecret}
        />
      )}

      {/* Test — `POST /api/webhooks/:id/test` is guarded by `write`, not `read`. */}
      {canWrite && (
        <div className="border-border border-t pt-4">
          <Button
            variant="outline"
            size="sm"
            onClick={handleTest}
            disabled={testMutation.isPending}
          >
            {testMutation.isPending ? <Spinner /> : t("settings:webhooks.sendTest")}
          </Button>
        </div>
      )}

      {/* Danger zone */}
      {canDelete && (
        <div className="border-border space-y-3 border-t pt-4">
          <h3 className="text-destructive text-sm font-semibold">
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
      )}

      {/* Delete confirmation */}
      <ConfirmModal
        open={deleteConfirmOpen}
        onClose={() => setDeleteConfirmOpen(false)}
        title={t("settings:webhooks.deleteTitle")}
        description={t("settings:webhooks.deleteConfirm")}
        confirmLabel={t("common:btn.delete")}
        isPending={deleteMutation.isPending}
        onConfirm={handleDelete}
      />
    </div>
  );
}
