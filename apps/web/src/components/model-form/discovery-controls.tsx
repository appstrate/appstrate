// SPDX-License-Identifier: Apache-2.0

/**
 * Asking an operator's own endpoint what it serves — or declining to. Never
 * implicit: detection spends a request against an unknown host.
 */

import { PendingButton } from "@/components/app-ui/pending-button";
import { useTranslation } from "react-i18next";
import { Button } from "@appstrate/ui/components/button";
import type { DiscoveryState } from "@/lib/model-discovery";
import { DiscoveryResult } from "./discovery-result";

export function DiscoveryControls({
  mode,
  discovery,
  isPending,
  onDiscover,
  onManual,
}: {
  mode: "list" | "manual" | null;
  /** This endpoint's listing, or `null` while none has been asked for. */
  discovery: DiscoveryState | null;
  isPending: boolean;
  onDiscover: () => void;
  onManual: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <PendingButton
          type="button"
          variant={mode === "list" ? "default" : "outline"}
          onClick={onDiscover}
          pending={isPending}
        >
          {t("models.form.discoverButton")}
        </PendingButton>
        <Button
          type="button"
          variant={mode === "manual" ? "default" : "outline"}
          onClick={onManual}
        >
          {t("models.form.manualButton")}
        </Button>
      </div>
      {mode === "list" && discovery && <DiscoveryResult discovery={discovery} />}
    </div>
  );
}
