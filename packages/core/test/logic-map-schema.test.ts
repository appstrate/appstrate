// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createAjv } from "../src/ajv.ts";

// Le schéma de la carte de logique est le contrat entre le cartographe (qui produit) et le
// croisement (qui vérifie). Les 18 cartes écrites à la main de `examples/logic-map/` sont sa
// suite de non-régression : elles couvrent quatre origines indépendantes (agents Tractr,
// agents core, LangSmith Fleet, agents publics) et les deux familles de prompts.
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const SCHEMA_PATH = join(REPO_ROOT, "packages/core/schema/logic-map.schema.json");
const EXAMPLES_DIR = join(REPO_ROOT, "examples/logic-map");

const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as object;

function makeValidator() {
  // Le même AJV que la plateforme : draft 2020-12, formats activés, `strict: false`.
  return createAjv().compile(schema);
}

const exampleFiles = readdirSync(EXAMPLES_DIR).filter((f) => f.endsWith(".logic-map.json"));

describe("logic-map schema", () => {
  it("ships at least the eighteen hand-written reference maps", () => {
    expect(exampleFiles.length).toBeGreaterThanOrEqual(18);
  });

  for (const file of exampleFiles) {
    it(`validates ${file}`, () => {
      const validate = makeValidator();
      const map = JSON.parse(readFileSync(join(EXAMPLES_DIR, file), "utf8"));
      const valid = validate(map);
      if (!valid) {
        const details = (validate.errors ?? [])
          .slice(0, 5)
          .map((e) => `${e.instancePath} ${e.message}`)
          .join("; ");
        throw new Error(`${file} does not validate: ${details}`);
      }
      expect(valid).toBe(true);
    });
  }

  it("rejects a step whose kind is outside the closed vocabulary", () => {
    const validate = makeValidator();
    const map = JSON.parse(readFileSync(join(EXAMPLES_DIR, exampleFiles[0]!), "utf8"));
    map.steps[0].kind = "handoff";
    expect(validate(map)).toBe(false);
  });

  it("rejects a step without evidence", () => {
    const validate = makeValidator();
    const map = JSON.parse(readFileSync(join(EXAMPLES_DIR, exampleFiles[0]!), "utf8"));
    delete map.steps[0].evidence;
    expect(validate(map)).toBe(false);
  });

  it("rejects a ref whose prefix is not part of the dependency-map vocabulary", () => {
    const validate = makeValidator();
    const map = JSON.parse(readFileSync(join(EXAMPLES_DIR, exampleFiles[0]!), "utf8"));
    map.steps[0].refs = ["tools:@appstrate/gmail"];
    expect(validate(map)).toBe(false);
  });

  it("closes the grain of `runtime`, the one prefix nothing can verify", () => {
    // Les autres préfixes sont vérifiés contre le manifeste ; `runtime` n'a aucun
    // emplacement de déclaration, donc seul l'enum peut empêcher que le même pouvoir
    // prenne le nom d'outil de chaque harnais (`bash` contre `shell`, `edit` contre
    // `apply_patch`, trois `browser_*` pour une capacité).
    const validate = makeValidator();
    const map = JSON.parse(readFileSync(join(EXAMPLES_DIR, exampleFiles[0]!), "utf8"));

    map.steps[0].refs = ["runtime:shell"];
    expect(validate(map)).toBe(true);
    map.steps[0].refs = ["runtime:bash"];
    expect(validate(map)).toBe(false);
    map.steps[0].refs = ["runtime:apply_patch"];
    expect(validate(map)).toBe(false);
    // Le grain `#` reste réservé aux préfixes qui ont un manifeste derrière eux.
    map.steps[0].refs = ["runtime:shell#rm"];
    expect(validate(map)).toBe(false);
    // Et il ne bride pas les autres.
    map.steps[0].refs = ["toolbox:@appstrate/gmail#api_call"];
    expect(validate(map)).toBe(true);
  });

  it("keeps `applies_to` exclusive to guards", () => {
    const validate = makeValidator();
    const map = JSON.parse(readFileSync(join(EXAMPLES_DIR, exampleFiles[0]!), "utf8"));
    const step = map.steps.find((s: { kind: string }) => s.kind !== "guard");
    expect(step).toBeDefined();
    step.applies_to = ["s1"];
    expect(validate(map)).toBe(false);
  });

  it("keeps loop-only fields off non-loop steps", () => {
    const validate = makeValidator();
    const map = JSON.parse(readFileSync(join(EXAMPLES_DIR, exampleFiles[0]!), "utf8"));
    const step = map.steps.find((s: { kind: string }) => s.kind !== "loop");
    expect(step).toBeDefined();
    step.until = "the query is completely resolved";
    expect(validate(map)).toBe(false);
  });

  it("lets an edge declare a deliberate departure from the source", () => {
    // Le pendant d'`aggregated` : une carte qui a corrigé un ordre fautif doit pouvoir le
    // dire, sinon elle passe pour fidèle et le défaut de la source disparaît avec elle.
    const validate = makeValidator();
    const map = JSON.parse(
      readFileSync(join(EXAMPLES_DIR, "analyste-donnees.logic-map.json"), "utf8"),
    );
    const repaired = map.edges.find((e: { departs_from_source?: string }) => e.departs_from_source);
    expect(repaired).toBeDefined();
    expect(validate(map)).toBe(true);

    map.edges[0].departs_from_source = { why: "objet" };
    expect(validate(map)).toBe(false);
  });

  it("rejects a gap whose kind is outside the closed vocabulary", () => {
    const validate = makeValidator();
    const map = JSON.parse(readFileSync(join(EXAMPLES_DIR, "wiki-brain.logic-map.json"), "utf8"));
    map.gaps[0].kind = "unspecified_error_path"; // l'un des 50 noms libres d'avant la fermeture
    expect(validate(map)).toBe(false);
  });

  // Une famille qu'aucun trou du corpus n'occupe est une famille inventée : l'ontologie a été
  // fermée EN PARTANT des 131 trous, elle doit le rester.
  it("keeps every gap family grounded in the corpus", () => {
    const families = new Set<string>(
      (schema as { $defs: { gap: { properties: { kind: { enum: string[] } } } } }).$defs.gap
        .properties.kind.enum,
    );
    const used = new Set<string>();
    for (const file of exampleFiles) {
      const map = JSON.parse(readFileSync(join(EXAMPLES_DIR, file), "utf8")) as {
        gaps?: { kind: string }[];
      };
      for (const gap of map.gaps ?? []) used.add(gap.kind);
    }
    expect([...families].filter((f) => !used.has(f))).toEqual([]);
    expect(families.size).toBe(12);
  });

  it("requires `aggregated` when a node declares how many gestures it folds", () => {
    const validate = makeValidator();
    const map = JSON.parse(readFileSync(join(EXAMPLES_DIR, exampleFiles[0]!), "utf8"));
    map.steps[0].aggregates = 4;
    expect(validate(map)).toBe(false);
    map.steps[0].aggregated = true;
    expect(validate(map)).toBe(true);
  });
});
