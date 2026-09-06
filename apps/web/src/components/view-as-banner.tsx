// SPDX-License-Identifier: Apache-2.0

import { useEffect } from "react";
import { Trans, useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Alert } from "@appstrate/ui/components/alert";
import { Button } from "@appstrate/ui/components/button";
import { VIEW_AS_REFUSAL_CODES } from "@appstrate/core/permissions";
import {
  exitViewAs,
  takeViewAsStopped,
  useViewAs,
  useViewAsStopped,
} from "../stores/view-as-store";
import { useCurrentOrgId } from "../hooks/use-org";
import { roleI18nKey } from "../hooks/use-permissions";

/**
 * The preview's only visible state, and its only exit.
 *
 * Mounted once in the app frame (above the scroll container, so it survives
 * every route, settings layout and permission-denied page): a 403 answered
 * under a preview has to be readable as the persona's. Not dismissible —
 * hiding it would leave an admin acting under a downgraded authority with no
 * sign of it.
 *
 * Both labels of the space half were captured when the preview was entered, so
 * this reads nothing the persona might not be allowed to read.
 */
export function ViewAsBanner() {
  const { t } = useTranslation(["common", "settings"]);
  const persona = useViewAs();
  const stopped = useViewAsStopped();
  const orgId = useCurrentOrgId();

  // A persona the server refused was dropped before this frame existed — the
  // API client cannot toast it itself, because the refusal typically lands on
  // the boot org list, before `<Toaster/>` subscribes. This is the first mount
  // that can say so.
  useEffect(() => {
    if (stopped === null) return;
    // Atomic take — StrictMode runs this twice and the second call gets `null`.
    const code = takeViewAsStopped();
    if (code === null) return;
    // Translated per refusal code. The server's `detail` is English prose meant
    // for an API caller, not copy for a French UI.
    toast.warning(
      VIEW_AS_REFUSAL_CODES.has(code) ? t(`viewAs.stopped.${code}`) : t("viewAs.stopped.generic"),
    );
  }, [stopped, t]);

  // A persona applies in ONE organization; elsewhere the caller is themselves.
  if (!persona || persona.orgId !== orgId) return null;

  const key = persona.space ? "viewAs.bannerSpace" : "viewAs.banner";

  return (
    <Alert
      variant="warning"
      data-testid="view-as-banner"
      className="flex shrink-0 flex-wrap items-center justify-between gap-2 rounded-none border-x-0 border-t-0 px-4 py-2"
    >
      <span>
        <Trans
          t={t}
          i18nKey={key}
          values={{
            role: t(roleI18nKey(persona.orgRole), { ns: "settings" }),
            spaceRole: persona.space?.roleLabel,
            space: persona.space?.spaceName,
          }}
          components={{ b: <strong className="font-semibold" /> }}
        />
      </span>
      <Button variant="outline" size="sm" onClick={() => exitViewAs()}>
        {t("viewAs.exit")}
      </Button>
    </Alert>
  );
}
