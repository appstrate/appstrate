// SPDX-License-Identifier: Apache-2.0

/**
 * Modal that walks the user through connecting an OAuth model provider
 * (Codex / Claude Code). Two stages:
 *
 *   1. **ToS warning**: explicit notice that the subscription quota is
 *      shared org-wide and that automated agentic use isn't covered by
 *      the provider's personal-tier ToS. The user must accept before
 *      moving on.
 *   2. **Label entry + redirect**: capture a friendly name for the
 *      connection, kick off the OAuth dance via `/initiate`, and
 *      full-page-redirect to the returned `authorizationUrl`.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "./modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useInitiateOAuthModelProvider } from "../hooks/use-model-provider-keys";

interface Props {
  open: boolean;
  providerPackageId: string;
  /** Pre-fill suggestion shown in the label input. */
  defaultLabel: string;
  onClose: () => void;
}

export function OAuthModelProviderDialog({
  open,
  providerPackageId,
  defaultLabel,
  onClose,
}: Props) {
  const { t } = useTranslation(["settings", "common"]);
  const [stage, setStage] = useState<"tos" | "label">("tos");
  const [label, setLabel] = useState(defaultLabel);
  const initiate = useInitiateOAuthModelProvider();

  function reset() {
    setStage("tos");
    setLabel(defaultLabel);
    initiate.reset();
  }

  function handleClose() {
    reset();
    onClose();
  }

  function handleSubmit() {
    if (!label.trim()) return;
    initiate.mutate(
      { providerPackageId, label: label.trim() },
      {
        onSuccess: ({ authorizationUrl }) => {
          // Full-page redirect — the OAuth callback returns the user to
          // /settings/models?connected=... or ?error=...
          window.location.href = authorizationUrl;
        },
      },
    );
  }

  if (stage === "tos") {
    return (
      <Modal
        open={open}
        onClose={handleClose}
        title={t("providerKeys.oauth.tosTitle")}
        actions={
          <>
            <Button variant="ghost" onClick={handleClose}>
              {t("providerKeys.oauth.cancel")}
            </Button>
            <Button onClick={() => setStage("label")}>{t("providerKeys.oauth.continue")}</Button>
          </>
        }
      >
        <div className="flex flex-col gap-3 text-sm">
          <p className="font-medium">{t("providerKeys.oauth.tosWarningTitle")}</p>
          <ul className="text-muted-foreground list-disc space-y-1 pl-5">
            <li>{t("providerKeys.oauth.tosBullet1")}</li>
            <li>{t("providerKeys.oauth.tosBullet2")}</li>
            <li>{t("providerKeys.oauth.tosBullet3")}</li>
            <li>{t("providerKeys.oauth.tosBullet4")}</li>
          </ul>
          <p className="text-xs">{t("providerKeys.oauth.tosFooter")}</p>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={t("providerKeys.oauth.tosTitle")}
      actions={
        <>
          <Button variant="ghost" onClick={handleClose} disabled={initiate.isPending}>
            {t("providerKeys.oauth.cancel")}
          </Button>
          <Button onClick={handleSubmit} disabled={!label.trim() || initiate.isPending}>
            {t("providerKeys.oauth.continue")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        <Label htmlFor="oauth-label">{t("providerKeys.oauth.labelLabel")}</Label>
        <Input
          id="oauth-label"
          autoFocus
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={t("providerKeys.oauth.labelPlaceholder")}
        />
        {initiate.error instanceof Error && (
          <p className="text-destructive text-xs">{initiate.error.message}</p>
        )}
      </div>
    </Modal>
  );
}
