// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@appstrate/ui/components/alert";
import { Button } from "@appstrate/ui/components/button";
import { useSetPackageActive } from "../../hooks/use-library";
import { useCurrentSpaceId } from "../../hooks/use-current-space";
import { useCurrentSpaceGrant } from "../../hooks/use-permissions";
import { maySetPackageActive } from "../../lib/package-permissions";

/**
 * The agent is placed in this space and switched OFF.
 *
 * The page renders in full around this banner, because reading and configuring
 * an agent is not running it: every read and configure route answers 200 for a
 * switched-off agent and only the execution doors refuse it. The server says
 * the same thing on the readiness read — `GET …/connection-readiness` answers
 * 200 with a blocking `agent_not_active` error rather than a 404 — precisely so
 * a client can show the cause instead of a panel that fails to load. This is
 * that display, and since the cause is one a reader may be able to clear on the
 * spot, the remedy travels with it.
 *
 * The verdict itself is NOT read here: the page passes it from its own detail
 * response (`AgentDetail.active`), so one page asks one source.
 *
 * The button is live on the same predicate the server enforces
 * (`maySetPackageActive` — the type's activation grant in this space, or owning
 * the space, RBAC spec §3.6). Without it the banner would name a cure the
 * reader cannot apply, so it states the blockage alone.
 */
export function AgentInactiveAlert({ packageId }: { packageId: string }) {
  const { t } = useTranslation(["agents", "settings"]);
  const setActive = useSetPackageActive();
  const currentSpaceId = useCurrentSpaceId();
  const spaceGrant = useCurrentSpaceGrant();
  const mayActivate = maySetPackageActive(spaceGrant, "agent", true);

  return (
    <Alert variant="destructive" className="mb-4">
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>{t("detail.notActiveHere")}</AlertTitle>
      <AlertDescription className="flex items-center justify-between gap-3">
        <span>{t("detail.notActiveHereHint")}</span>
        {mayActivate && currentSpaceId && (
          <Button
            size="sm"
            disabled={setActive.isPending}
            onClick={() => setActive.mutate({ spaceId: currentSpaceId, packageId, active: true })}
          >
            {t("packages.activate", { ns: "settings" })}
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}
