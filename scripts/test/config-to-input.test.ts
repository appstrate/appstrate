// SPDX-License-Identifier: Apache-2.0

/**
 * Transformation rules for the one-shot `config` → `input` migration
 * (`scripts/migrate-config-to-input.ts`). Every rule here decides what an
 * agent's parameters look like AFTER a migration nobody can undo, so each
 * branch is pinned: the collision rule, the wrapper metadata carry-over
 * (including `required`, whose loss would silently make a mandatory field
 * optional), the Mustache rewrite across every tag form the renderer accepts,
 * and idempotence.
 *
 * Pure — no database. The CLI owns all I/O.
 */

import { describe, it, expect } from "bun:test";
import {
  MIGRATED_SCHEMA_VERSION,
  blockingCollisions,
  hasConfigReference,
  hasConfigSection,
  inputPropertyNames,
  mergeConfigIntoInput,
  rewriteConfigReferences,
  type JsonObject,
} from "../lib/config-to-input.ts";

const baseManifest = (extra: JsonObject): JsonObject => ({
  type: "agent",
  name: "@acme/digest",
  version: "1.0.0",
  schema_version: "0.2",
  display_name: "Digest",
  ...extra,
});

const props = (manifest: JsonObject) =>
  (manifest["input"] as { schema: { properties: Record<string, unknown> } }).schema.properties;

const schemaOf = (manifest: JsonObject) =>
  (manifest["input"] as { schema: Record<string, unknown> }).schema;

const wrapperOf = (manifest: JsonObject) => manifest["input"] as Record<string, unknown>;

describe("hasConfigSection", () => {
  it("detects the retired section, including an explicit null", () => {
    expect(hasConfigSection({ config: { schema: {} } })).toBe(true);
    expect(hasConfigSection({ config: null })).toBe(true);
    expect(hasConfigSection({ input: {} })).toBe(false);
    expect(hasConfigSection(null)).toBe(false);
    expect(hasConfigSection("not an object")).toBe(false);
  });
});

describe("mergeConfigIntoInput — properties", () => {
  it("moves config properties into input and drops the config section", () => {
    const { manifest, report } = mergeConfigIntoInput(
      baseManifest({
        input: { schema: { type: "object", properties: { topic: { type: "string" } } } },
        config: { schema: { type: "object", properties: { days: { type: "number" } } } },
      }),
    );

    expect(Object.keys(props(manifest)).sort()).toEqual(["days", "topic"]);
    expect(props(manifest)["days"]).toEqual({ type: "number" });
    expect("config" in manifest).toBe(false);
    expect(report.merged).toEqual(["days"]);
    expect(report.collisions).toEqual([]);
  });

  it("stamps the migrated schema_version", () => {
    const { manifest } = mergeConfigIntoInput(
      baseManifest({ config: { schema: { type: "object", properties: {} } } }),
    );
    expect(manifest["schema_version"]).toBe(MIGRATED_SCHEMA_VERSION);
  });

  it("synthesises the input wrapper when the manifest declared none", () => {
    const { manifest } = mergeConfigIntoInput(
      baseManifest({
        config: { schema: { type: "object", properties: { days: { type: "number" } } } },
      }),
    );
    expect(schemaOf(manifest)["type"]).toBe("object");
    expect(Object.keys(props(manifest))).toEqual(["days"]);
  });

  it("keeps unrelated manifest fields untouched", () => {
    const { manifest } = mergeConfigIntoInput(
      baseManifest({
        timeout: 300,
        dependencies: { skills: { "@acme/fmt": "^1.0.0" } },
        config: { schema: { type: "object", properties: { days: { type: "number" } } } },
      }),
    );
    expect(manifest["timeout"]).toBe(300);
    expect(manifest["dependencies"]).toEqual({ skills: { "@acme/fmt": "^1.0.0" } });
    expect(manifest["display_name"]).toBe("Digest");
  });
});

describe("mergeConfigIntoInput — collisions", () => {
  it("keeps the input entry and drops the config one", () => {
    const { manifest, report } = mergeConfigIntoInput(
      baseManifest({
        input: {
          schema: { type: "object", properties: { tone: { type: "string", default: "neutral" } } },
        },
        config: { schema: { type: "object", properties: { tone: { type: "number" } } } },
      }),
    );

    expect(props(manifest)["tone"]).toEqual({ type: "string", default: "neutral" });
    expect(report.collisions).toEqual(["tone"]);
    expect(report.merged).toEqual([]);
  });

  it("drops the collided entry WHOLE — its required-ness does not survive", () => {
    const { manifest, report } = mergeConfigIntoInput(
      baseManifest({
        input: { schema: { type: "object", properties: { tone: { type: "string" } } } },
        config: {
          schema: { type: "object", properties: { tone: { type: "string" } }, required: ["tone"] },
        },
      }),
    );

    expect(schemaOf(manifest)["required"]).toBeUndefined();
    expect(report.requiredAdded).toEqual([]);
  });

  it("drops the collided entry's ui_hints and file_constraints too", () => {
    const { manifest, report } = mergeConfigIntoInput(
      baseManifest({
        input: { schema: { type: "object", properties: { tone: { type: "string" } } } },
        config: {
          schema: { type: "object", properties: { tone: { type: "string" } } },
          ui_hints: { tone: { placeholder: "from config" } },
          file_constraints: { tone: { accept: ".txt" } },
        },
      }),
    );

    expect(wrapperOf(manifest)["ui_hints"]).toBeUndefined();
    expect(wrapperOf(manifest)["file_constraints"]).toBeUndefined();
    expect(report.uiHintsCarried).toEqual([]);
    expect(report.fileConstraintsCarried).toEqual([]);
  });
});

describe("blockingCollisions", () => {
  // `application_packages.input_settings` is never rewritten, so a collided name's
  // stored value survives typed by the property the merge just dropped.
  const collisions = mergeConfigIntoInput(
    baseManifest({
      input: { schema: { type: "object", properties: { mode: { type: "integer" } } } },
      config: { schema: { type: "object", properties: { mode: { type: "string" } } } },
    }),
  ).report.collisions;

  it("blocks a collision whose name carries a stored value", () => {
    // Stored `{ mode: "fast" }` now validates against `{type:"integer"}`: every
    // launch 400s and `PUT …/input-settings` refuses the same value.
    expect(blockingCollisions(collisions, ["mode"])).toEqual(["mode"]);
  });

  it("leaves a collision with no stored value informational", () => {
    expect(blockingCollisions(collisions, [])).toEqual([]);
    expect(blockingCollisions(collisions, ["other"])).toEqual([]);
  });
});

describe("mergeConfigIntoInput — required", () => {
  it("carries a config `required` entry over for a merged property", () => {
    const { manifest, report } = mergeConfigIntoInput(
      baseManifest({
        input: {
          schema: {
            type: "object",
            properties: { topic: { type: "string" } },
            required: ["topic"],
          },
        },
        config: {
          schema: { type: "object", properties: { days: { type: "number" } }, required: ["days"] },
        },
      }),
    );

    expect(schemaOf(manifest)["required"]).toEqual(["topic", "days"]);
    expect(report.requiredAdded).toEqual(["days"]);
  });

  it("does not duplicate a name both sides already require", () => {
    const { manifest } = mergeConfigIntoInput(
      baseManifest({
        input: {
          schema: {
            type: "object",
            properties: { topic: { type: "string" } },
            required: ["topic"],
          },
        },
        config: {
          schema: {
            type: "object",
            properties: { days: { type: "number" } },
            required: ["topic", "days"],
          },
        },
      }),
    );
    expect(schemaOf(manifest)["required"]).toEqual(["topic", "days"]);
  });

  it("emits no `required` key when neither side declares one", () => {
    const { manifest } = mergeConfigIntoInput(
      baseManifest({
        input: { schema: { type: "object", properties: { topic: { type: "string" } } } },
        config: { schema: { type: "object", properties: { days: { type: "number" } } } },
      }),
    );
    expect("required" in schemaOf(manifest)).toBe(false);
  });
});

describe("mergeConfigIntoInput — wrapper metadata", () => {
  it("carries ui_hints and file_constraints for merged properties", () => {
    const { manifest, report } = mergeConfigIntoInput(
      baseManifest({
        input: {
          schema: { type: "object", properties: { topic: { type: "string" } } },
          ui_hints: { topic: { placeholder: "Subject" } },
        },
        config: {
          schema: { type: "object", properties: { days: { type: "number" } } },
          ui_hints: { days: { placeholder: "7" } },
          file_constraints: { days: { accept: ".csv" } },
        },
      }),
    );

    expect(wrapperOf(manifest)["ui_hints"]).toEqual({
      days: { placeholder: "7" },
      topic: { placeholder: "Subject" },
    });
    expect(wrapperOf(manifest)["file_constraints"]).toEqual({ days: { accept: ".csv" } });
    expect(report.uiHintsCarried).toEqual(["days"]);
    expect(report.fileConstraintsCarried).toEqual(["days"]);
  });

  it("puts input fields first and migrated config fields after, in their own order", () => {
    const { manifest } = mergeConfigIntoInput(
      baseManifest({
        input: {
          schema: {
            type: "object",
            properties: { topic: { type: "string" }, tone: { type: "string" } },
          },
          property_order: ["tone", "topic"],
        },
        config: {
          schema: {
            type: "object",
            properties: { days: { type: "number" }, locale: { type: "string" } },
          },
          property_order: ["locale", "days"],
        },
      }),
    );
    expect(wrapperOf(manifest)["property_order"]).toEqual(["tone", "topic", "locale", "days"]);
  });

  it("materialises a full order when only one side declared one", () => {
    const { manifest } = mergeConfigIntoInput(
      baseManifest({
        input: { schema: { type: "object", properties: { topic: { type: "string" } } } },
        config: {
          schema: {
            type: "object",
            properties: { days: { type: "number" }, locale: { type: "string" } },
          },
          property_order: ["locale", "days"],
        },
      }),
    );
    expect(wrapperOf(manifest)["property_order"]).toEqual(["topic", "locale", "days"]);
  });

  it("emits no property_order when neither side declared one", () => {
    const { manifest } = mergeConfigIntoInput(
      baseManifest({
        input: { schema: { type: "object", properties: { topic: { type: "string" } } } },
        config: { schema: { type: "object", properties: { days: { type: "number" } } } },
      }),
    );
    expect("property_order" in wrapperOf(manifest)).toBe(false);
  });
});

describe("mergeConfigIntoInput — idempotence", () => {
  it("is a no-op on a manifest with no config section", () => {
    const clean = baseManifest({
      input: { schema: { type: "object", properties: { topic: { type: "string" } } } },
    });
    const { manifest, report } = mergeConfigIntoInput(clean);
    expect(manifest).toBe(clean);
    expect(report.merged).toEqual([]);
    expect(manifest["schema_version"]).toBe("0.2");
  });

  it("re-running on its own output changes nothing", () => {
    const first = mergeConfigIntoInput(
      baseManifest({
        input: {
          schema: {
            type: "object",
            properties: { topic: { type: "string" } },
            required: ["topic"],
          },
        },
        config: {
          schema: { type: "object", properties: { days: { type: "number" } }, required: ["days"] },
          ui_hints: { days: { placeholder: "7" } },
        },
      }),
    ).manifest;
    const second = mergeConfigIntoInput(first).manifest;
    expect(second).toEqual(first);
  });
});

describe("inputPropertyNames", () => {
  it("lists the migrated input properties", () => {
    const { manifest } = mergeConfigIntoInput(
      baseManifest({
        input: { schema: { type: "object", properties: { topic: { type: "string" } } } },
        config: { schema: { type: "object", properties: { days: { type: "number" } } } },
      }),
    );
    expect(inputPropertyNames(manifest).sort()).toEqual(["days", "topic"]);
  });

  it("returns nothing for a manifest with no input wrapper", () => {
    expect(inputPropertyNames(baseManifest({}))).toEqual([]);
    expect(inputPropertyNames(null)).toEqual([]);
  });
});

describe("rewriteConfigReferences", () => {
  it("rewrites the plain interpolation", () => {
    expect(rewriteConfigReferences("Last {{config.days}} days")).toEqual({
      content: "Last {{input.days}} days",
      count: 1,
    });
  });

  it("rewrites padded tags — Mustache trims, so the spacing is not a guard", () => {
    expect(rewriteConfigReferences("{{  config.days  }}").content).toBe("{{input.days}}");
  });

  it("rewrites the raw, triple and section forms", () => {
    expect(rewriteConfigReferences("{{&config.days}}").content).toBe("{{&input.days}}");
    expect(rewriteConfigReferences("{{{config.days}}}").content).toBe("{{{input.days}}}");
    expect(rewriteConfigReferences("{{#config.on}}x{{/config.on}}").content).toBe(
      "{{#input.on}}x{{/input.on}}",
    );
    expect(rewriteConfigReferences("{{^config.on}}x{{/config.on}}").content).toBe(
      "{{^input.on}}x{{/input.on}}",
    );
  });

  it("rewrites the bare whole-object reference", () => {
    expect(rewriteConfigReferences("{{config}}").content).toBe("{{input}}");
    expect(rewriteConfigReferences("{{#config}}x{{/config}}").content).toBe(
      "{{#input}}x{{/input}}",
    );
  });

  it("counts every rewritten tag", () => {
    expect(rewriteConfigReferences("{{config.a}} {{config.b}} {{config.a}}").count).toBe(3);
  });

  it("leaves comments, delimiter changes and partials alone", () => {
    for (const tag of ["{{! config.days }}", "{{=<% %>=}}", "{{>config.days}}"]) {
      expect(rewriteConfigReferences(tag)).toEqual({ content: tag, count: 0 });
    }
  });

  it("leaves other namespaces and lookalike names alone", () => {
    const template = "{{input.days}} {{configuration.days}} {{platform.config}} config.days";
    expect(rewriteConfigReferences(template)).toEqual({ content: template, count: 0 });
  });

  it("is idempotent", () => {
    const once = rewriteConfigReferences("Last {{config.days}} days").content;
    expect(rewriteConfigReferences(once)).toEqual({ content: once, count: 0 });
  });
});

describe("hasConfigReference", () => {
  it("is true only for a tag that actually addresses the namespace", () => {
    expect(hasConfigReference("{{config.days}}")).toBe(true);
    expect(hasConfigReference("{{ config.days }}")).toBe(true);
    expect(hasConfigReference("{{input.days}}")).toBe(false);
    expect(hasConfigReference("{{! config.days }}")).toBe(false);
    expect(hasConfigReference(null)).toBe(false);
    expect(hasConfigReference(undefined)).toBe(false);
  });
});
