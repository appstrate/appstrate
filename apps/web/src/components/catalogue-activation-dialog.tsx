// SPDX-License-Identifier: Apache-2.0

/**
 * The one question switching an agent on can raise: its SKILLS travel with it, but its
 * INTEGRATIONS are judged in the launching space (`integration_not_active`), so the agent
 * could be on and unable to start. Activate everything, or the agent alone. An
 * integration the caller may not switch on is named without a button (the route refuses it).
 */

import { PendingButton } from "@/components/app-ui/pending-button";
import { useTranslation } from "react-i18next";
import { Button } from "@appstrate/ui/components/button";
import { Modal } from "./modal";
import { ClosureList } from "./closure-list";
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
            <PendingButton onClick={onActivateAll} pending={isPending}>
              {t("catalogue.closureActivateAll")}
            </PendingButton>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        <p>{t("catalogue.closureBody", { space: spaceName })}</p>
        <ClosureList
          entries={missing.map((entry) => ({
            id: entry.id,
            name: entry.name,
            note: entry.activatable ? undefined : t("catalogue.closureNoRight"),
          }))}
        />
        <p className="text-muted-foreground text-xs">{t("catalogue.closureCredentials")}</p>
      </div>
    </Modal>
  );
}
