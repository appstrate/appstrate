// SPDX-License-Identifier: Apache-2.0

/**
 * The pure half of the skill picker: normalisation, the pin toggle, the
 * optimistic cache patch, and the write coalescer.
 *
 * These are the rules React cannot show you are wrong. A pin set that keeps
 * insertion order makes two equal selections look different; a coalescer that
 * lets two PUTs race lets the OLDER selection win, and the user sees their last
 * click undone a second later. Both are invisible in a screenshot.
 */

import { describe, expect, it } from "bun:test";
import {
  createSkillsWriter,
  defaultSkillSelection,
  groupSkillsBySource,
  MAX_PINNED_SKILLS,
  normalizeDiscovery,
  normalizePinned,
  togglePinned,
  withSkillSelection,
  type ChatSkillEntry,
  type SessionHistory,
  type SessionSkillSelection,
} from "../src/ui/chat-skills.ts";

const entry = (id: string, source: ChatSkillEntry["source"]): ChatSkillEntry => ({
  package_id: id,
  display_name: id,
  description: "",
  version: null,
  source,
});

describe("normalizeDiscovery", () => {
  it("keeps every known mode", () => {
    expect(normalizeDiscovery("auto")).toBe("auto");
    expect(normalizeDiscovery("on_demand")).toBe("on_demand");
    expect(normalizeDiscovery("manual")).toBe("manual");
  });

  it("degrades anything else to the default instead of indexing nothing", () => {
    expect(normalizeDiscovery(undefined)).toBe("auto");
    expect(normalizeDiscovery("off")).toBe("auto");
    expect(normalizeDiscovery(3)).toBe("auto");
  });
});

describe("normalizePinned", () => {
  it("dedupes and sorts so equal selections compare equal", () => {
    expect(normalizePinned(["@b/x", "@a/y", "@b/x"])).toEqual(["@a/y", "@b/x"]);
  });

  it("drops non-strings and empties from an untrusted payload", () => {
    expect(normalizePinned(["@a/y", 1, null, "", { id: "@c/z" }])).toEqual(["@a/y"]);
    expect(normalizePinned("nope")).toEqual([]);
    expect(normalizePinned(undefined)).toEqual([]);
  });

  it("caps at the server's limit", () => {
    const many = Array.from({ length: MAX_PINNED_SKILLS + 5 }, (_, i) => `@s/p${i + 100}`);
    expect(normalizePinned(many)).toHaveLength(MAX_PINNED_SKILLS);
  });
});

describe("togglePinned", () => {
  it("adds, removes, and keeps the set sorted", () => {
    expect(togglePinned(["@b/x"], "@a/y")).toEqual(["@a/y", "@b/x"]);
    expect(togglePinned(["@a/y", "@b/x"], "@a/y")).toEqual(["@b/x"]);
  });

  it("refuses a pin past the cap by returning the SAME array", () => {
    const full = normalizePinned(Array.from({ length: MAX_PINNED_SKILLS }, (_, i) => `@s/p${i}`));
    expect(togglePinned(full, "@s/extra")).toBe(full);
  });

  it("still unpins when the set is full", () => {
    const full = normalizePinned(Array.from({ length: MAX_PINNED_SKILLS }, (_, i) => `@s/p${i}`));
    expect(togglePinned(full, full[0]!)).toHaveLength(MAX_PINNED_SKILLS - 1);
  });
});

describe("withSkillSelection", () => {
  it("keeps the loaded history and replaces the selection", () => {
    const prev: SessionHistory = {
      messages: [{ id: "m1", role: "user", parts: [] }] as never,
      skills: { discovery: "auto", pinned: [] },
    };
    const next = withSkillSelection(prev, { discovery: "manual", pinned: ["@b/x", "@a/y"] });
    expect(next.messages).toBe(prev.messages);
    expect(next.skills).toEqual({ discovery: "manual", pinned: ["@a/y", "@b/x"] });
  });

  it("seeds an entry for a conversation whose first message has not been sent", () => {
    expect(withSkillSelection(undefined, { discovery: "on_demand", pinned: [] })).toEqual({
      messages: [],
      skills: { discovery: "on_demand", pinned: [] },
    });
  });
});

describe("groupSkillsBySource", () => {
  it("puts the platform group first and preserves server order within a group", () => {
    const groups = groupSkillsBySource([
      entry("@appstrate/copilot", "platform"),
      entry("@acme/tone", "space"),
      entry("@appstrate/web-search", "platform"),
    ]);
    expect(groups.map((g) => g.source)).toEqual(["platform", "space"]);
    expect(groups[0]!.skills.map((s) => s.package_id)).toEqual([
      "@appstrate/copilot",
      "@appstrate/web-search",
    ]);
  });

  it("drops an empty group instead of rendering a bare heading", () => {
    expect(groupSkillsBySource([entry("@acme/tone", "space")]).map((g) => g.source)).toEqual([
      "space",
    ]);
    expect(groupSkillsBySource([])).toEqual([]);
  });
});

/** A `put` whose promise the test resolves by hand. */
function deferredPut() {
  const calls: SessionSkillSelection[] = [];
  const resolvers: Array<() => void> = [];
  const rejecters: Array<(e: unknown) => void> = [];
  const put = (selection: SessionSkillSelection) => {
    calls.push(selection);
    return new Promise<void>((resolve, reject) => {
      resolvers.push(resolve);
      rejecters.push(reject);
    });
  };
  return { calls, resolvers, rejecters, put };
}

const sel = (pinned: string[]): SessionSkillSelection => ({ discovery: "auto", pinned });

describe("createSkillsWriter", () => {
  it("sends the first write immediately", () => {
    const { calls, put } = deferredPut();
    createSkillsWriter(put).write(sel(["@a/one"]));
    expect(calls).toEqual([sel(["@a/one"])]);
  });

  it("keeps one request in flight and lets the LAST queued selection win", async () => {
    const { calls, resolvers, put } = deferredPut();
    const writer = createSkillsWriter(put);

    writer.write(sel(["@a/one"]));
    writer.write(sel(["@a/one", "@b/two"]));
    writer.write(sel(["@a/one", "@b/two", "@c/three"]));
    expect(calls).toHaveLength(1);

    resolvers[0]!();
    await Promise.resolve();
    await Promise.resolve();

    // The intermediate selection nobody looked at is never sent.
    expect(calls).toEqual([sel(["@a/one"]), sel(["@a/one", "@b/two", "@c/three"])]);
  });

  it("drains the queue after a FAILED write rather than wedging", async () => {
    const { calls, rejecters, put } = deferredPut();
    const settled: unknown[] = [];
    const writer = createSkillsWriter(put, (error) => settled.push(error));

    writer.write(sel(["@a/one"]));
    writer.write(sel(["@b/two"]));
    rejecters[0]!(new Error("HTTP 500"));
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toEqual([sel(["@a/one"]), sel(["@b/two"])]);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toBeInstanceOf(Error);
  });

  it("reports a settled success with no error", async () => {
    const { resolvers, put } = deferredPut();
    const settled: unknown[] = [];
    createSkillsWriter(put, (error) => settled.push(error)).write(sel([]));
    resolvers[0]!();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toEqual([undefined]);
  });
});

describe("defaultSkillSelection", () => {
  it("is what a session with no row resolves to", () => {
    expect(defaultSkillSelection()).toEqual({ discovery: "auto", pinned: [] });
  });
});
