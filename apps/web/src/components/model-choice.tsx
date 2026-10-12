// SPDX-License-Identifier: Apache-2.0

/**
 * « Choose the models » of a provider: the checklist of the models its service offers, the
 * ones already there ticked, a star on the organization's default.
 *
 * `useModelChoice` (`hooks/use-model-choice-state.ts`) holds the state (what is ticked, starred,
 * searched, detected) and hands back the plan it amounts to; `ModelChoiceList` draws it. The three dialogs that choose
 * models (an organization key's, the personal keys' per service, and the second step of
 * « Ajouter une clé org ») own their footer and apply the plan, so the same list serves all three.
 */

import { useTranslation } from "react-i18next";
import { Button } from "@appstrate/ui/components/button";
import { Spinner } from "./spinner";
import { ModelPickList } from "./model-form/model-pick-list";
import type { ModelChoice } from "../hooks/use-model-choice-state";
import { discoveryErrorKey } from "@/lib/model-discovery";

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
    <div className="space-y-3">
      {source === "discover" && (
        <div className="space-y-2">
          <Button
            type="button"
            variant="outline"
            onClick={choice.detect}
            disabled={choice.detecting}
          >
            {choice.detecting ? <Spinner /> : t("models.form.discoverButton")}
          </Button>
          {discovery &&
            (discovery.outcome === "ok" ? (
              <div className="text-muted-foreground text-sm">
                {discovery.models.length > 0
                  ? t("models.form.discoverCount", { count: discovery.models.length })
                  : t("models.form.discoverEmpty")}
                {discovery.truncated && (
                  <span className="block">{t("models.form.discoverTruncated")}</span>
                )}
              </div>
            ) : (
              <div className="text-destructive text-sm">
                {t(discoveryErrorKey(discovery.outcome))}
              </div>
            ))}
        </div>
      )}
      <ModelPickList
        rows={choice.rows}
        selectedIds={[...choice.picked.keys()]}
        onSelectionChange={choice.change}
        search={choice.search.search}
        onSearchChange={choice.search.setSearch}
        isLoading={source === "search" && choice.search.isLoading}
        loadingText={t("models.form.modelSearchLoading")}
        emptyText={t("models.form.modelSearchEmpty")}
        grouped={source === "catalog"}
        defaultId={choice.star}
        onDefaultChange={choice.setStar}
        advancedIds={advanced?.ids}
        onAdvanced={advanced?.onOpen}
      />
      {choice.plan.remove.length > 0 && (
        <p className="text-muted-foreground text-sm">
          {t("models.choice.removing", { count: choice.plan.remove.length })}
        </p>
      )}
    </div>
  );
}
