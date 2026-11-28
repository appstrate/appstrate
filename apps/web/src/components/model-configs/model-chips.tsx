// SPDX-License-Identifier: Apache-2.0

/**
 * The models of a configuration (or of the instance), as chips: the default marked « défaut », an
 * unpriced one flagged. A chip opens the model's form when the caller may edit it; otherwise it is
 * plain text.
 */

import { useTranslation } from "react-i18next";
import { TriangleAlert } from "lucide-react";
import { cn } from "@appstrate/ui/cn";
import type { OrgModelInfo } from "../../hooks/use-models";
import { isModelUnpriced } from "../../pages/org-settings/model-pricing";

const CHIP =
  "inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs";

export function ModelChips({
  models,
  onOpen,
}: {
  models: readonly OrgModelInfo[];
  /** Opens a model's form; absent, the chips are read-only. */
  onOpen?: (model: OrgModelInfo) => void;
}) {
  const { t } = useTranslation("settings");
  if (models.length === 0) {
    return <p className="text-muted-foreground text-sm">{t("modelConfigs.models.none")}</p>;
  }
  return (
    <ul className="flex flex-wrap gap-1.5">
      {models.map((model) => {
        const body = (
          <>
            <span className="truncate">{model.label}</span>
            {model.is_default && (
              <span className="text-muted-foreground shrink-0">
                {t("modelConfigs.models.default")}
              </span>
            )}
            {isModelUnpriced(model) && (
              <span title={t("models.unpricedHint")} className="inline-flex shrink-0">
                <TriangleAlert
                  className="text-warning size-3.5"
                  aria-label={t("models.unpriced")}
                />
              </span>
            )}
          </>
        );
        return (
          <li key={model.id} className="min-w-0">
            {onOpen ? (
              <button
                type="button"
                className={cn(
                  CHIP,
                  "hover:bg-accent focus-visible:ring-ring outline-none focus-visible:ring-2",
                )}
                onClick={() => onOpen(model)}
              >
                {body}
              </button>
            ) : (
              <span className={CHIP}>{body}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
