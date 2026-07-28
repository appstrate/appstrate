// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Placement d'une carte de logique, calculé côté serveur.
 *
 * Le client ne calcule rien, comme pour la carte de dépendances : il reçoit des positions.
 * Mais là où la carte de dépendances est une étoile à trois colonnes codées en dur, un flot à
 * branches ne se place pas à la main. On range donc les nœuds par rang topologique, sans
 * moteur de layout externe — la référence inspectée n'en utilise aucun, et l'ajouter avant
 * qu'un cas réel ne casse le placement naïf serait prématuré.
 *
 * Deux familles, deux dispositions :
 *  - `sequence` : couches successives, une par rang, ordonnées de façon stable ;
 *  - `policies` : colonnes de grappes, le graphe non connexe étant la norme et non une anomalie.
 *
 * Un hybride mélange les deux : une grappe déclarée `sequence` dans `groups[]` est placée en
 * couches à l'intérieur de sa colonne.
 */

export interface LayoutStep {
  id: string;
  kind: string;
  label: string;
  group?: string | null;
  parent?: string | null;
  detail?: string | null;
  evidence?: { quote?: string } | null;
}

export interface LayoutGroup {
  name: string;
  shape?: "sequence" | "policies";
  order?: number;
}

export interface LayoutMap {
  shape: "sequence" | "policies";
  steps: readonly LayoutStep[];
  edges: readonly { from: string; to: string }[];
  groups?: readonly LayoutGroup[];
}

export interface PositionedNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  /** Imbrication React Flow. Le type intégré `group` est un nom réservé : on ne l'adopte pas. */
  parent_id: string | null;
  width: number;
  height: number;
  /** Rang topologique, exposé pour que le rendu puisse grouper ou replier par couche. */
  rank: number;
  group: string | null;
}

export interface LayoutResult {
  nodes: PositionedNode[];
  /** Grappes dans leur ordre de placement, pour un rendu qui dessine des cadres. */
  groups: { name: string; shape: "sequence" | "policies"; x: number; width: number }[];
}

const CARD_WIDTH = 320;
const CARD_PADDING = 28;
const LINE_HEIGHT = 20;
/** Largeur utile d'une ligne, en caractères, à la police du rendu. */
const CHARS_PER_LINE = 42;
const RANK_GAP = 48;
const COLUMN_GAP = 56;
const NESTED_INSET = 24;

/**
 * Hauteur d'une carte, calculée depuis son contenu réel.
 *
 * Le volet 1 a payé une fois le prix d'une estimation qui mentait : une carte annoncée à
 * 100 px pour 248 réels fait se chevaucher tout ce qui la suit. Une carte de logique empile
 * beaucoup plus qu'une étoile, l'erreur y serait systématique — d'où un compte de lignes
 * plutôt qu'une constante.
 */
export function estimateStepHeight(step: LayoutStep): number {
  const lines = (text: string | null | undefined, chars = CHARS_PER_LINE): number =>
    text ? Math.max(1, Math.ceil(text.length / chars)) : 0;
  const label = lines(step.label);
  const detail = lines(step.detail ?? null, CHARS_PER_LINE + 8);
  const quote = lines(step.evidence?.quote ?? null, CHARS_PER_LINE + 8);
  const badge = 22;
  return CARD_PADDING + badge + (label + detail + quote) * LINE_HEIGHT + (quote > 0 ? 12 : 0);
}

/**
 * Rang topologique de chaque nœud.
 *
 * Tolère les cycles : une boucle `until` en produit un (le dernier nœud du corps revient au
 * premier), et un cycle ne doit pas empêcher le placement. Les arêtes qui refermeraient un
 * cycle sont ignorées pour le calcul du rang, jamais pour le rendu.
 */
export function computeRanks(map: LayoutMap): Map<string, number> {
  const ids = new Set(map.steps.map((s) => s.id));
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const id of ids) {
    incoming.set(id, []);
    outgoing.set(id, []);
  }
  for (const e of map.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) continue;
    outgoing.get(e.from)!.push(e.to);
    incoming.get(e.to)!.push(e.from);
  }

  const rank = new Map<string, number>();
  // Départ : tout ce qui n'a pas de prédécesseur. Un graphe entièrement cyclique n'en a aucun,
  // d'où le repli sur le premier nœud déclaré, qui garde un placement déterministe.
  const roots = [...ids].filter((id) => incoming.get(id)!.length === 0);
  const queue = roots.length > 0 ? [...roots] : map.steps.length > 0 ? [map.steps[0]!.id] : [];
  for (const id of queue) rank.set(id, 0);

  const seen = new Set<string>(queue);
  let head = 0;
  while (head < queue.length) {
    const id = queue[head++]!;
    const current = rank.get(id)!;
    for (const next of outgoing.get(id)!) {
      const candidate = current + 1;
      if (!rank.has(next) || candidate > rank.get(next)!) {
        // Un nœud déjà visité qui remonterait de rang signale un cycle : on borne.
        if (seen.has(next) && rank.has(next) && candidate > rank.get(next)!) continue;
        rank.set(next, candidate);
      }
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  // Nœuds hors flot (garde-fous, politiques, grappes isolées) : rang 0, ils ne s'insèrent nulle part.
  for (const id of ids) if (!rank.has(id)) rank.set(id, 0);
  return rank;
}

function groupOrder(map: LayoutMap): string[] {
  const declared = new Map((map.groups ?? []).map((g) => [g.name, g.order ?? Number.NaN]));
  const seen: string[] = [];
  for (const s of map.steps) {
    const g = s.group ?? "";
    if (!seen.includes(g)) seen.push(g);
  }
  return seen.sort((a, b) => {
    const oa = declared.get(a);
    const ob = declared.get(b);
    const hasA = oa !== undefined && !Number.isNaN(oa);
    const hasB = ob !== undefined && !Number.isNaN(ob);
    if (hasA && hasB) return oa! - ob!;
    if (hasA) return -1;
    if (hasB) return 1;
    // À défaut de `groups[]`, l'ordre d'apparition fait foi : c'est celui du document lu.
    return seen.indexOf(a) - seen.indexOf(b);
  });
}

export function layoutLogicMap(map: LayoutMap): LayoutResult {
  const rank = computeRanks(map);
  const byId = new Map(map.steps.map((s) => [s.id, s]));
  const heights = new Map(map.steps.map((s) => [s.id, estimateStepHeight(s)]));
  const groupShape = new Map((map.groups ?? []).map((g) => [g.name, g.shape]));
  const order = groupOrder(map);

  const nodes: PositionedNode[] = [];
  const groups: LayoutResult["groups"] = [];
  let x = 0;

  for (const name of order) {
    const members = map.steps.filter((s) => (s.group ?? "") === name);
    if (members.length === 0) continue;

    // Une grappe se place en couches si elle le déclare, ou à défaut si la carte est une
    // séquence et que ses membres sont effectivement reliés.
    const memberIds = new Set(members.map((m) => m.id));
    const internalEdges = map.edges.filter((e) => memberIds.has(e.from) && memberIds.has(e.to));
    const shape =
      groupShape.get(name) ??
      (map.shape === "sequence" || internalEdges.length > 0 ? "sequence" : "policies");

    const columnWidth = CARD_WIDTH + NESTED_INSET;
    let y = 0;

    if (shape === "sequence") {
      // Une couche par rang, les rangs dans l'ordre, et à rang égal l'ordre de déclaration :
      // deux exécutions du placement doivent rendre exactement la même carte.
      const ranks = [...new Set(members.map((m) => rank.get(m.id) ?? 0))].sort((a, b) => a - b);
      for (const r of ranks) {
        const layer = members.filter((m) => (rank.get(m.id) ?? 0) === r);
        let layerHeight = 0;
        layer.forEach((step, i) => {
          const h = heights.get(step.id)!;
          nodes.push({
            id: step.id,
            type: step.kind,
            position: { x: x + (step.parent ? NESTED_INSET : 0) + i * (CARD_WIDTH + 24), y },
            parent_id: step.parent && byId.has(step.parent) ? step.parent : null,
            width: CARD_WIDTH,
            height: h,
            rank: r,
            group: name || null,
          });
          layerHeight = Math.max(layerHeight, h);
        });
        y += layerHeight + RANK_GAP;
      }
    } else {
      for (const step of members) {
        const h = heights.get(step.id)!;
        nodes.push({
          id: step.id,
          type: step.kind,
          position: { x: x + (step.parent ? NESTED_INSET : 0), y },
          parent_id: step.parent && byId.has(step.parent) ? step.parent : null,
          width: CARD_WIDTH,
          height: h,
          rank: 0,
          group: name || null,
        });
        y += h + 16;
      }
    }

    groups.push({ name: name || "(sans domaine)", shape, x, width: columnWidth });
    x += columnWidth + COLUMN_GAP;
  }

  return { nodes, groups };
}

/**
 * Chevauchements verticaux à l'intérieur d'une même colonne.
 *
 * Sert de garde-fou de test : c'est le défaut qui est passé inaperçu au volet 1, invisible
 * tant qu'une carte est seule dans sa colonne.
 */
export function findOverlaps(result: LayoutResult): { a: string; b: string }[] {
  const clashes: { a: string; b: string }[] = [];
  const byColumn = new Map<number, PositionedNode[]>();
  for (const n of result.nodes) {
    const list = byColumn.get(n.position.x) ?? [];
    list.push(n);
    byColumn.set(n.position.x, list);
  }
  for (const list of byColumn.values()) {
    const sorted = [...list].sort((p, q) => p.position.y - q.position.y);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!;
      const cur = sorted[i]!;
      if (prev.position.y + prev.height > cur.position.y) clashes.push({ a: prev.id, b: cur.id });
    }
  }
  return clashes;
}
