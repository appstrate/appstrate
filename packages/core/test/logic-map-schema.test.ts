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

  it("requires `aggregated` when a node declares how many gestures it folds", () => {
    const validate = makeValidator();
    const map = JSON.parse(readFileSync(join(EXAMPLES_DIR, exampleFiles[0]!), "utf8"));
    map.steps[0].aggregates = 4;
    expect(validate(map)).toBe(false);
    map.steps[0].aggregated = true;
    expect(validate(map)).toBe(true);
  });
});
