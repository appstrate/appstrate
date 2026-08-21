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
  changedInputValues,
  resolvedInputDefaults,
  storedInputValues,
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

describe("storedInputValues", () => {
  // The run-with-options modal seeds from this ONCE and then lets the user
  // re-pin the version. Anything seeded here rides out as caller input — the
  // top precedence layer — so it must not carry a fact that belongs to the
  // version the modal happened to open on.
  it("omits the author default, leaving it to the selected version's schema", () => {
    // `folder` has `default: "inbox"` in WRAPPER and no stored value.
    expect(storedInputValues(settings({ values: { limit: 10 } }))).toEqual({ limit: 10 });
  });

  it("keeps the stored value, which is version-independent", () => {
    expect(storedInputValues(settings({ values: { folder: "archive" } }))).toEqual({
      folder: "archive",
    });
  });

  it("drops a stored value the caller is no longer allowed to set", () => {
    expect(
      storedInputValues(settings({ values: { folder: "archive" }, locked_fields: ["folder"] })),
    ).toEqual({});
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

describe("changedInputValues", () => {
  /**
   * A launch form is seeded with what the layers below it resolve to; this is
   * the guard that stops that seed from being claimed — and therefore frozen —
   * by the layer that submits it. The schedule form is the caller that matters:
   * `package_schedules.input` outranks the editor's stored values forever.
   */
  it("drops a field the user never touched", () => {
    const s = settings({ values: { query: "invoices" } });
    // Exactly the seed the form starts from — nothing edited.
    const seed = initialInputValues(WRAPPER, s);
    expect(seed).toEqual({ folder: "inbox", query: "invoices" });
    expect(changedInputValues(WRAPPER, s, seed)).toEqual({});
  });

  it("keeps a field the user set to something else", () => {
    const s = settings({ values: { query: "invoices" } });
    expect(
      changedInputValues(WRAPPER, s, { ...initialInputValues(WRAPPER, s), query: "receipts" }),
    ).toEqual({ query: "receipts" });
  });

  it("keeps a field no layer decided yet, which the user filled in", () => {
    const s = settings();
    expect(changedInputValues(WRAPPER, s, { folder: "inbox", limit: 25 })).toEqual({ limit: 25 });
  });

  it("keeps a field the user set back to the author default over a stored value", () => {
    // Stored value says "archive"; the user re-picks the author's "inbox".
    // That IS a decision of this layer — layers 1+2 resolve to "archive".
    const s = settings({ values: { folder: "archive" } });
    expect(changedInputValues(WRAPPER, s, { folder: "inbox" })).toEqual({ folder: "inbox" });
  });

  it("lets a later change to the stored value reach a schedule that never set it", () => {
    // Save the schedule against today's stored value…
    const atSave = settings({ values: { query: "invoices" } });
    const frozen = changedInputValues(WRAPPER, atSave, initialInputValues(WRAPPER, atSave));
    expect(frozen).toEqual({});
    // …then the editor changes it. The server's layer merge (author → stored →
    // schedule) now yields the NEW value, because the schedule froze nothing.
    const atFire = settings({ values: { query: "receipts" } });
    expect({ ...resolvedInputDefaults(WRAPPER, atFire), ...frozen }).toEqual({
      folder: "inbox",
      query: "receipts",
    });
  });

  it("drops a locked field even when its value differs", () => {
    const s = settings({ values: { folder: "archive" }, locked_fields: ["folder"] });
    expect(changedInputValues(WRAPPER, s, { folder: "trash", limit: 5 })).toEqual({ limit: 5 });
  });

  describe("with non-primitive values", () => {
    const JSON_WRAPPER: SchemaWrapper = {
      schema: {
        type: "object",
        properties: {
          filters: { type: "object" },
          tags: { type: "array", items: { type: "string" } },
        },
      },
    };

    it("treats a structurally identical object as unchanged", () => {
      const s = settings({ values: { filters: { status: "open", labels: ["a", "b"] } } });
      // A fresh object with the same shape — the form re-creates it on render.
      expect(
        changedInputValues(JSON_WRAPPER, s, { filters: { status: "open", labels: ["a", "b"] } }),
      ).toEqual({});
    });

    it("keeps an object whose nested value differs", () => {
      const s = settings({ values: { filters: { status: "open", labels: ["a", "b"] } } });
      expect(
        changedInputValues(JSON_WRAPPER, s, { filters: { status: "open", labels: ["a", "c"] } }),
      ).toEqual({ filters: { status: "open", labels: ["a", "c"] } });
    });

    it("keeps an object that gained or lost a key", () => {
      const s = settings({ values: { filters: { status: "open" } } });
      expect(
        changedInputValues(JSON_WRAPPER, s, { filters: { status: "open", assignee: "me" } }),
      ).toEqual({ filters: { status: "open", assignee: "me" } });
      expect(changedInputValues(JSON_WRAPPER, s, { filters: {} })).toEqual({ filters: {} });
    });

    it("compares arrays by order and length, not by identity", () => {
      const s = settings({ values: { tags: ["a", "b"] } });
      expect(changedInputValues(JSON_WRAPPER, s, { tags: ["a", "b"] })).toEqual({});
      expect(changedInputValues(JSON_WRAPPER, s, { tags: ["b", "a"] })).toEqual({
        tags: ["b", "a"],
      });
      expect(changedInputValues(JSON_WRAPPER, s, { tags: ["a"] })).toEqual({ tags: ["a"] });
    });

    it("never confuses an array with an object", () => {
      const s = settings({ values: { tags: [] } });
      expect(changedInputValues(JSON_WRAPPER, s, { tags: {} })).toEqual({ tags: {} });
    });
  });
});
