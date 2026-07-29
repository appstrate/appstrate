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
  /** `condition` n'entre pas dans le placement, mais fait partie du format et voyage avec. */
  edges: readonly {
    from: string;
    to: string;
    condition?: string | null;
    /** Raison d'un écart délibéré à la lettre de la source. Le placement l'ignore, la route le sert. */
    departs_from_source?: string | null;
  }[];
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
  /** Niveau d'imbrication de contrôle, pour que le rendu marque l'appartenance. */
  depth: number;
}

export interface LayoutResult {
  nodes: PositionedNode[];
  /**
   * Grappes dans leur ordre de placement, avec leur boîte englobante.
   *
   * Le rendu en a besoin pour dessiner un cadre : sans lui, une colonne de douze
   * politiques ressemble à douze cartes sans rapport, alors que le domaine est
   * précisément ce qui les relie.
   */
  groups: {
    name: string;
    shape: "sequence" | "policies";
    x: number;
    y: number;
    width: number;
    height: number;
    count: number;
  }[];
}

const CARD_WIDTH = 320;
/** Décalage horizontal d'un cran d'imbrication. */
const NESTED_INSET = 28;
const RANK_GAP = 40;
const COLUMN_GAP = 64;
/** Écart entre deux nœuds parallèles d'un même rang. */
const SIBLING_GAP = 32;

// Constantes calibrées sur les hauteurs RÉELLES mesurées dans le navigateur, puis
// majorées : le serveur ne peut pas connaître le rendu, et une estimation trop
// courte fait se chevaucher les cartes tandis qu'une estimation trop généreuse ne
// coûte que du vide. On se trompe donc délibérément vers le haut.
const CARD_CHROME = 96;
const LABEL_LINE = 22;
const TEXT_LINE = 18;
const LABEL_CHARS = 34;
const TEXT_CHARS = 40;
/** Marge de sûreté sur l'estimation totale. */
const HEIGHT_SAFETY = 1.1;

/**
 * Hauteur d'une carte, majorée depuis son contenu.
 *
 * Le volet 1 a payé une fois le prix d'une estimation qui mentait : une carte
 * annoncée à 100 px pour 248 réels fait se chevaucher tout ce qui la suit. Une carte
 * de logique empile beaucoup plus qu'une étoile, l'erreur y serait systématique.
 */
export function estimateStepHeight(step: LayoutStep): number {
  // Le rendu tronque le détail : le compter en entier gonflerait chaque carte, et la
  // colonne avec elle.
  const lines = (text: string | null | undefined, chars: number, cap = Infinity): number =>
    text ? Math.min(cap, Math.max(1, Math.ceil(text.length / chars))) : 0;
  const body =
    lines(step.label, LABEL_CHARS) * LABEL_LINE +
    lines(step.detail ?? null, TEXT_CHARS, 3) * TEXT_LINE +
    lines(step.evidence?.quote ?? null, TEXT_CHARS, 3) * TEXT_LINE;
  return Math.ceil((CARD_CHROME + body) * HEIGHT_SAFETY);
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

/**
 * Profondeur d'imbrication d'une étape, bornée contre un `parent` circulaire.
 */
function depthOf(id: string, parentOf: Map<string, string | null>): number {
  let depth = 0;
  let cur = parentOf.get(id) ?? null;
  const seen = new Set<string>([id]);
  while (cur && !seen.has(cur) && depth < 8) {
    seen.add(cur);
    depth++;
    cur = parentOf.get(cur) ?? null;
  }
  return depth;
}

export function layoutLogicMap(map: LayoutMap): LayoutResult {
  const rank = computeRanks(map);
  const ids = new Set(map.steps.map((s) => s.id));
  const parentOf = new Map(
    map.steps.map((s) => [s.id, s.parent && ids.has(s.parent) ? s.parent : null]),
  );
  const heights = new Map(map.steps.map((s) => [s.id, estimateStepHeight(s)]));
  const groupShape = new Map((map.groups ?? []).map((g) => [g.name, g.shape]));
  const order = groupOrder(map);

  const nodes: PositionedNode[] = [];
  const groups: LayoutResult["groups"] = [];
  let x = 0;

  for (const name of order) {
    const members = map.steps.filter((s) => (s.group ?? "") === name);
    if (members.length === 0) continue;

    const memberIds = new Set(members.map((m) => m.id));
    const internalEdges = map.edges.filter((e) => memberIds.has(e.from) && memberIds.has(e.to));
    const shape =
      groupShape.get(name) ??
      (map.shape === "sequence" || internalEdges.length > 0 ? "sequence" : "policies");

    // Une colonne est une PILE VERTICALE, jamais une grille : placer deux nœuds de
    // même rang côte à côte faisait déborder la colonne sur la suivante. Le flot se
    // lit dans les arêtes, l'imbrication dans le décalage horizontal.
    const ordered =
      shape === "sequence"
        ? [...members].sort((a, b) => {
            const ra = rank.get(a.id) ?? 0;
            const rb = rank.get(b.id) ?? 0;
            if (ra !== rb) return ra - rb;
            return members.indexOf(a) - members.indexOf(b);
          })
        : members;

    let y = 0;
    let widest = CARD_WIDTH;
    if (shape === "sequence") {
      // Une couche par rang. Les nœuds d'un même rang sont PARALLÈLES — les deux
      // branches d'une décision, par exemple — donc côte à côte, et la colonne
      // s'élargit d'autant : c'est de ne pas l'élargir qui la faisait déborder sur sa
      // voisine.
      const ranks = [...new Set(ordered.map((m) => rank.get(m.id) ?? 0))].sort((a, b) => a - b);
      for (const r of ranks) {
        const layer = ordered.filter((m) => (rank.get(m.id) ?? 0) === r);
        let tallest = 0;
        layer.forEach((step, i) => {
          const depth = depthOf(step.id, parentOf);
          const inset = depth * NESTED_INSET;
          const h = heights.get(step.id)!;
          const nx = x + inset + i * (CARD_WIDTH + SIBLING_GAP);
          nodes.push({
            id: step.id,
            type: step.kind,
            position: { x: nx, y },
            parent_id: null,
            width: CARD_WIDTH,
            height: h,
            rank: r,
            group: name || null,
            depth,
          });
          widest = Math.max(widest, nx - x + CARD_WIDTH);
          tallest = Math.max(tallest, h);
        });
        y += tallest + RANK_GAP;
      }
    } else {
      for (const step of ordered) {
        const depth = depthOf(step.id, parentOf);
        const inset = depth * NESTED_INSET;
        const h = heights.get(step.id)!;
        nodes.push({
          id: step.id,
          type: step.kind,
          position: { x: x + inset, y },
          parent_id: null,
          width: CARD_WIDTH,
          height: h,
          rank: rank.get(step.id) ?? 0,
          group: name || null,
          depth,
        });
        widest = Math.max(widest, inset + CARD_WIDTH);
        y += h + 16;
      }
    }

    groups.push({
      name: name || "(sans domaine)",
      shape,
      x,
      y: 0,
      width: widest,
      // `y` repart de zéro à chaque colonne, donc la hauteur est le dernier `y`
      // atteint, moins l'écart ajouté après la dernière carte.
      height: Math.max(0, y - (shape === "sequence" ? RANK_GAP : 16)),
      count: members.length,
    });
    x += widest + COLUMN_GAP;
  }

  return { nodes, groups };
}

/**
 * Chevauchements entre cartes, comparés comme des rectangles.
 *
 * Sert de garde-fou de test : la première version ne comparait que les nœuds de même
 * abscisse, et laissait donc passer exactement le défaut qu'elle devait attraper —
 * une colonne qui déborde sur sa voisine.
 */
export function findOverlaps(result: LayoutResult): { a: string; b: string }[] {
  const clashes: { a: string; b: string }[] = [];
  const n = result.nodes;
  for (let i = 0; i < n.length; i++) {
    for (let j = i + 1; j < n.length; j++) {
      const a = n[i]!;
      const b = n[j]!;
      const overlap =
        a.position.x < b.position.x + b.width &&
        b.position.x < a.position.x + a.width &&
        a.position.y < b.position.y + b.height &&
        b.position.y < a.position.y + a.height;
      if (overlap) clashes.push({ a: a.id, b: b.id });
    }
  }
  return clashes;
}
