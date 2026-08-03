// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { splitGaps, type LogicMapGap } from "../logic-map-gaps-dialog";

const CORPUS = join(import.meta.dir, "..", "..", "..", "..", "..", "..", "examples", "logic-map");

describe("partage des trous", () => {
  it("range `map_limitation` de notre côté et le reste du côté de l'agent", () => {
    const { ours, theirs } = splitGaps([
      { kind: "map_limitation", message: "le vocabulaire n'a pas su rendre la source" },
      { kind: "contradiction", message: "deux passages incompatibles" },
      { kind: "unguarded_input", message: "contenu tiers sans règle" },
    ]);
    expect(ours.map((g) => g.kind)).toEqual(["map_limitation"]);
    expect(theirs.map((g) => g.kind)).toEqual(["contradiction", "unguarded_input"]);
  });

  it("ne perd aucun trou", () => {
    const gaps: LogicMapGap[] = Array.from({ length: 7 }, (_, i) => ({
      kind: i % 3 === 0 ? "map_limitation" : "unhandled_case",
      message: `trou ${i}`,
    }));
    const { ours, theirs } = splitGaps(gaps);
    expect(ours.length + theirs.length).toBe(gaps.length);
  });

  it("sépare les limites de lecture du corpus réel", () => {
    // Le corpus est la seule source qui dit combien il y en a vraiment, et sur quels agents.
    const parAgent = new Map<string, number>();
    let total = 0;
    for (const file of readdirSync(CORPUS).filter((f) => f.endsWith(".logic-map.json"))) {
      const map = JSON.parse(readFileSync(join(CORPUS, file), "utf8")) as { gaps?: LogicMapGap[] };
      const { ours, theirs } = splitGaps(map.gaps ?? []);
      total += ours.length + theirs.length;
      if (ours.length) parAgent.set(file.replace(".logic-map.json", ""), ours.length);
    }
    expect(total).toBe(138);
    // Deux limites subsistent, sur deux agents. Les deux autres ont été retirées le
    // 2 août : le format les couvrait depuis que `until` et `groups[].shape` existent,
    // et les cartes ne les renseignaient simplement pas.
    expect([...parAgent.values()].reduce((a, b) => a + b, 0)).toBe(2);
    expect(parAgent.size).toBe(2);
  });

  it("laisse un agent sans limite de lecture entièrement du côté de l'agent", () => {
    const map = JSON.parse(readFileSync(join(CORPUS, "wiki-brain.logic-map.json"), "utf8")) as {
      gaps: LogicMapGap[];
    };
    const { ours, theirs } = splitGaps(map.gaps);
    expect(ours).toEqual([]);
    expect(theirs.length).toBe(map.gaps.length);
  });
});
