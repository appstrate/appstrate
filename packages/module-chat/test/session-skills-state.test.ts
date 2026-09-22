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
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import {
  createSkillsWriter,
  defaultSkillSelection,
  groupSkillsBySource,
  normalizeDiscovery,
  normalizePinned,
  togglePinned,
  withSkillSelection,
  type ChatSkillEntry,
  type SessionHistory,
  type SessionSkillSelection,
} from "../src/ui/chat-skills.ts";
import { MAX_PINNED_SKILLS, toSkillDiscovery } from "../src/skills.ts";
import { sessionQueryKey } from "../src/ui/sessions.ts";

const entry = (id: string, source: ChatSkillEntry["source"]): ChatSkillEntry => ({
  package_id: id,
  display_name: id,
  description: "",
  version: null,
  source,
});

describe("normalizeDiscovery", () => {
  it("IS the server's own narrowing function, not a second copy of it", () => {
    // Two implementations of "an unknown mode falls back to the default" drift;
    // the picker and the resolver must disagree only if this identity breaks.
    expect(normalizeDiscovery).toBe(toSkillDiscovery);
  });

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

  it("buckets a source this build does not know with the space ones", () => {
    // A newer server could grow a third source. A row that renders in no group
    // is a skill the user cannot pin; a mis-grouped row still pins.
    const groups = groupSkillsBySource([
      entry("@acme/tone", "org" as ChatSkillEntry["source"]),
      entry("@appstrate/copilot", "platform"),
    ]);
    expect(groups.map((g) => g.source)).toEqual(["platform", "space"]);
    expect(groups[1]!.skills.map((s) => s.package_id)).toEqual(["@acme/tone"]);
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

/**
 * The picker's hook is a SECOND OBSERVER of the session-history entry that
 * `<Conversation>` owns, and React Query merges options across observers rather
 * than scoping them. Two of the owner's options are load-bearing and neither is
 * visible in a screenshot:
 *
 * - `gcTime` takes the MAX, so an observer that accepts the 5 min default keeps
 *   a conversation's history cached long past unmount — a returning user is
 *   re-seeded with a history that is missing every turn sent in between.
 * - the queryFn left on the Query is the last-rendering observer's, so a
 *   `skipToken` here makes the failure path's `invalidateQueries` reject with
 *   "Missing queryFn".
 *
 * These run against a real `QueryClient` — no React needed, the observer is the
 * thing under test. Construction order matters and mirrors the app: the OWNER
 * builds the query (with its options), the picker's observer joins afterwards,
 * and `updateGcTime` can then only raise the ceiling, never lower it.
 */
const OWNER_OPTIONS = {
  queryFn: () => Promise.resolve(HISTORY),
  enabled: true,
  staleTime: Infinity,
  gcTime: 0,
} as const;
const HISTORY: SessionHistory = { messages: [], skills: { discovery: "auto", pinned: [] } };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The owner builds the query; the picker's observer joins a seeded one. */
function seededClient(queryKey: readonly unknown[]) {
  const client = new QueryClient();
  const owner = new QueryObserver(client, { queryKey, ...OWNER_OPTIONS });
  client.setQueryData(queryKey, HISTORY);
  return { client, owner };
}

describe("session-history observers", () => {
  it("collects the entry as soon as both observers unmount", async () => {
    const queryKey = sessionQueryKey("spc_a", "chs_1");
    const { client, owner } = seededClient(queryKey);
    const picker = new QueryObserver(client, {
      queryKey,
      queryFn: () => Promise.resolve(HISTORY),
      enabled: false,
      staleTime: Infinity,
      gcTime: 0,
    });

    const unsubOwner = owner.subscribe(() => {});
    const unsubPicker = picker.subscribe(() => {});
    unsubOwner();
    unsubPicker();
    await tick();

    expect(client.getQueryCache().find({ queryKey })).toBeUndefined();
  });

  it("would NOT collect it if the picker accepted the default gcTime", async () => {
    // The control: without this case the assertion above passes for a hook that
    // never had the bug and for one that still does.
    const queryKey = sessionQueryKey("spc_a", "chs_1");
    const { client, owner } = seededClient(queryKey);
    const picker = new QueryObserver(client, { queryKey, queryFn: () => Promise.resolve(HISTORY) });

    const unsubOwner = owner.subscribe(() => {});
    const unsubPicker = picker.subscribe(() => {});
    unsubOwner();
    unsubPicker();
    await tick();

    expect(client.getQueryCache().find({ queryKey })).toBeDefined();
  });

  it("leaves a callable queryFn behind, so the failure path can invalidate", async () => {
    const queryKey = sessionQueryKey("spc_a", "chs_1");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let fetches = 0;
    const load = () => {
      fetches++;
      return Promise.resolve(HISTORY);
    };
    const owner = new QueryObserver(client, { queryKey, ...OWNER_OPTIONS, queryFn: load });
    client.setQueryData(queryKey, HISTORY);
    const picker = new QueryObserver(client, {
      queryKey,
      queryFn: load,
      enabled: false,
      staleTime: Infinity,
      gcTime: 0,
    });

    const unsubOwner = owner.subscribe(() => {});
    const unsubPicker = picker.subscribe(() => {});
    await client.invalidateQueries({ queryKey });
    expect(fetches).toBeGreaterThan(0);

    unsubPicker();
    unsubOwner();
  });
});
