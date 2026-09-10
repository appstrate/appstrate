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
import { useCurrentSpaceId } from "../hooks/use-current-space";
import { roleI18nKey } from "../hooks/use-permissions";
import { spaceRoleLabel } from "../hooks/use-roles";
import { useSpaces } from "../hooks/use-spaces";

/**
 * The preview's only visible state, and its only exit. Mounted once in the app
 * frame, above the scroll container, so it survives every route and every
 * permission-denied page. Not dismissible: hiding it would leave an admin
 * acting under a downgraded authority with no sign of it.
 *
 * Outside the persona's own space the persona is only its org role, so the
 * banner also names the role it holds in the space being looked at — "Lecteur
 * dans Default" over a page answered for Marketing otherwise reads as a preview
 * that does not work.
 *
 * It also states the preview's one boundary. A persona is a restriction of the
 * caller's own session and the caller stays themselves (`apps/api/src/lib/view-as.ts`),
 * so every capability gated on IDENTITY rather than on role survives it: the
 * runs the previewer launched (`runs:read` means "mine"), the files they
 * uploaded, the integration connections they own. Previewing those would take
 * impersonation, which the design refuses; naming the boundary is what keeps
 * "see what this role sees" honest.
 */
export function ViewAsBanner() {
  const { t } = useTranslation(["common", "settings"]);
  const persona = useViewAs();
  const stopped = useViewAsStopped();
  const orgId = useCurrentOrgId();
  const currentSpaceId = useCurrentSpaceId();
  const { data: spaces } = useSpaces();

  // The refusal typically lands on the boot org list, before `<Toaster/>`
  // subscribes; this is the first mount that can report it.
  useEffect(() => {
    if (stopped === null) return;
    // Atomic take — StrictMode runs this twice and the second call gets `null`.
    const code = takeViewAsStopped();
    if (code === null) return;
    // The server's `detail` is English prose for an API caller, not UI copy.
    toast.warning(
      VIEW_AS_REFUSAL_CODES.has(code) ? t(`viewAs.stopped.${code}`) : t("viewAs.stopped.generic"),
    );
  }, [stopped, t]);

  // A persona applies in ONE organization; elsewhere the caller is themselves.
  if (!persona || persona.orgId !== orgId) return null;

  const key = persona.space ? "viewAs.bannerSpace" : "viewAs.banner";
  const here =
    persona.space && currentSpaceId !== persona.space.spaceId
      ? spaces?.find((s) => s.id === currentSpaceId)
      : undefined;
  const hereRole = here?.access === "member" ? spaceRoleLabel(here.role, t) : null;

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
        {here && hereRole && (
          <>
            {" "}
            <Trans
              t={t}
              i18nKey="viewAs.bannerHere"
              values={{ space: here.name, role: hereRole }}
              components={{ b: <strong className="font-semibold" /> }}
            />
          </>
        )}
        <span className="block text-xs font-normal opacity-80">{t("viewAs.bannerOwn")}</span>
      </span>
      <Button variant="outline" size="sm" onClick={() => exitViewAs()}>
        {t("viewAs.exit")}
      </Button>
    </Alert>
  );
}
