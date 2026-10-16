// SPDX-License-Identifier: Apache-2.0

import { Check, Undo2 } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@appstrate/ui/components/button";
import { PendingButton } from "@/components/app-ui/pending-button";

/** The bar an embedded editor shows while it holds changes only Save sends. */
export function SaveBar({
  message,
  compact = false,
  pending,
  saveDisabled,
  onDiscard,
  onSave,
}: {
  message: ReactNode;
  compact?: boolean;
  pending: boolean;
  /** Save is not offered yet (the facts a write is judged against are still loading). */
  saveDisabled?: boolean;
  onDiscard: () => void;
  onSave: () => void;
}) {
  const { t } = useTranslation(["agents", "common"]);
  return (
    <div
      className={
        compact
          ? "mt-2 flex flex-wrap items-center justify-end gap-1"
          : "bg-background border-border sticky bottom-0 z-10 flex min-h-16 flex-wrap items-center gap-3 border-t px-6 py-3 max-lg:flex-col max-lg:items-stretch"
      }
    >
      <span className={compact ? "sr-only" : "text-muted-foreground text-sm"}>{message}</span>
      <div
        className={
          compact
            ? "flex items-center gap-1"
            : "ml-auto flex flex-wrap items-center gap-2 max-lg:ml-0 max-lg:w-full"
        }
      >
        <Button
          size={compact ? "icon-sm" : "default"}
          aria-label={t("editor.discardChanges")}
          title={compact ? t("editor.discardChanges") : undefined}
          variant="outline"
          type="button"
          disabled={pending}
          onClick={onDiscard}
          className={compact ? undefined : "max-lg:flex-auto"}
        >
          {compact ? <Undo2 /> : t("editor.discardChanges")}
        </Button>
        <PendingButton
          size={compact ? "icon-sm" : "default"}
          aria-label={t("btn.save", { ns: "common" })}
          title={compact ? t("btn.save", { ns: "common" }) : undefined}
          type="button"
          pending={pending}
          disabled={saveDisabled}
          onClick={onSave}
          className={compact ? undefined : "max-lg:flex-auto"}
        >
          {compact ? !pending && <Check /> : t("btn.save", { ns: "common" })}
        </PendingButton>
      </div>
    </div>
  );
}
