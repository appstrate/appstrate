// SPDX-License-Identifier: Apache-2.0

/**
 * The pure half of the skill picker: the pin toggle, its rows, the write coalescer and
 * the revert-on-failure rule — invisible in a screenshot, wrong in production.
 */

import { describe, expect, it } from "bun:test";
import {
  createSkillsWriter,
  settleSkillsWrite,
  skillPickerRows,
  togglePinned,
  type SkillsWriteOutcome,
} from "../src/ui/chat-skills.ts";
import { MAX_PINNED_SKILLS, type ChatSkillSelection } from "../src/skills.ts";

const fullSet = () => Array.from({ length: MAX_PINNED_SKILLS }, (_, i) => `@s/p${i}`).sort();

describe("togglePinned", () => {
  it("adds, removes, and keeps the set sorted", () => {
    expect(togglePinned(["@b/x"], "@a/y")).toEqual(["@a/y", "@b/x"]);
    expect(togglePinned(["@a/y", "@b/x"], "@a/y")).toEqual(["@b/x"]);
  });

  it("refuses a pin past the cap by returning the SAME array", () => {
    const full = fullSet();
    expect(togglePinned(full, "@s/extra")).toBe(full);
  });

  it("still unpins when the set is full", () => {
    const full = fullSet();
    expect(togglePinned(full, full[0]!)).toHaveLength(MAX_PINNED_SKILLS - 1);
  });
});

describe("skillPickerRows", () => {
  const tone = {
    package_id: "@acme/tone",
    display_name: "Tone",
    description: null,
    version: "1.0.0",
  };

  it("lists the catalogue as available rows, in its order", () => {
    const pdf = { ...tone, package_id: "@acme/pdf" };
    expect(skillPickerRows([tone, pdf], ["@acme/pdf"])).toEqual([
      { skill: tone, available: true },
      { skill: pdf, available: true },
    ]);
  });

  it("appends every pin the catalogue no longer lists, so it can be unpinned", () => {
    expect(skillPickerRows([tone], ["@acme/gone", "@acme/tone", "@z/deleted"])).toEqual([
      { skill: tone, available: true },
      { skill: { package_id: "@acme/gone" }, available: false },
      { skill: { package_id: "@z/deleted" }, available: false },
    ]);
  });

  it("still lists dead pins when the catalogue is empty", () => {
    expect(skillPickerRows([], ["@acme/gone"])).toEqual([
      { skill: { package_id: "@acme/gone" }, available: false },
    ]);
  });

  it("has no rows for an empty catalogue and no pins", () => {
    expect(skillPickerRows([], [])).toEqual([]);
  });
});

/** A `put` whose promise the test settles by hand. */
function deferredPut() {
  const calls: ChatSkillSelection[] = [];
  const resolvers: Array<() => void> = [];
  const rejecters: Array<(e: unknown) => void> = [];
  const put = (selection: ChatSkillSelection) => {
    calls.push(selection);
    return new Promise<void>((resolve, reject) => {
      resolvers.push(resolve);
      rejecters.push(reject);
    });
  };
  return { calls, resolvers, rejecters, put };
}

const sel = (pinned: string[], catalogue = true): ChatSkillSelection => ({ catalogue, pinned });
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

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
    await flush();

    expect(calls).toEqual([sel(["@a/one"]), sel(["@a/one", "@b/two", "@c/three"])]);
  });

  it("reports a failure with a newer write queued as NOT idle, then drains", async () => {
    const { calls, rejecters, put } = deferredPut();
    const settled: SkillsWriteOutcome[] = [];
    const writer = createSkillsWriter(put, (outcome) => settled.push(outcome));

    writer.write(sel(["@a/one"]));
    writer.write(sel(["@b/two"]));
    rejecters[0]!(new Error("HTTP 500"));
    await flush();

    expect(settled).toEqual([{ sent: sel(["@a/one"]), ok: false, idle: false }]);
    expect(calls).toEqual([sel(["@a/one"]), sel(["@b/two"])]);
  });

  it("reports a settled success, idle when nothing is queued", async () => {
    const { resolvers, put } = deferredPut();
    const settled: SkillsWriteOutcome[] = [];
    createSkillsWriter(put, (outcome) => settled.push(outcome)).write(sel([], false));
    resolvers[0]!();
    await flush();
    expect(settled).toEqual([{ sent: sel([], false), ok: true, idle: true }]);
  });
});

describe("settleSkillsWrite", () => {
  const confirmed = sel(["@a/one"]);

  it("confirms what a successful write sent, without touching the picker", () => {
    expect(settleSkillsWrite(confirmed, { sent: sel([], false), ok: true, idle: true })).toEqual({
      confirmed: sel([], false),
      revert: false,
    });
  });

  it("reverts to the last confirmed selection when the latest write fails", () => {
    expect(settleSkillsWrite(confirmed, { sent: sel(["@b/two"]), ok: false, idle: true })).toEqual({
      confirmed,
      revert: true,
    });
  });

  it("leaves a queued newer write to decide instead of reverting under it", () => {
    expect(settleSkillsWrite(confirmed, { sent: sel(["@b/two"]), ok: false, idle: false })).toEqual(
      { confirmed, revert: false },
    );
  });
});
