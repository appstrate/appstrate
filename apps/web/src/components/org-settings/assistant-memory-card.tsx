// SPDX-License-Identifier: Apache-2.0

import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@appstrate/ui/components/button";
import { Checkbox } from "@appstrate/ui/components/checkbox";
import { Label } from "@appstrate/ui/components/label";
import { $api } from "../../api/client";
import { ConfirmModal } from "../confirm-modal";
import { Spinner } from "../spinner";
import { useOrgSettings, useUpdateOrgSettings } from "../../hooks/use-org-settings";

/**
 * The organization's switch for the assistant's memory of its members. The
 * memory itself is each member's own: the admin never reads it, and turning it
 * off can also erase what the members' assistants learned here.
 */
export function AssistantMemoryCard({ orgId }: { orgId: string }) {
  const { t } = useTranslation(["settings", "common"]);
  const eraseId = useId();
  const { data: orgSettings } = useOrgSettings();
  const update = useUpdateOrgSettings();
  const erase = $api.useMutation("delete", "/api/orgs/{orgId}/memories");
  const [confirming, setConfirming] = useState(false);
  const [alsoErase, setAlsoErase] = useState(false);
  const enabled = orgSettings?.assistant_memory !== false;
  const pending = update.isPending || erase.isPending;

  const setEnabled = (value: boolean, onSuccess?: () => void) =>
    update.mutate(
      { params: { path: { orgId } }, body: { assistant_memory: value } },
      {
        onSuccess: () => {
          toast.success(
            value
              ? t("orgSettings.assistantMemoryEnabled")
              : t("orgSettings.assistantMemoryDisabled"),
          );
          onSuccess?.();
        },
      },
    );

  return (
    <div className="border-border bg-card mb-4 rounded-lg border p-5">
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <h3 className="text-sm font-semibold">{t("orgSettings.assistantMemoryTitle")}</h3>
          <span className="text-muted-foreground text-sm">
            {t("orgSettings.assistantMemoryDesc")}
          </span>
        </div>
        <Button
          variant={enabled ? "default" : "outline"}
          disabled={pending}
          onClick={() => (enabled ? setConfirming(true) : setEnabled(true))}
        >
          {pending ? (
            <Spinner />
          ) : enabled ? (
            t("orgSettings.assistantMemoryDisable")
          ) : (
            t("orgSettings.assistantMemoryEnable")
          )}
        </Button>
      </div>
      <ConfirmModal
        open={confirming}
        title={t("orgSettings.assistantMemoryConfirmTitle")}
        description={t("orgSettings.assistantMemoryConfirmDesc")}
        confirmLabel={t("orgSettings.assistantMemoryDisable")}
        variant="destructive"
        isPending={pending}
        onConfirm={() =>
          setEnabled(false, () => {
            if (alsoErase) erase.mutate({ params: { path: { orgId } } });
            setConfirming(false);
            setAlsoErase(false);
          })
        }
        onClose={() => {
          setConfirming(false);
          setAlsoErase(false);
        }}
      >
        <div className="mt-3 flex items-start gap-2">
          <Checkbox
            id={eraseId}
            checked={alsoErase}
            onCheckedChange={(checked) => setAlsoErase(Boolean(checked))}
          />
          <Label htmlFor={eraseId} className="text-sm font-normal">
            {t("orgSettings.assistantMemoryErase")}
          </Label>
        </div>
      </ConfirmModal>
    </div>
  );
}
