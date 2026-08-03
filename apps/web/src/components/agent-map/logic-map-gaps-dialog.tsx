// SPDX-License-Identifier: Apache-2.0

/**
 * Ce que la source ne dit pas, ou dit mal.
 *
 * Les trous étaient produits, validés par le schéma et stockés, mais aucun écran ne
 * les lisait : la partie de la carte qu'on peut CORRIGER n'existait pas dans le
 * produit. Un diagnostic dit qu'une capacité est mal déclarée ; un trou dit qu'une
 * règle manque, se contredit ou ne se décide pas — c'est souvent le plus actionnable
 * des deux.
 *
 * Le regroupement par famille est le seul intérêt d'avoir fermé le vocabulaire :
 * douze familles, comparables d'un agent à l'autre et d'un run à l'autre. Un trou
 * dont la famille est inconnue s'affiche quand même, sous son identifiant brut — un
 * format qui évolue ne doit pas faire disparaître de la matière de l'écran.
 */

import { useTranslation } from "react-i18next";
import { Modal } from "../modal";

export interface LogicMapGap {
  kind: string;
  message: string;
  related_steps?: string[];
}

/** Ordre d'affichage : l'écart vérifiable d'abord, la limite de la carte en dernier. */
const FAMILY_ORDER = [
  "capability_without_rule",
  "rule_without_capability",
  "declaration_mismatch",
  "contradiction",
  "duplicated_rule",
  "unhandled_failure",
  "unhandled_case",
  "undefined_criterion",
  "unbounded_work",
  "external_authority",
  "uninstantiated_template",
  "map_limitation",
];

/**
 * Sépare ce que le propriétaire de l'agent peut corriger de ce qui nous revient.
 *
 * `map_limitation` est la seule famille dont le sujet est la CARTE et non l'agent : sur le
 * corpus, ses quatre occurrences visent un hybride que `shape` ne sait pas rendre, une
 * boucle conditionnelle que `loop` ne distingue pas d'une itération, et un passage qui ne
 * prescrit rien. Les compter avec les autres reviendrait à présenter comme un défaut à
 * corriger une limite que personne d'autre que nous ne peut lever.
 */
export function splitGaps(gaps: LogicMapGap[]): { ours: LogicMapGap[]; theirs: LogicMapGap[] } {
  return {
    ours: gaps.filter((g) => g.kind === "map_limitation"),
    theirs: gaps.filter((g) => g.kind !== "map_limitation"),
  };
}

export function LogicMapGapsDialog({
  gaps,
  labelForStep,
  onClose,
}: {
  gaps: LogicMapGap[] | null;
  /** Rend le libellé d'une étape ; l'identifiant brut ne dit rien à personne. */
  labelForStep: (id: string) => string;
  onClose: () => void;
}) {
  const { t } = useTranslation("agents");
  if (!gaps) return null;

  const { ours, theirs } = splitGaps(gaps);

  const byFamily = new Map<string, LogicMapGap[]>();
  for (const gap of theirs) {
    const list = byFamily.get(gap.kind) ?? [];
    list.push(gap);
    byFamily.set(gap.kind, list);
  }
  const families = [...byFamily.entries()].sort((a, b) => {
    const rank = (k: string) => {
      const i = FAMILY_ORDER.indexOf(k);
      return i === -1 ? FAMILY_ORDER.length : i;
    };
    return rank(a[0]) - rank(b[0]);
  });

  return (
    <Modal
      open
      onClose={onClose}
      title={t("logicMap.gaps.title", { count: theirs.length })}
      className="sm:max-w-3xl"
    >
      <p className="text-muted-foreground mb-3 text-xs">{t("logicMap.gaps.hint")}</p>
      <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto">
        {families.map(([family, items]) => (
          <section key={family}>
            <h3 className="mb-1.5 flex items-baseline gap-2 text-sm font-medium">
              {/* `defaultValue` garde à l'écran une famille que l'ontologie ne connaît pas encore. */}
              {t(`logicMap.gaps.family.${family}`, { defaultValue: family })}
              <span className="text-muted-foreground text-xs font-normal">{items.length}</span>
            </h3>
            <div className="flex flex-col gap-2">
              {items.map((gap, i) => (
                <div key={`${family}:${i}`} className="border-border rounded-lg border p-3">
                  <p className="text-sm">{gap.message}</p>
                  {gap.related_steps && gap.related_steps.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {gap.related_steps.map((id) => (
                        <span
                          key={id}
                          className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-xs"
                        >
                          {labelForStep(id)}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        ))}

        {ours.length > 0 && (
          <section className="border-border border-t pt-3">
            <h3 className="mb-1 flex items-baseline gap-2 text-sm font-medium">
              {t("logicMap.gaps.ours")}
              <span className="text-muted-foreground text-xs font-normal">{ours.length}</span>
            </h3>
            <p className="text-muted-foreground mb-2 text-xs">{t("logicMap.gaps.oursHint")}</p>
            <div className="flex flex-col gap-2">
              {ours.map((gap, i) => (
                <div key={`ours:${i}`} className="border-border bg-muted/30 rounded-lg border p-3">
                  <p className="text-sm">{gap.message}</p>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </Modal>
  );
}
