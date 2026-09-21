// SPDX-License-Identifier: Apache-2.0

/**
 * The one question switching an agent on can raise.
 *
 * Activating a package activates that package alone. An agent's SKILLS travel
 * with it — they are judged from its home space — but its INTEGRATIONS are
 * judged in the space that launches, and a missing one refuses the run with
 * `integration_not_active`. So an agent can be switched on in a space and still
 * be unable to start, which is what this says before writing anything.
 *
 * Two answers, both legitimate: activate everything the run needs, or activate
 * the agent alone and deal with its integrations later. An integration the
 * caller may not switch on is named without a button, because the route would
 * refuse it.
 */

import { useTranslation } from "react-i18next";
import { Button } from "@appstrate/ui/components/button";
import { Modal } from "./modal";
import { Spinner } from "./spinner";
import type { MissingDependency } from "../lib/activation-closure";

export function ActivationClosureDialog({
  packageName,
  spaceName,
  missing,
  isPending,
  onClose,
  onAgentOnly,
  onActivateAll,
}: {
  packageName: string;
  spaceName: string;
  missing: MissingDependency[];
  isPending: boolean;
  onClose: () => void;
  onAgentOnly: () => void;
  onActivateAll: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const blocked = missing.filter((entry) => !entry.activatable);
  const canActivateAll = blocked.length === 0;

  return (
    <Modal
      open
      onClose={onClose}
      title={t("catalogue.closureTitle", { name: packageName })}
      actions={
        <>
          <Button variant="outline" onClick={onClose} disabled={isPending}>
            {t("btn.cancel", { ns: "common" })}
          </Button>
          <Button variant="outline" onClick={onAgentOnly} disabled={isPending}>
            {t("catalogue.closureAgentOnly")}
          </Button>
          {canActivateAll && (
            <Button onClick={onActivateAll} disabled={isPending}>
              {isPending ? <Spinner /> : t("catalogue.closureActivateAll")}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p>{t("catalogue.closureBody", { space: spaceName })}</p>
        <ul className="border-border divide-border divide-y rounded-lg border">
          {missing.map((entry) => (
            <li key={entry.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <span className="truncate">{entry.name}</span>
              {!entry.activatable && (
                <span className="text-muted-foreground shrink-0 text-xs">
                  {t("catalogue.closureNoRight")}
                </span>
              )}
            </li>
          ))}
        </ul>
        <p className="text-muted-foreground text-xs">{t("catalogue.closureCredentials")}</p>
      </div>
    </Modal>
  );
}
