// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  crossCheckLogicMap,
  flowNodeRatio,
  grepEquivalence,
  type DeclaredCapabilities,
  type LogicMapLike,
} from "../src/logic-map-crosscheck.ts";

const EXAMPLES = join(import.meta.dir, "..", "..", "..", "examples", "logic-map");
const load = (name: string) =>
  JSON.parse(readFileSync(join(EXAMPLES, `${name}.logic-map.json`), "utf8")) as LogicMapLike;

/** Projection du manifeste réel de `@default/compta-gmail-harvest`. */
const HARVEST_DECLARED: DeclaredCapabilities = {
  toolbox: [
    { id: "@appstrate/gmail", tools: ["api_call"] },
    { id: "@appstrate/google-drive", tools: ["api_call"] },
  ],
  skills: ["@default/compta-references"],
  system_tools: ["output", "log", "pin"],
  config: ["drive_inbox_folder_id", "processed_label"],
  agent_input: ["trimestre", "since", "until", "dry_run", "max_messages"],
  agent_output: ["summary", "window", "harvested", "skipped", "stats", "dry_run_plan", "erreurs"],
  has_output_schema: true,
};

describe("logic map cross-check", () => {
  const map = load("compta-gmail-harvest");
  const findings = crossCheckLogicMap(map, HARVEST_DECLARED);

  it("flags an integration the prompt names but the manifest does not declare", () => {
    // Le prompt et la référence du skill nomment `@tractr/google-drive` ; le manifeste
    // déclare `@appstrate/google-drive`. Identifiant obsolète dans la documentation.
    const finding = findings.find(
      (f) => f.code === "ref_not_declared" && f.item_id === "@tractr/google-drive",
    );
    expect(finding).toBeDefined();
    expect(finding!.level).toBe("error");
    expect(finding!.step_ids.length).toBeGreaterThan(0);
  });

  it("reports the same defect once, however many steps carry it", () => {
    const notDeclared = findings.filter((f) => f.code === "ref_not_declared");
    const ids = notDeclared.map((f) => f.item_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps a granted-but-unused runtime tool a hint, never an error", () => {
    for (const tool of ["log", "pin"]) {
      const finding = findings.find(
        (f) => f.code === "declared_never_referenced" && f.item_id === tool,
      );
      expect(finding).toBeDefined();
      expect(finding!.level).toBe("hint");
    }
  });

  it("does not warn about a missing emit when the map has one", () => {
    expect(findings.some((f) => f.code === "output_schema_without_emit")).toBe(false);
  });

  it("warns when an output schema is declared but nothing emits", () => {
    const noEmit = { ...map, steps: map.steps.filter((s) => s.kind !== "emit") };
    const out = crossCheckLogicMap(noEmit, HARVEST_DECLARED);
    expect(out.some((f) => f.code === "output_schema_without_emit")).toBe(true);
  });

  it("never turns a runtime capability into an error, since none can be declared", () => {
    const inbox = load("compta-inbox");
    const out = crossCheckLogicMap(inbox, { system_tools: ["output", "log"] });
    const runtime = out.filter((f) => f.code === "undeclarable_runtime");
    expect(runtime.length).toBeGreaterThan(0);
    expect(runtime.every((f) => f.level === "hint")).toBe(true);
    expect(out.some((f) => f.level === "error" && f.item_id === "bash")).toBe(false);
  });

  it("collapses a large unreferenced set into a single inventory finding", () => {
    const declared: DeclaredCapabilities = {
      toolbox: Array.from({ length: 20 }, (_, i) => ({ id: `@x/tool-${i}` })),
    };
    const out = crossCheckLogicMap(load("fleet-software-engineer"), declared);
    expect(out.filter((f) => f.code === "declared_never_referenced")).toHaveLength(0);
    const inventory = out.find((f) => f.code === "unreferenced_inventory");
    expect(inventory).toBeDefined();
    expect(inventory!.level).toBe("inventory");
  });

  it("flags a tool that its integration does not grant", () => {
    const out = crossCheckLogicMap(
      {
        shape: "sequence",
        steps: [
          {
            id: "s1",
            kind: "tool_call",
            label: "upload",
            refs: ["toolbox:@appstrate/google-drive#api_upload"],
          },
        ],
        edges: [],
      },
      { toolbox: [{ id: "@appstrate/google-drive", tools: ["api_call"] }] },
    );
    const finding = out.find((f) => f.code === "tool_not_granted");
    expect(finding).toBeDefined();
    expect(finding!.level).toBe("error");
  });

  it("flags a schedule no rule covers", () => {
    // Aucune étape n'émet `schedules:sch_1` : le cron quotidien de cet agent n'est décrit
    // nulle part dans son prompt, et le constat ne doit rien devoir à un rapprochement de mots.
    const out = crossCheckLogicMap(load("fleet-executive-assistant"), {
      schedules: [{ id: "sch_1", name: "Daily calendar and email brief" }],
    });
    expect(out.some((f) => f.code === "schedule_without_rule")).toBe(true);
  });

  it("considers a schedule covered only when a step references it", () => {
    const out = crossCheckLogicMap(
      {
        shape: "sequence",
        steps: [{ id: "s1", kind: "step", label: "Produire le brief", refs: ["schedules:sch_1"] }],
        edges: [],
      },
      { schedules: [{ id: "sch_1", name: "Daily calendar and email brief" }] },
    );
    expect(out.some((f) => f.code === "schedule_without_rule")).toBe(false);
  });

  it("does not let a word match stand in for a reference", () => {
    // Une étape qui parle d'agenda et de courriel ne couvre pas pour autant le cron : le
    // croisement ne fait jamais de correspondance textuelle.
    const out = crossCheckLogicMap(
      {
        shape: "sequence",
        steps: [
          { id: "s1", kind: "step", label: "Trier le calendar et les email du brief", refs: [] },
        ],
        edges: [],
      },
      { schedules: [{ id: "sch_1", name: "Daily calendar and email brief" }] },
    );
    expect(out.some((f) => f.code === "schedule_without_rule")).toBe(true);
  });

  it("separates the two families by flow-node ratio", () => {
    expect(flowNodeRatio(load("compta-gmail-harvest"))).toBeGreaterThan(0.7);
    expect(flowNodeRatio(load("fleet-on-call-copilot"))).toBeLessThan(0.15);
  });

  it("questions a declared shape the structure contradicts", () => {
    const asPolicies = { ...map, shape: "policies" as const };
    const out = crossCheckLogicMap(asPolicies, HARVEST_DECLARED);
    expect(out.some((f) => f.code === "shape_suspect")).toBe(true);
  });

  it("measures how much a plain substring search would have found", () => {
    // Un prompt qui nomme ses outils : la lecture de sens n'apporte rien de plus.
    const named = grepEquivalence(
      {
        shape: "sequence",
        steps: [{ id: "s1", kind: "tool_call", label: "x", refs: ["toolbox:gmail#send_email"] }],
        edges: [],
      },
      "appelle send_email pour envoyer",
    );
    expect(named).toBe(1);
    // Un prompt qui les désigne par leur effet : elle est décisive.
    const implied = grepEquivalence(
      {
        shape: "sequence",
        steps: [{ id: "s1", kind: "emit", label: "x", refs: ["system_tools:output"] }],
        edges: [],
      },
      "Renseigne le résumé et les statistiques",
    );
    expect(implied).toBe(0);
  });
});
