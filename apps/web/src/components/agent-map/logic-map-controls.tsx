// SPDX-License-Identifier: Apache-2.0

/**
 * Deux commandes pour une carte trop dense à l'ouverture.
 *
 * Le corpus explique le besoin : un document de politiques peut porter des dizaines de
 * garde-fous hors flot (326 sur les 18 cartes de référence), qui noient la procédure
 * qu'on est venu lire. Et rien ne permettait de sauter à une section sur une carte de
 * 78 nœuds.
 *
 * Les deux se règlent avec ce que React Flow expose déjà : `hidden` sur un nœud le
 * retire du rendu, et `fitView({ nodes })` recadre sur un sous-ensemble. Rien n'est
 * recalculé côté client, le placement reste au serveur.
 */

import { useTranslation } from "react-i18next";

/** Les sept types du vocabulaire fermé, dans l'ordre où ils se lisent sur une carte. */
const STEP_KINDS = ["step", "decision", "loop", "tool_call", "emit", "guard", "policy"] as const;
type StepKind = (typeof STEP_KINDS)[number];

/** Clé i18n du libellé d'un type, déjà traduit pour les nœuds. */
const LABEL_KEY: Record<StepKind, string> = {
  step: "logicMap.kind.step",
  decision: "logicMap.kind.decision",
  loop: "logicMap.kind.loop",
  tool_call: "logicMap.kind.toolCall",
  emit: "logicMap.kind.emit",
  guard: "logicMap.kind.guard",
  policy: "logicMap.kind.policy",
};

export function LogicMapControls({
  counts,
  hiddenKinds,
  onToggleKind,
  groups,
  onJumpToGroup,
}: {
  /** Nombre de nœuds par type, pour ne proposer que ce que la carte contient. */
  counts: Record<string, number>;
  hiddenKinds: ReadonlySet<string>;
  onToggleKind: (kind: StepKind) => void;
  groups: { name: string; count: number }[];
  onJumpToGroup: (name: string) => void;
}) {
  const { t } = useTranslation("agents");
  const present = STEP_KINDS.filter((k) => (counts[k] ?? 0) > 0);

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      {present.map((kind) => {
        const off = hiddenKinds.has(kind);
        return (
          <button
            key={kind}
            type="button"
            onClick={() => onToggleKind(kind)}
            aria-pressed={!off}
            className={
              off
                ? "rounded border border-neutral-800 px-2 py-1 text-neutral-600 line-through"
                : "rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-300"
            }
          >
            {t(LABEL_KEY[kind])} <span className="text-neutral-500">{counts[kind]}</span>
          </button>
        );
      })}

      {groups.length > 1 && (
        <select
          onChange={(e) => {
            if (e.target.value) onJumpToGroup(e.target.value);
            // Remis à vide : le menu est une ACTION, pas un état. Sans ça, sauter deux
            // fois de suite au même groupe ne déclencherait rien la seconde fois.
            e.target.value = "";
          }}
          defaultValue=""
          aria-label={t("logicMap.jumpTo")}
          className="ml-auto rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-300"
        >
          <option value="">{t("logicMap.jumpTo")}</option>
          {groups.map((g) => (
            <option key={g.name} value={g.name}>
              {g.name} ({g.count})
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
