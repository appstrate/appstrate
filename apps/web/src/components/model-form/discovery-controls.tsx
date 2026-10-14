// SPDX-License-Identifier: Apache-2.0

/**
 * Asking an operator's own endpoint what it serves — or declining to. Never
 * implicit: detection spends a request against an unknown host.
 */

import { useTranslation } from "react-i18next";
import { Button } from "@appstrate/ui/components/button";
import { Spinner } from "../spinner";
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
        <Button
          type="button"
          variant={mode === "list" ? "default" : "outline"}
          onClick={onDiscover}
          disabled={isPending}
        >
          {isPending ? <Spinner /> : t("models.form.discoverButton")}
        </Button>
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
