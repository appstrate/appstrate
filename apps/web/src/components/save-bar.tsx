// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@appstrate/ui/components/button";
import { PendingButton } from "@/components/app-ui/pending-button";

/** The bar an embedded editor shows while it holds changes only Save sends. */
export function SaveBar({
  message,
  pending,
  saveDisabled,
  onDiscard,
  onSave,
}: {
  message: ReactNode;
  pending: boolean;
  /** Save is not offered yet (the facts a write is judged against are still loading). */
  saveDisabled?: boolean;
  onDiscard: () => void;
  onSave: () => void;
}) {
  const { t } = useTranslation(["agents", "common"]);
  return (
    <div className="bg-background border-border sticky bottom-0 z-10 flex min-h-16 flex-wrap items-center gap-3 border-t px-6 py-3 max-lg:flex-col max-lg:items-stretch">
      <span className="text-muted-foreground text-sm">{message}</span>
      <div className="ml-auto flex flex-wrap items-center gap-2 max-lg:ml-0 max-lg:w-full">
        <Button
          variant="outline"
          type="button"
          disabled={pending}
          onClick={onDiscard}
          className="max-lg:flex-auto"
        >
          {t("editor.discardChanges")}
        </Button>
        <PendingButton
          type="button"
          pending={pending}
          disabled={saveDisabled}
          onClick={onSave}
          className="max-lg:flex-auto"
        >
          {t("btn.save", { ns: "common" })}
        </PendingButton>
      </div>
    </div>
  );
}
