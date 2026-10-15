// SPDX-License-Identifier: Apache-2.0

/**
 * « Choose the models » of a provider: the checklist of the models its service offers, the
 * ones the organization has access to ticked, a star on its default.
 *
 * `useModelChoice` holds the state (what is ticked, starred, searched, detected) and hands back the
 * plan it amounts to; `ModelChoiceList` draws it. The three dialogs that choose models (an
 * organization key's, the personal keys' per service, and the second step of « Ajouter une clé
 * org ») own their footer and apply the plan, so the same list serves all three.
 */

import { useTranslation } from "react-i18next";
import { Button } from "@appstrate/ui/components/button";
import { DiscoveryResult } from "./model-form/discovery-result";
import { ManualModelEntry } from "./model-form/manual-model-entry";
import { ModelPickList } from "./model-form/model-pick-list";
import type { ModelChoice } from "../hooks/use-model-choice";

export function ModelChoiceList({
  choice,
  advanced,
  defaultUnavailable,
}: {
  choice: ModelChoice;
  /** The key needs reconnecting: none of its models can become the default. */
  defaultUnavailable?: boolean;
  /** The models already saved, with where their finer settings open. */
  advanced?: { ids: ReadonlySet<string>; onOpen: (modelId: string) => void };
}) {
  const { t } = useTranslation(["settings", "common"]);
  const { source, discovery } = choice;

  return (
    <div className="space-y-3">
      {source === "discover" && (
        <div className="space-y-2">
          <Button
            type="button"
            variant="outline"
            onClick={choice.detect}
            pending={choice.detecting}
          >
            {t("models.form.discoverButton")}
          </Button>
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
        defaultId={choice.star}
        onDefaultChange={choice.setStar}
        defaultUnavailable={defaultUnavailable}
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
