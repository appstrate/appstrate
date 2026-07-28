// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  computeRanks,
  estimateStepHeight,
  findOverlaps,
  layoutLogicMap,
  type LayoutMap,
} from "../src/logic-map-layout.ts";

const EXAMPLES = join(import.meta.dir, "..", "..", "..", "examples", "logic-map");
const files = readdirSync(EXAMPLES).filter((f) => f.endsWith(".logic-map.json"));
const load = (name: string) => JSON.parse(readFileSync(join(EXAMPLES, name), "utf8")) as LayoutMap;

describe("logic map layout", () => {
  it("places every step of every reference map", () => {
    for (const file of files) {
      const map = load(file);
      const { nodes } = layoutLogicMap(map);
      expect(nodes).toHaveLength(map.steps.length);
    }
  });

  it("never overlaps two cards in the same column", () => {
    // Le défaut du volet 1 : une hauteur estimée trop courte, invisible tant qu'une carte est
    // seule dans sa colonne. Une carte de logique en empile beaucoup plus.
    for (const file of files) {
      const clashes = findOverlaps(layoutLogicMap(load(file)));
      expect({ file, clashes }).toEqual({ file, clashes: [] });
    }
  });

  it("derives height from content, not from a constant", () => {
    const short = estimateStepHeight({ id: "a", kind: "step", label: "Court" });
    const long = estimateStepHeight({
      id: "b",
      kind: "step",
      label: "Un libellé nettement plus long qui occupe plusieurs lignes à l'affichage",
      detail: "Un détail de deux phrases, lui aussi long, pour vérifier que la hauteur suit.",
      evidence: { quote: "Une citation qui prend elle-même de la place dans la carte rendue." },
    });
    // La hauteur suit le contenu ; la base commune reste importante, donc on compare
    // la part variable et non un rapport brut.
    expect(long).toBeGreaterThan(short + 100);
  });

  it("is deterministic — two runs place the cards identically", () => {
    const map = load("compta-gmail-harvest.logic-map.json");
    expect(layoutLogicMap(map)).toEqual(layoutLogicMap(map));
  });

  it("ranks a chain in order", () => {
    const ranks = computeRanks({
      shape: "sequence",
      steps: [
        { id: "s1", kind: "step", label: "a" },
        { id: "s2", kind: "step", label: "b" },
        { id: "s3", kind: "step", label: "c" },
      ],
      edges: [
        { from: "s1", to: "s2" },
        { from: "s2", to: "s3" },
      ],
    });
    expect([ranks.get("s1"), ranks.get("s2"), ranks.get("s3")]).toEqual([0, 1, 2]);
  });

  it("survives a cycle, as a `loop` with an exit condition produces one", () => {
    const map: LayoutMap = {
      shape: "policies",
      steps: [
        { id: "wl1", kind: "step", label: "orient" },
        { id: "wl2", kind: "step", label: "act" },
        { id: "wl3", kind: "step", label: "observe" },
      ],
      edges: [
        { from: "wl1", to: "wl2" },
        { from: "wl2", to: "wl3" },
        { from: "wl3", to: "wl1" },
      ],
    };
    const ranks = computeRanks(map);
    expect(ranks.size).toBe(3);
    expect(layoutLogicMap(map).nodes).toHaveLength(3);
  });

  it("gives a rank to steps no edge reaches", () => {
    // Garde-fous et politiques ne s'insèrent nulle part : ils doivent quand même être placés.
    const map = load("fleet-on-call-copilot.logic-map.json");
    const ranks = computeRanks(map);
    expect(ranks.size).toBe(map.steps.length);
  });

  it("lays a policy document out as clusters, not as a chain", () => {
    const { groups } = layoutLogicMap(load("fleet-executive-assistant.logic-map.json"));
    expect(groups.length).toBeGreaterThan(10);
    expect(groups.every((g) => g.x >= 0)).toBe(true);
    const xs = groups.map((g) => g.x);
    expect(new Set(xs).size).toBe(xs.length);
  });

  it("honours a per-group shape, which is what an hybrid needs", () => {
    const map: LayoutMap = {
      shape: "policies",
      groups: [
        { name: "Working Loop", shape: "sequence", order: 0 },
        { name: "Security", shape: "policies", order: 1 },
      ],
      steps: [
        { id: "a", kind: "step", label: "orient", group: "Working Loop" },
        { id: "b", kind: "step", label: "act", group: "Working Loop" },
        { id: "g", kind: "guard", label: "never", group: "Security" },
      ],
      edges: [{ from: "a", to: "b" }],
    };
    const { groups } = layoutLogicMap(map);
    expect(groups.map((g) => [g.name, g.shape])).toEqual([
      ["Working Loop", "sequence"],
      ["Security", "policies"],
    ]);
  });

  it("orders groups by their declared order, not by first appearance", () => {
    const map: LayoutMap = {
      shape: "policies",
      groups: [
        { name: "Second", order: 1 },
        { name: "First", order: 0 },
      ],
      steps: [
        { id: "a", kind: "policy", label: "x", group: "Second" },
        { id: "b", kind: "policy", label: "y", group: "First" },
      ],
      edges: [],
    };
    expect(layoutLogicMap(map).groups.map((g) => g.name)).toEqual(["First", "Second"]);
  });

  it("marks a loop body by indentation, never by React Flow parenting", () => {
    // `parentId` ferait lire `position` comme RELATIVE au parent : tout le corps de la
    // boucle se replierait sur un seul point, ce qui est exactement le défaut observé
    // à l'écran. L'appartenance passe donc par le décalage horizontal.
    const map = load("compta-gmail-harvest.logic-map.json");
    const { nodes } = layoutLogicMap(map);
    const loop = nodes.find((n) => n.id === "s12")!;
    const child = nodes.find((n) => n.id === "s12.1")!;
    const grandChild = nodes.find((n) => n.id === "s12.7.1")!;
    expect(child.parent_id).toBeNull();
    expect(child.depth).toBe(loop.depth + 1);
    expect(child.position.x).toBeGreaterThan(loop.position.x);
    expect(grandChild.depth).toBe(2);
    expect(grandChild.position.x).toBeGreaterThan(child.position.x);
  });
});
