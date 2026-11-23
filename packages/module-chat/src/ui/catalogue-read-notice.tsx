// SPDX-License-Identifier: Apache-2.0

import { Button } from "@appstrate/ui/components/button";
import type { CatalogueSource } from "../commands.ts";
import { useChatHost } from "./runtime-context.ts";

export function CatalogueReadNotice({
  sources,
  failed,
  retry,
  busy,
}: {
  sources?: CatalogueSource[];
  failed: boolean;
  retry: () => void;
  busy: boolean;
}) {
  const { t } = useChatHost();
  if (!failed && !sources?.length) return null;
  const sourceNotice = {
    published_skills: () => t("catalogue.unavailable.published_skills"),
    draft_skills: () => t("catalogue.unavailable.draft_skills"),
    agents: () => t("catalogue.unavailable.agents"),
  } satisfies Record<CatalogueSource, () => string>;
  return (
    <div className="flex items-center gap-2 px-2 py-1 text-xs">
      <span role="status">
        {failed ? t("slash.error") : sources?.map((source) => sourceNotice[source]()).join(" ")}
      </span>
      <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={retry}>
        {t("common:btn.retry")}
      </Button>
    </div>
  );
}
