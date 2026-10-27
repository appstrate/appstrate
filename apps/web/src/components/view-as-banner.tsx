// SPDX-License-Identifier: Apache-2.0

import { requestScopeChange } from "../hooks/use-unsaved-changes";

import { useEffect } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Alert } from "@appstrate/ui/components/alert";
import { Button } from "@appstrate/ui/components/button";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { cn } from "@appstrate/ui/cn";
import { VIEW_AS_REFUSAL_CODES } from "@appstrate/core/permissions";
import {
  exitViewAs,
  takeViewAsStopped,
  useViewAs,
  useViewAsStopped,
} from "../stores/view-as-store";
import { useCurrentOrgId } from "../hooks/use-org";
import { isSpaceEnterable, useCurrentSpaceId, useSpaceSwitcher } from "../hooks/use-current-space";
import { roleI18nKey } from "../hooks/use-permissions";
import { spaceRoleLabel } from "../hooks/use-roles";
import { useSpaces } from "../hooks/use-spaces";
import { useOverlayPath } from "../lib/modal-route";

/**
 * The preview's only visible state and its only exit, mounted once in the app frame.
 * Not dismissible: hiding it would leave an admin acting under a downgraded authority.
 *
 * An open overlay is a modal that makes the frame's banner inert, so the overlay carries
 * its own (`inOverlay`) and the frame's steps aside: exactly one banner, always reachable.
 *
 * It says what holds WHERE THE USER IS: in the persona's space both roles; elsewhere only
 * the org role (an implicit member gets that space's default role, `resolveSpaceRole`; a
 * guest nothing). It also states the one boundary: a persona RESTRICTS the caller without
 * replacing them (`apps/api/src/lib/view-as.ts`), so `runs:read` still means "mine".
 */
export function ViewAsBanner({ inOverlay = false }: { inOverlay?: boolean } = {}) {
  const { t } = useTranslation(["common", "settings"]);
  const persona = useViewAs();
  const stopped = useViewAsStopped();
  const orgId = useCurrentOrgId();
  const currentSpaceId = useCurrentSpaceId();
  const { data: spaces, isPending: spacesPending } = useSpaces();
  const overlayOpen = useOverlayPath() !== null;
  const { switchSpace } = useSpaceSwitcher();
  const navigate = useNavigate();

  // The refusal lands on the boot org list, before `<Toaster/>` subscribes; this is the first mount that can report it.
  useEffect(() => {
    if (stopped === null) return;
    // Atomic take: StrictMode runs this twice and the second call gets `null`.
    const code = takeViewAsStopped();
    if (code === null) return;
    // The server's `detail` is English prose, not UI copy.
    toast.warning(
      VIEW_AS_REFUSAL_CODES.has(code) ? t(`viewAs.stopped.${code}`) : t("viewAs.stopped.generic"),
    );
  }, [stopped, t]);

  // A persona applies in ONE organization; elsewhere the caller is themselves.
  if (!persona || persona.orgId !== orgId) return null;
  if (overlayOpen !== inOverlay) return null;

  const inPersonaSpace = !!persona.space && currentSpaceId === persona.space.spaceId;
  const key = inPersonaSpace ? "viewAs.bannerSpace" : "viewAs.banner";
  const here = inPersonaSpace ? undefined : spaces?.find((s) => s.id === currentSpaceId);
  const hereRole = here?.access === "member" ? spaceRoleLabel(here.role, t) : null;
  // A guest holds no space of its own, so the app has none to stand in.
  const noSpace = !inPersonaSpace && !!spaces && !spaces.some(isSpaceEnterable);

  // Back to the space the preview moved the admin out of, then home (as on the way in).
  const exit = () =>
    requestScopeChange(() => {
      const back = exitViewAs();
      if (!back || back === currentSpaceId) return;
      switchSpace(back);
      navigate("/", { replace: true });
    });

  return (
    <Alert
      variant="warning"
      data-testid="view-as-banner"
      className={cn(
        "flex shrink-0 flex-wrap items-center justify-between gap-2 rounded-none border-x-0 border-t-0 px-4 py-2",
        // In an overlay the band runs under the dialog's close button.
        inOverlay && "pr-14",
      )}
    >
      <span className="min-w-64 flex-1">
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
        {/* The "in X: role Y" clause needs the listing; hold its place. */}
        {!inPersonaSpace && spacesPending && (
          <>
            {" "}
            <Skeleton className="inline-block h-3.5 w-40 align-middle" />
          </>
        )}
        {hereRole && here && (
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
        {noSpace && <> {t("viewAs.bannerNoSpace")}</>}
        <span className="block text-xs font-normal opacity-80">{t("viewAs.bannerOwn")}</span>
      </span>
      <Button variant="outline" size="sm" onClick={exit}>
        {t("viewAs.exit")}
      </Button>
    </Alert>
  );
}
