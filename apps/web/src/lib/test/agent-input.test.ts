// SPDX-License-Identifier: Apache-2.0

/**
 * The client half of input resolution.
 *
 * A launch form that mis-sorts a field is not a cosmetic bug: putting a locked
 * field in an editable section builds a request the server refuses with 400
 * `locked_input_field`, and putting a prompted field behind the collapsed
 * "Avancé" fold hides the one thing the user actually has to fill in. These
 * tests pin the sort and the value overlay against the server's four layers
 * (`apps/api/src/services/input-resolution.ts`).
 */

import { describe, it, expect } from "bun:test";
import type { SchemaWrapper } from "@appstrate/core/form";
import {
  formatInputValue,
  hasInputFields,
  initialInputValues,
  partitionInputFields,
  resolvedInputDefaults,
  subsetWrapper,
  withoutLockedFields,
  type AgentInputSettings,
} from "../agent-input";

const WRAPPER: SchemaWrapper = {
  schema: {
    type: "object",
    properties: {
      query: { type: "string", title: "Query" },
      folder: { type: "string", default: "inbox" },
      limit: { type: "number" },
      tone: { type: "string" },
    },
    required: ["query", "folder"],
  },
  ui_hints: { query: { placeholder: "Search…" }, tone: { placeholder: "Neutral" } },
  file_constraints: { query: { accept: ".pdf" } },
  property_order: ["folder", "query", "limit", "tone"],
};

function settings(over: Partial<AgentInputSettings> = {}): AgentInputSettings {
  return { values: {}, locked_fields: [], ...over };
}

describe("resolvedInputDefaults", () => {
  it("overlays the stored value on the author default", () => {
    expect(resolvedInputDefaults(WRAPPER, settings({ values: { folder: "archive" } }))).toEqual({
      folder: "archive",
    });
  });

  it("leaves a field no layer supplies absent rather than null", () => {
    const resolved = resolvedInputDefaults(WRAPPER, settings());
    expect(resolved).toEqual({ folder: "inbox" });
    expect("query" in resolved).toBe(false);
  });
});

describe("partitionInputFields", () => {
  it("sorts each field into exactly one display state, in presentation order", () => {
    const partition = partitionInputFields(
      WRAPPER,
      settings({ values: { limit: 10 }, locked_fields: ["tone"] }),
    );
    // `folder` has an author default, `limit` a stored value → both pre-filled.
    expect(partition).toEqual({
      locked: ["tone"],
      prefilled: ["folder", "limit"],
      prompted: ["query"],
    });
  });

  it("keeps a locked field locked even when it also has a value", () => {
    const partition = partitionInputFields(WRAPPER, settings({ locked_fields: ["folder"] }));
    expect(partition.locked).toEqual(["folder"]);
    expect(partition.prefilled).not.toContain("folder");
  });

  it("prompts everything when nothing is decided", () => {
    const bare: SchemaWrapper = {
      schema: { type: "object", properties: { a: { type: "string" }, b: { type: "string" } } },
    };
    expect(partitionInputFields(bare, settings())).toEqual({
      locked: [],
      prefilled: [],
      prompted: ["a", "b"],
    });
  });

  it("returns three empty lists for an agent with no parameters", () => {
    expect(partitionInputFields(undefined, settings())).toEqual({
      locked: [],
      prefilled: [],
      prompted: [],
    });
  });
});

describe("subsetWrapper", () => {
  it("carries the per-field metadata of the kept keys only", () => {
    const subset = subsetWrapper(WRAPPER, ["query", "tone"]);
    expect(Object.keys(subset!.schema.properties)).toEqual(["query", "tone"]);
    expect(subset!.ui_hints).toEqual({
      query: { placeholder: "Search…" },
      tone: { placeholder: "Neutral" },
    });
    expect(subset!.file_constraints).toEqual({ query: { accept: ".pdf" } });
    expect(subset!.property_order).toEqual(["query", "tone"]);
  });

  it("drops `required` entries the subset does not contain", () => {
    // `folder` is required but lives in another section — keeping it would make
    // this form permanently invalid on a field it does not even render.
    expect(subsetWrapper(WRAPPER, ["query"])!.schema.required).toEqual(["query"]);
    expect(subsetWrapper(WRAPPER, ["limit"])!.schema.required).toBeUndefined();
  });

  it("returns null for an empty subset so the caller can skip the form", () => {
    expect(subsetWrapper(WRAPPER, [])).toBeNull();
    expect(subsetWrapper(WRAPPER, ["unknown"])).toBeNull();
    expect(subsetWrapper(undefined, ["query"])).toBeNull();
  });
});

describe("initialInputValues", () => {
  it("pre-fills the decided fields and asks nothing for the rest", () => {
    expect(initialInputValues(WRAPPER, settings({ values: { limit: 10 } }))).toEqual({
      folder: "inbox",
      limit: 10,
    });
  });

  it("lets the seed win over the stored value", () => {
    expect(
      initialInputValues(WRAPPER, settings({ values: { folder: "archive" } }), { folder: "spam" }),
    ).toEqual({ folder: "spam" });
  });

  it("drops a seeded value for a field locked since the seed was saved", () => {
    // A re-run or an old schedule row can carry one; sending it would 400.
    const seeded = initialInputValues(WRAPPER, settings({ locked_fields: ["folder"] }), {
      folder: "spam",
      query: "hello",
    });
    expect(seeded).toEqual({ query: "hello" });
  });
});

describe("withoutLockedFields", () => {
  it("returns the same object when nothing is locked", () => {
    const values = { a: 1 };
    expect(withoutLockedFields(values, [])).toBe(values);
  });

  it("removes only the locked keys", () => {
    expect(withoutLockedFields({ a: 1, b: 2 }, ["b"])).toEqual({ a: 1 });
  });
});

describe("hasInputFields", () => {
  it("is false for an absent or empty schema", () => {
    expect(hasInputFields(undefined)).toBe(false);
    expect(hasInputFields({ schema: { type: "object", properties: {} } })).toBe(false);
  });

  it("is true as soon as one property is declared", () => {
    expect(hasInputFields(WRAPPER)).toBe(true);
  });
});

describe("formatInputValue", () => {
  it("renders a string verbatim and everything else as JSON", () => {
    expect(formatInputValue("archive")).toBe("archive");
    expect(formatInputValue(10)).toBe("10");
    expect(formatInputValue(true)).toBe("true");
    expect(formatInputValue(["a", "b"])).toBe('["a","b"]');
  });

  it("marks the absence of a value rather than printing `undefined`", () => {
    expect(formatInputValue(undefined)).toBe("—");
  });
});
