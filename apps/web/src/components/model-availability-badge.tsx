// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Badge } from "@appstrate/ui/components/badge";
import { isModelSelectable } from "../lib/model-selectability";
import type { OrgModelInfo } from "../hooks/use-models";

/**
 * "This model's credential can no longer serve inference" — the read-side
 * counterpart of `needs_reconnection`. Mirrors the badge the credentials table
 * already renders for the credential itself, so the two tables read the same.
 *
 * Wording is credential-neutral on purpose: the flag is also raised for an
 * api-key credential whose stored secret no longer decrypts, where
 * "reconnect the OAuth account" would be wrong advice.
 */
export function ModelUnavailableBadge({ className }: { className?: string }) {
  const { t } = useTranslation("settings");
  return (
    <Badge
      variant="destructive"
      className={className}
      title={t("models.credentialUnavailableHint")}
    >
      {t("models.credentialUnavailable")}
    </Badge>
  );
}

/**
 * The same information inline, for the model `<Select>`s: a picker renders
 * every model but only lets {@link isModelSelectable} ones be chosen, and a
 * greyed row with no stated reason is what made this bug confusing in the
 * first place. A `<span>` rather than the `<Badge>` (a `<div>`) because Radix
 * puts `SelectItem` children inside `SelectItemText`'s span — and clones them
 * into the closed trigger, so a pinned-but-dead model states its reason
 * without opening the dropdown.
 *
 * Renders nothing for a selectable model.
 */
export function ModelUnselectableNote({ model }: { model: OrgModelInfo }) {
  const { t } = useTranslation("settings");
  if (isModelSelectable(model)) return null;
  if (model.needs_reconnection) {
    return (
      <span className="text-destructive text-xs" title={t("models.credentialUnavailableHint")}>
        ({t("models.credentialUnavailable")})
      </span>
    );
  }
  return <span className="text-muted-foreground text-xs">({t("models.disabled")})</span>;
}
