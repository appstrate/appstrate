// SPDX-License-Identifier: Apache-2.0

/**
 * Asking an operator's own endpoint what it serves — or declining to. Never
 * implicit: detection spends a request against an unknown host.
 */

import { useTranslation } from "react-i18next";
import { Button } from "@appstrate/ui/components/button";
import { Spinner } from "../spinner";
import { discoveryErrorKey, type DiscoveryState } from "@/lib/model-discovery";

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
      {mode === "list" &&
        discovery &&
        (discovery.outcome === "ok" ? (
          <div className="text-muted-foreground text-sm">
            {discovery.models.length > 0
              ? t("models.form.discoverCount", { count: discovery.models.length })
              : t("models.form.discoverEmpty")}
            {/* A capped listing is short of what the endpoint serves — saying so
                is the difference between "these are the models" and "these are
                the first models". */}
            {discovery.truncated ? (
              <span className="block">{t("models.form.discoverTruncated")}</span>
            ) : null}
          </div>
        ) : (
          <div className="text-destructive text-sm">{t(discoveryErrorKey(discovery.outcome))}</div>
        ))}
    </div>
  );
}
