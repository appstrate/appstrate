// SPDX-License-Identifier: Apache-2.0

/**
 * « Choose the models » of a configuration: the checklist of the models its service offers, the
 * ones the organization has access to ticked.
 *
 * `useModelChoice` holds the state (what is ticked, searched, detected) and hands back the plan it
 * amounts to; `ModelChoiceList` draws it; `ModelChoiceDialog` owns the footer and applies the plan.
 */

import { PendingButton } from "@/components/app-ui/pending-button";
import { useTranslation } from "react-i18next";
import { DiscoveryResult } from "./model-form/discovery-result";
import { ManualModelEntry } from "./model-form/manual-model-entry";
import { ModelPickList } from "./model-form/model-pick-list";
import type { ModelChoice } from "../hooks/use-model-choice";

export function ModelChoiceList({
  choice,
  advanced,
}: {
  choice: ModelChoice;
  /** The models already saved, with where their finer settings open. */
  advanced?: { ids: ReadonlySet<string>; onOpen: (modelId: string) => void };
}) {
  const { t } = useTranslation(["settings", "common"]);
  const { source, discovery } = choice;

  return (
    <div className="flex flex-col gap-3">
      {source === "discover" && (
        <div className="flex flex-col gap-2">
          <PendingButton
            type="button"
            variant="outline"
            className="self-start"
            onClick={choice.detect}
            pending={choice.detecting}
          >
            {t("models.form.discoverButton")}
          </PendingButton>
          {discovery && <DiscoveryResult discovery={discovery} />}
        </div>
      )}
      <ModelPickList
        rows={choice.rows}
        selectedIds={[...choice.picked.keys()]}
        onSelectionChange={choice.change}
        search={choice.search.search}
        onSearchChange={choice.search.setSearch}
        isLoading={source === "search" && choice.search.isLoading}
        emptyText={t("models.form.modelSearchEmpty")}
        grouped={source === "catalog"}
        lockedId={choice.lockedId}
        advancedIds={advanced?.ids}
        onAdvanced={advanced?.onOpen}
        footer={choice.offersManual ? <ManualModelEntry onAdd={choice.addManual} /> : undefined}
      />
      {choice.plan.withdraw.length > 0 && (
        <p className="text-muted-foreground text-sm">
          {t("models.choice.withdrawing", { count: choice.plan.withdraw.length })}
        </p>
      )}
    </div>
  );
}
