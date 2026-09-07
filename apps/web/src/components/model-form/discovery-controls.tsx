// SPDX-License-Identifier: Apache-2.0

/**
 * Asking an operator's own endpoint what it serves — or declining to.
 *
 * Detection spends a request against a host the platform knows nothing about,
 * so it is never implicit: until one of the two buttons is pressed there is
 * nothing below them, and whatever the endpoint answered is stated in the same
 * place, successes and failures alike.
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
          </div>
        ) : (
          <div className="text-destructive text-sm">{t(discoveryErrorKey(discovery.outcome))}</div>
        ))}
    </div>
  );
}
