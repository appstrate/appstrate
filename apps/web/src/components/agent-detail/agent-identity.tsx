// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { ShieldCheck } from "lucide-react";
import { InlineMarkdown } from "../markdown";

/**
 * What the agent page's header no longer draws: the description, and the facts
 * that say where the agent comes from. Opens the overview tab.
 */
export function AgentIdentity({
  description,
  source,
  homeSpaceName,
}: {
  description: string;
  source: string;
  /** Absent for a home the reader cannot enter. */
  homeSpaceName?: string | null;
}) {
  const { t } = useTranslation(["agents", "settings"]);
  const isSystem = source === "system";
  if (!description && !isSystem && !homeSpaceName) return null;

  return (
    <section className="space-y-3" data-agent-identity>
      {description && (
        <p className="text-sm">
          <InlineMarkdown>{description}</InlineMarkdown>
        </p>
      )}
      {(isSystem || homeSpaceName) && (
        <dl className="text-muted-foreground flex flex-wrap gap-x-8 gap-y-2 text-sm">
          {isSystem && (
            <div className="flex items-center gap-2">
              <dt>{t("detail.overview.origin")}</dt>
              <dd className="text-foreground flex items-center gap-1.5">
                <ShieldCheck className="size-3.5" aria-hidden />
                {t("ownership.systemAgent")}
              </dd>
            </div>
          )}
          {homeSpaceName && (
            <div className="flex items-center gap-2">
              <dt>{t("detail.overview.homeSpace")}</dt>
              <dd className="text-foreground">{homeSpaceName}</dd>
            </div>
          )}
        </dl>
      )}
      {isSystem && (
        <p className="text-muted-foreground text-sm">{t("ownership.systemAgentTooltip")}</p>
      )}
    </section>
  );
}
