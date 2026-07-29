// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Croisement d'une carte de logique avec les capacités réellement déclarées.
 *
 * Le producteur de la carte PROPOSE des références typées ; ce module les VÉRIFIE contre des
 * faits, sans modèle et sans correspondance textuelle. C'est ce qui permet de tirer des
 * constats fiables d'un producteur qui ne l'est pas.
 *
 * Fonction pure, sans accès base ni HTTP : l'appelant projette le manifeste et l'installation
 * en `DeclaredCapabilities`, ce qui rend le croisement testable sur les cartes de référence
 * et réutilisable par la route de lecture, le chat ou le copilote.
 */

/** Sévérités, du plus grave au plus informatif. */
export type LogicMapFindingLevel = "error" | "warning" | "hint" | "inventory";

export interface LogicMapFinding {
  level: LogicMapFindingLevel;
  code: string;
  /** Nœud de la carte de dépendances visé, pour réutiliser son routage de diagnostics. */
  node_id: string | null;
  item_id: string | null;
  /** Étapes de la carte de logique concernées. Vide pour un constat qui porte sur une absence. */
  step_ids: string[];
  message: string;
}

/**
 * Ce que le manifeste et l'installation déclarent. Chaque clé correspond à un nœud de la
 * carte de dépendances, donc au préfixe d'une `ref`.
 *
 * `runtime`, `subagents` et `context_files` sont absents : **aucun emplacement de déclaration
 * n'existe** pour eux aujourd'hui (le manifeste ne dit rien de `bash` ni de la lecture de
 * fichiers). Une référence vers ces préfixes ne peut donc jamais être une erreur.
 */
export interface DeclaredCapabilities {
  toolbox?: { id: string; tools?: readonly string[] | "*" }[];
  skills?: readonly string[];
  mcp_servers?: { id: string; tools?: readonly string[] | "*" }[];
  system_tools?: readonly string[];
  config?: readonly string[];
  agent_input?: readonly string[];
  agent_output?: readonly string[];
  /** `true` quand le manifeste déclare un `output.schema` : une étape `emit` est alors attendue. */
  has_output_schema?: boolean;
  /** Planifications installées, pour repérer un cron qu'aucune règle ne couvre. */
  schedules?: readonly { id: string; name?: string | null }[];
}

interface LogicMapStep {
  id: string;
  kind: string;
  label: string;
  refs?: readonly string[];
  detail?: string | null;
  /**
   * Laxiste à dessein : l'appelant passe parfois une carte déjà projetée pour le rendu, qui
   * ne garde de l'ancrage que la citation. Sans `file`, le contrôle de périmètre se tait.
   */
  evidence?: { file?: string; quote?: string } | null;
}

export interface LogicMapLike {
  shape: "sequence" | "policies";
  steps: readonly LogicMapStep[];
  edges: readonly { from: string; to: string }[];
  gaps?: readonly { kind: string; message: string; related_steps?: readonly string[] }[];
  source?: { files?: readonly string[] };
}

export interface CrossCheckOptions {
  /**
   * Au-delà de ce nombre de capacités déclarées non référencées pour un même nœud, le
   * croisement émet un seul constat d'inventaire plutôt qu'un indice par capacité. Un agent
   * dont le prompt prescrit délibérément le jugement (« act with the appropriate tools »)
   * produirait sinon des dizaines d'avertissements inexploitables.
   */
  inventoryThreshold?: number;
}

/** Préfixes qui ont un emplacement de déclaration : une référence non résolue y est une erreur. */
const DECLARABLE = new Set(["toolbox", "skills", "mcp_servers", "system_tools"]);
/** Préfixes sans emplacement de déclaration : une référence non résolue n'y est qu'un indice. */
const UNDECLARABLE = new Set(["runtime", "subagents", "context_files"]);

/**
 * Préfixe de `ref` vers l'identifiant du nœud de la carte de dépendances, pour que le
 * diagnostic se route sur la bonne carte au rendu.
 *
 * Le décalage à connaître : les deux nœuds d'enveloppe ont pour identifiant `input` et
 * `output` — `agent_input` et `agent_output` sont leurs *types*, renommés parce que React
 * Flow réserve `input` et `output` pour ses nœuds intégrés.
 */
const NODE_ID_BY_PREFIX: Record<string, string> = {
  toolbox: "toolbox",
  skills: "skills",
  mcp_servers: "mcp_servers",
  system_tools: "system_tools",
  config: "config",
  model: "model",
  schedules: "schedules",
  agent_input: "input",
  agent_output: "output",
};

/** `null` pour un préfixe qui ne correspond à aucune carte du volet 1. */
function nodeIdFor(prefix: string): string | null {
  return NODE_ID_BY_PREFIX[prefix] ?? null;
}

const DEFAULT_INVENTORY_THRESHOLD = 8;

interface ParsedRef {
  node: string;
  item: string;
  /** Sous-item après `#` : un outil d'une intégration, un script d'un skill. */
  member: string | null;
  raw: string;
}

function parseRef(raw: string): ParsedRef | null {
  const colon = raw.indexOf(":");
  if (colon <= 0) return null;
  const node = raw.slice(0, colon);
  const rest = raw.slice(colon + 1);
  if (rest.length === 0) return null;
  const hash = rest.indexOf("#");
  return hash === -1
    ? { node, item: rest, member: null, raw }
    : { node, item: rest.slice(0, hash), member: rest.slice(hash + 1), raw };
}

/** Part de nœuds qui participent au flot. Sépare les familles sans modèle. */
export function flowNodeRatio(map: LogicMapLike): number {
  if (map.steps.length === 0) return 0;
  const flow = map.steps.filter((s) => s.kind !== "guard" && s.kind !== "policy").length;
  return flow / map.steps.length;
}

/**
 * Part des références dont l'identifiant est nommé littéralement dans la source.
 *
 * Mesure ce que le producteur apporte de plus qu'une recherche textuelle. Le gain n'est pas
 * constant : sur un prompt qui nomme ses outils, il est nul ; sur un prompt qui les désigne
 * par leur effet, il est décisif. Quand l'indicateur vaut 1, il ne faut pas mettre le
 * croisement en avant, une recherche de sous-chaîne aurait suffi.
 */
export function grepEquivalence(map: LogicMapLike, sourceText: string): number {
  const refs = new Set<string>();
  for (const step of map.steps) for (const r of step.refs ?? []) refs.add(r);
  if (refs.size === 0) return 1;
  let literal = 0;
  for (const raw of refs) {
    const parsed = parseRef(raw);
    if (!parsed) continue;
    const needle = parsed.member ?? parsed.item;
    if (sourceText.includes(needle)) literal++;
  }
  return literal / refs.size;
}

export function crossCheckLogicMap(
  map: LogicMapLike,
  declared: DeclaredCapabilities,
  options: CrossCheckOptions = {},
): LogicMapFinding[] {
  const threshold = options.inventoryThreshold ?? DEFAULT_INVENTORY_THRESHOLD;
  const findings: LogicMapFinding[] = [];

  // Références émises, dédupliquées PAR RÉFÉRENCE et non par nœud : un même défaut de
  // manifeste porté par treize étapes est un seul constat, pas treize.
  const used = new Map<string, { ref: ParsedRef; steps: string[] }>();
  for (const step of map.steps) {
    for (const raw of step.refs ?? []) {
      const parsed = parseRef(raw);
      if (!parsed) continue;
      const entry = used.get(raw);
      if (entry) entry.steps.push(step.id);
      else used.set(raw, { ref: parsed, steps: [step.id] });
    }
  }

  const toolboxById = new Map((declared.toolbox ?? []).map((t) => [t.id, t]));
  const mcpById = new Map((declared.mcp_servers ?? []).map((t) => [t.id, t]));
  const listFor = (node: string): readonly string[] | null => {
    switch (node) {
      case "toolbox":
        return [...toolboxById.keys()];
      case "mcp_servers":
        return [...mcpById.keys()];
      case "skills":
        return declared.skills ?? [];
      case "system_tools":
        return declared.system_tools ?? [];
      case "config":
        return declared.config ?? [];
      case "agent_input":
        return declared.agent_input ?? [];
      case "agent_output":
        return declared.agent_output ?? [];
      default:
        return null;
    }
  };

  // --- Références émises, confrontées aux déclarations -----------------------
  for (const { ref, steps } of used.values()) {
    if (UNDECLARABLE.has(ref.node)) {
      findings.push({
        level: "hint",
        code: `undeclarable_${ref.node}`,
        node_id: null,
        item_id: ref.item,
        step_ids: steps,
        message:
          `\`${ref.raw}\` n'a aucun emplacement de déclaration : la plateforme ne permet pas ` +
          `de déclarer cette capacité, le constat reste un indice.`,
      });
      continue;
    }

    const known = listFor(ref.node);
    if (known === null) continue;

    if (!known.includes(ref.item)) {
      const declarable = DECLARABLE.has(ref.node);
      findings.push({
        level: declarable ? "error" : "warning",
        code: declarable ? "ref_not_declared" : "envelope_field_unknown",
        node_id: nodeIdFor(ref.node),
        item_id: ref.item,
        step_ids: steps,
        message: declarable
          ? `\`${ref.item}\` est référencé par la carte mais absent du manifeste.`
          : `\`${ref.item}\` n'existe pas dans le schéma \`${ref.node}\`.`,
      });
      continue;
    }

    // Grain fin : l'intégration est déclarée, mais l'outil précis l'est-il ?
    if (ref.member !== null && (ref.node === "toolbox" || ref.node === "mcp_servers")) {
      const entry = ref.node === "toolbox" ? toolboxById.get(ref.item) : mcpById.get(ref.item);
      const tools = entry?.tools;
      if (tools !== undefined && tools !== "*" && !tools.includes(ref.member)) {
        findings.push({
          level: "error",
          code: "tool_not_granted",
          node_id: nodeIdFor(ref.node),
          item_id: ref.item,
          step_ids: steps,
          message: `L'outil \`${ref.member}\` de \`${ref.item}\` n'est pas dans les outils accordés.`,
        });
      }
    }
  }

  // --- Déclarations que la carte ne référence jamais -------------------------
  // JAMAIS une erreur : un prompt peut invoquer une capacité sans la nommer, et une capacité
  // non référencée est un indice à confirmer par un humain, pas un verdict.
  for (const node of ["toolbox", "mcp_servers", "skills", "system_tools"] as const) {
    const known = listFor(node) ?? [];
    const referenced = new Set(
      [...used.values()].filter((u) => u.ref.node === node).map((u) => u.ref.item),
    );
    const orphans = known.filter((id) => !referenced.has(id));
    if (orphans.length === 0) continue;

    if (orphans.length > threshold) {
      findings.push({
        level: "inventory",
        code: "unreferenced_inventory",
        node_id: nodeIdFor(node),
        item_id: null,
        step_ids: [],
        message:
          `${orphans.length} capacités déclarées ne sont référencées par aucune étape. ` +
          `Au-delà de ${threshold}, c'est un inventaire, pas une anomalie : le prompt prescrit ` +
          `sans doute le jugement plutôt que des outils nommés.`,
      });
      continue;
    }
    for (const id of orphans) {
      findings.push({
        level: "hint",
        code: "declared_never_referenced",
        node_id: nodeIdFor(node),
        item_id: id,
        step_ids: [],
        message: `\`${id}\` est déclaré mais aucune étape ne le référence. À confirmer.`,
      });
    }
  }

  // --- Contrat de sortie -----------------------------------------------------
  if (declared.has_output_schema && !map.steps.some((s) => s.kind === "emit")) {
    findings.push({
      level: "warning",
      code: "output_schema_without_emit",
      node_id: "output",
      item_id: null,
      step_ids: [],
      message:
        "Un schéma de sortie est déclaré mais aucune étape ne rend de résultat : " +
        "un run peut finir sans rien produire.",
    });
  }

  // --- Planification déclarée qu'aucune règle ne couvre -----------------------
  // Constat absent du tableau initial, ajouté après l'avoir observé sur un agent réel dont le
  // cron quotidien n'était décrit nulle part dans son prompt.
  //
  // La couverture se lit UNIQUEMENT dans les `ref` émises (`schedules:<id>`), jamais par
  // correspondance de mots dans les libellés : un rapprochement textuel ferait passer pour
  // couvert un cron « Daily calendar and email brief » sur le simple fait qu'une règle parle
  // d'agenda. C'est la règle cardinale du croisement, et elle vaut aussi ici.
  const scheduledRefs = new Set(
    [...used.values()].filter((u) => u.ref.node === "schedules").map((u) => u.ref.item),
  );
  for (const schedule of declared.schedules ?? []) {
    if (!scheduledRefs.has(schedule.id)) {
      findings.push({
        level: "warning",
        code: "schedule_without_rule",
        node_id: "schedules",
        item_id: schedule.id,
        step_ids: [],
        message:
          `La planification « ${schedule.name} » est déclarée, mais aucune étape de la carte ` +
          `ne décrit ce qu'elle déclenche.`,
      });
    }
  }

  // --- Identifiants internes ------------------------------------------------
  // Une arête ou un trou qui désigne une étape inexistante est invisible : le rendu ne
  // dessine rien, et le lecteur croit que le trou n'était rattaché à rien. Le schéma ne
  // peut pas l'attraper, les identifiants y sont de simples chaînes.
  const stepIds = new Set(map.steps.map((s) => s.id));
  const dangling = new Map<string, string[]>();
  const noteDangling = (id: string, from: string) => {
    if (stepIds.has(id)) return;
    const holders = dangling.get(id);
    if (holders) holders.push(from);
    else dangling.set(id, [from]);
  };
  for (const edge of map.edges) {
    noteDangling(edge.from, `arête ${edge.from}→${edge.to}`);
    noteDangling(edge.to, `arête ${edge.from}→${edge.to}`);
  }
  for (const [i, gap] of (map.gaps ?? []).entries()) {
    for (const id of gap.related_steps ?? []) noteDangling(id, `trou ${i + 1} (${gap.kind})`);
  }
  for (const [id, holders] of dangling) {
    findings.push({
      level: "error",
      code: "dangling_step_id",
      node_id: null,
      item_id: id,
      step_ids: [],
      message:
        `\`${id}\` est désigné par ${holders.length > 1 ? `${holders.length} renvois` : holders[0]} ` +
        `mais n'est l'identifiant d'aucune étape de la carte.`,
    });
  }

  // --- Périmètre de lecture annoncé ------------------------------------------
  // Un fichier déclaré lu que pas une citation n'utilise. Souvent légitime (on ouvre un
  // SKILL.md pour savoir QUEL fichier de références fait foi, sans le citer), donc un
  // indice et non une erreur. Mais c'est aussi la signature d'une carte qui annonce avoir
  // lu le prompt alors que la route le lui a rendu vide : mesuré sur deux runs, et rien
  // ne le signalait.
  const citedFiles = new Set(map.steps.map((s) => s.evidence?.file).filter(Boolean));
  for (const file of map.source?.files ?? []) {
    if (citedFiles.has(file)) continue;
    findings.push({
      level: "hint",
      code: "declared_but_uncited",
      node_id: null,
      item_id: file,
      step_ids: [],
      message:
        `\`${file}\` est déclaré lu mais aucune étape ne le cite : soit il a servi à en ` +
        `trouver un autre, soit la carte annonce un périmètre qu'elle n'a pas.`,
    });
  }

  // --- Cohérence de la forme déclarée ----------------------------------------
  const ratio = flowNodeRatio(map);
  if (map.shape === "sequence" && ratio < 0.35) {
    findings.push({
      level: "hint",
      code: "shape_suspect",
      node_id: null,
      item_id: null,
      step_ids: [],
      message:
        `La carte se déclare séquentielle mais ${Math.round(ratio * 100)} % seulement de ses ` +
        `nœuds participent au flot : elle ressemble à un document de règles.`,
    });
  } else if (map.shape === "policies" && ratio > 0.43) {
    findings.push({
      level: "hint",
      code: "shape_suspect",
      node_id: null,
      item_id: null,
      step_ids: [],
      message:
        `La carte se déclare document de politiques mais ${Math.round(ratio * 100)} % de ses ` +
        `nœuds participent au flot : elle contient sans doute une séquence.`,
    });
  }

  const rank: Record<LogicMapFindingLevel, number> = {
    error: 0,
    warning: 1,
    hint: 2,
    inventory: 3,
  };
  return findings.sort((a, b) => rank[a.level] - rank[b.level]);
}
