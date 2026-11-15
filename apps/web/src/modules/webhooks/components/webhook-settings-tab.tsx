// SPDX-License-Identifier: Apache-2.0

import { PendingButton } from "@/components/app-ui/pending-button";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Button } from "@appstrate/ui/components/button";
import { Label } from "@appstrate/ui/components/label";
import { Switch } from "@appstrate/ui/components/switch";
import { ConfirmModal } from "@/components/confirm-modal";
import { WebhookFormFields } from "./webhook-form-fields";
import { toggleValue } from "@/lib/toggle-value";
import { SecretRevealModal } from "@/components/secret-reveal-modal";
import { toast } from "sonner";
import { ManualSave } from "@/components/settings/manual-save";
import { SaveFeedback } from "@/components/settings/save-feedback";
import { SettingRow, SettingsGroup } from "@/components/settings/setting-row";
import { useSettingDraft } from "@/hooks/use-setting-draft";
import { fieldWriteState } from "@/lib/field-write-state";
import {
  WEBHOOK_EVENTS,
  useUpdateWebhook,
  useDeleteWebhook,
  useTestWebhook,
  useRotateWebhookSecret,
} from "../hooks/use-webhooks";
import type { WebhookEvent, WebhookInfo } from "../hooks/use-webhooks";
import { usePermissions } from "@/hooks/use-permissions";
import { webhookResource } from "@/lib/webhook-permissions";

const catalogueIndex = (event: string) => WEBHOOK_EVENTS.indexOf(event as WebhookEvent);
const inCatalogueOrder = (events: readonly string[]) =>
  [...events].sort((a, b) => catalogueIndex(a) - catalogueIndex(b));

/**
 * Settings tab for a webhook detail page.
 * Receives the loaded webhook — the parent must guard against undefined.
 */
export function WebhookSettingsTab({ webhook }: { webhook: WebhookInfo }) {
  const { t } = useTranslation(["settings", "common"]);
  const { can } = usePermissions();
  const navigate = useNavigate();
  // Save, test and rotate are all `write`.
  const resource = webhookResource(webhook.level);
  const canWrite = can(`${resource}:write`);
  const canDelete = can(`${resource}:delete`);
  // Two writes of one resource: the draft's Save and the Active switch, which says its own result.
  const saveMutation = useUpdateWebhook();
  const activeMutation = useUpdateWebhook();
  const deleteMutation = useDeleteWebhook();
  const testMutation = useTestWebhook();
  const rotateMutation = useRotateWebhookSecret();

  // Events and payload mode are one draft with Save; Active is a single choice, written as it is
  // picked. Events are kept in the catalogue's order so re-ticking one does not read as an edit.
  const draft = useSettingDraft({
    events: inCatalogueOrder(webhook.events),
    payloadMode: webhook.payloadMode,
  });
  const [rotateOpen, setRotateOpen] = useState(false);
  const [rotatedSecret, setRotatedSecret] = useState<string | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  const save = async () => {
    const sent = draft.value;
    const saved = await saveMutation.mutateAsync({
      params: { path: { id: webhook.id } },
      // Form state holds plain strings; the wire enum cast is the same
      // trust boundary as the legacy untyped helper.
      body: { events: sent.events as WebhookEvent[], payloadMode: sent.payloadMode },
    });
    draft.accept(sent, {
      events: inCatalogueOrder(saved.events),
      payloadMode: saved.payloadMode,
    });
  };

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
          toast.success(t("settings:webhooks.deleted"));
          navigate("/workspace-settings/webhooks");
        },
      },
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* URL (read-only) */}
      <div className="flex flex-col gap-2">
        <Label className="mb-0">{t("settings:webhooks.urlLabel")}</Label>
        <div className="bg-muted rounded px-3 py-2 font-mono text-sm break-all">{webhook.url}</div>
      </div>

      <fieldset disabled={!canWrite || saveMutation.isPending} className="flex flex-col gap-6">
        <WebhookFormFields
          selectedEvents={draft.value.events}
          onToggleEvent={(e) =>
            draft.set((prev) => ({
              ...prev,
              events: inCatalogueOrder(toggleValue(prev.events, e)),
            }))
          }
          payloadMode={draft.value.payloadMode}
          onPayloadModeChange={(payloadMode) => draft.set((prev) => ({ ...prev, payloadMode }))}
          idPrefix="edit-"
        />
      </fieldset>
      {canWrite && <ManualSave dirty={draft.dirty} onSave={save} onDiscard={draft.reset} />}

      <SettingRow
        variant="toggle"
        label={
          <Label htmlFor="webhook-active" className="cursor-pointer">
            {t("settings:webhooks.activeLabel")}
          </Label>
        }
        status={<SaveFeedback {...fieldWriteState(activeMutation, "enabled")} />}
        className="pb-0"
      >
        <Switch
          id="webhook-active"
          checked={webhook.enabled}
          disabled={!canWrite || activeMutation.isPending}
          onCheckedChange={(enabled) =>
            activeMutation.mutate({ params: { path: { id: webhook.id } }, body: { enabled } })
          }
        />
      </SettingRow>

      {/* Secret section */}
      <div className="border-border flex flex-col gap-2 border-t pt-4">
        <Label className="mb-0">{t("settings:webhooks.secret")}</Label>
        <div className="bg-muted rounded px-3 py-2 font-mono text-sm">whsec_****...</div>
        {canWrite && (
          <Button
            variant="outline"
            size="sm"
            className="self-start"
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
        title={t("settings:webhooks.rotateSecret")}
        description={t("settings:webhooks.rotateConfirm")}
        confirmLabel={t("settings:webhooks.rotateSecret")}
        variant="default"
        isPending={rotateMutation.isPending}
        onConfirm={handleRotate}
      />

      {/* Rotated secret display */}
      {rotatedSecret && (
        <SecretRevealModal
          onClose={() => setRotatedSecret(null)}
          title={t("settings:webhooks.newSecret")}
          secret={rotatedSecret}
          warning={t("settings:webhooks.secretWarning")}
        />
      )}

      {/* Test — `POST /api/webhooks/:id/test` is guarded by `write`, not `read`. */}
      {canWrite && (
        <div className="border-border border-t pt-4">
          <PendingButton
            variant="outline"
            size="sm"
            onClick={handleTest}
            pending={testMutation.isPending}
          >
            {t("settings:webhooks.sendTest")}
          </PendingButton>
        </div>
      )}

      {canDelete && (
        <SettingsGroup title={t("settings:spaces.dangerZone")} className="mb-0">
          <SettingRow
            variant="action"
            label={t("settings:webhooks.deleteTitle")}
            description={t("settings:webhooks.deleteConfirm")}
          >
            <PendingButton
              variant="destructive"
              onClick={() => setDeleteConfirmOpen(true)}
              pending={deleteMutation.isPending}
            >
              {t("settings:webhooks.deleteBtn")}
            </PendingButton>
          </SettingRow>
        </SettingsGroup>
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
