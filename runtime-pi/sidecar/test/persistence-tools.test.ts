// SPDX-License-Identifier: Apache-2.0

/**
 * The agent-facing half of the memory contract.
 *
 * What these pin is what the AGENT is told, because that is what the previous
 * design got wrong: the tool answered "Note saved" before anything had been
 * written, and kept answering it when the write was refused. A truthful answer
 * is not cosmetic — it is the only signal the model can act on.
 */

import { describe, it, expect } from "bun:test";
import { buildRuntimeToolDefs } from "@appstrate/core/runtime-tool-defs";
import { RUNTIME_TOOL_EVENTS_META_KEY } from "@appstrate/core/runtime-tool-defs";
import { commandBackedRuntimeToolDefs, type FetchFn } from "../persistence-tools.ts";

interface Call {
  url: string;
  body: Record<string, unknown>;
}

/** Fetch double recording every call and replaying a queued response per call. */
function stubFetch(responses: Array<{ status?: number; json?: unknown } | "throw">): {
  fetchFn: FetchFn;
  calls: Call[];
} {
  const calls: Call[] = [];
  let index = 0;
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
    const next = responses[Math.min(index++, responses.length - 1)]!;
    if (next === "throw") throw new Error("ECONNREFUSED");
    return new Response(JSON.stringify(next.json ?? {}), {
      status: next.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetchFn, calls };
}

function toolsFor(selected: string[], fetchFn: FetchFn, newOperationId = () => "op-fixed") {
  const base = buildRuntimeToolDefs({ runtimeTools: selected });
  const defs = commandBackedRuntimeToolDefs(
    base,
    { platformApiUrl: "http://sidecar", runToken: "tok", fetchFn, newOperationId },
    selected,
  );
  return new Map(defs.map((d) => [d.descriptor.name, d]));
}

function eventsOf(result: { _meta?: Record<string, unknown> }): Array<Record<string, unknown>> {
  return (result._meta?.[RUNTIME_TOOL_EVENTS_META_KEY] ?? []) as Array<Record<string, unknown>>;
}

describe("note — the answer reflects the write", () => {
  it("reports success only once the platform committed", async () => {
    const { fetchFn, calls } = stubFetch([{ json: { outcome: "committed" } }]);
    const note = toolsFor(["note"], fetchFn).get("note")!;

    const result = await note.handler({ content: "Gmail paginates at 100" });

    expect(result.content[0]!.text).toBe("Note saved");
    expect(calls[0]!.url).toBe("http://sidecar/internal/memory");
    expect(calls[0]!.body).toMatchObject({
      operation_id: "op-fixed",
      content: "Gmail paginates at 100",
    });
    // The event is emitted only on success, and carries the idempotency key so
    // the terminal path can tell it was already applied.
    expect(eventsOf(result)).toEqual([
      { type: "memory.added", content: "Gmail paginates at 100", operationId: "op-fixed" },
    ]);
  });

  it("tells the agent when the archive refused the write", async () => {
    const { fetchFn } = stubFetch([
      {
        json: {
          outcome: "rejected",
          reason: "quota_exceeded",
          detail: "Archive is full (100 memories for this scope).",
        },
      },
    ]);
    const note = toolsFor(["note"], fetchFn).get("note")!;

    const result = await note.handler({ content: "one too many" });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("not saved");
    expect(result.content[0]!.text).toContain("Archive is full");
    // No event: nothing happened, so nothing should reach the aggregate.
    expect(eventsOf(result)).toEqual([]);
  });

  it("does not claim success when the platform is unreachable", async () => {
    const { fetchFn } = stubFetch(["throw", "throw"]);
    const note = toolsFor(["note"], fetchFn).get("note")!;

    const result = await note.handler({ content: "lost" });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("not saved");
  });

  it("retries a transport failure under the SAME operation id", async () => {
    const { fetchFn, calls } = stubFetch(["throw", { json: { outcome: "committed" } }]);
    const note = toolsFor(["note"], fetchFn).get("note")!;

    const result = await note.handler({ content: "eventually saved" });

    expect(result.content[0]!.text).toBe("Note saved");
    expect(calls).toHaveLength(2);
    // Reusing the id is what makes the retry safe: if the first attempt did
    // commit before the connection dropped, the platform replays its receipt
    // instead of writing a second row.
    expect(calls[0]!.body.operation_id).toBe(calls[1]!.body.operation_id);
  });

  it("forwards an explicit shared scope", async () => {
    const { fetchFn, calls } = stubFetch([{ json: { outcome: "committed" } }]);
    const note = toolsFor(["note"], fetchFn).get("note")!;

    await note.handler({ content: "an app-wide fact", scope: "shared" });

    expect(calls[0]!.body.scope).toBe("shared");
  });
});

describe("pin — revision travels back to the agent", () => {
  it("reports the committed revision", async () => {
    const { fetchFn } = stubFetch([
      { json: { outcome: "committed", revision: 4, content: { a: 1 } } },
    ]);
    const pin = toolsFor(["pin"], fetchFn).get("pin")!;

    const result = await pin.handler({ key: "goals", content: { a: 1 } });

    expect(result.content[0]!.text).toContain("revision 4");
    expect(eventsOf(result)[0]).toMatchObject({
      type: "pinned.set",
      key: "goals",
      revision: 4,
      operationId: "op-fixed",
    });
  });

  it("surfaces a refusal instead of reporting an update", async () => {
    const { fetchFn } = stubFetch([
      {
        json: { outcome: "rejected", reason: "slot_quota_exceeded", detail: "Slot limit reached." },
      },
    ]);
    const pin = toolsFor(["pin"], fetchFn).get("pin")!;

    const result = await pin.handler({ key: "extra", content: {} });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Slot limit reached");
    expect(eventsOf(result)).toEqual([]);
  });
});

describe("update_slot — conflicts are actionable, not errors", () => {
  it("is only registered when the agent selected it", () => {
    const { fetchFn } = stubFetch([{ json: {} }]);
    expect(toolsFor(["note"], fetchFn).has("update_slot")).toBe(false);
    expect(toolsFor(["note", "update_slot"], fetchFn).has("update_slot")).toBe(true);
  });

  it("returns the current value and asks the agent to rebase", async () => {
    const { fetchFn } = stubFetch([
      { json: { outcome: "conflict", revision: 7, current_content: { step: 3 } } },
    ]);
    const tool = toolsFor(["update_slot"], fetchFn).get("update_slot")!;

    const result = await tool.handler({
      key: "state",
      patch: { type: "merge", value: { step: 2 } },
      expected_revision: 5,
    });

    // NOT an error: flagging it would push the model to retry the same call
    // verbatim, which conflicts forever. The text must steer it to rebase.
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain("revision 7");
    expect(result.content[0]!.text).toContain('"step": 3');
    expect(result.content[0]!.text.toLowerCase()).toContain("re-apply");
    expect(eventsOf(result)).toEqual([]);
  });

  it("emits the value the platform stored, not the fragment sent", async () => {
    const { fetchFn, calls } = stubFetch([
      { json: { outcome: "committed", revision: 3, content: { cursor: 20, label: "kept" } } },
    ]);
    const tool = toolsFor(["update_slot"], fetchFn).get("update_slot")!;

    const result = await tool.handler({
      key: "state",
      patch: { type: "merge", value: { cursor: 20 } },
      expected_revision: 2,
    });

    expect(calls[0]!.url).toBe("http://sidecar/internal/slots/update");
    expect(calls[0]!.body).toMatchObject({ key: "state", expected_revision: 2 });
    // The merge was resolved server-side, so only the platform knows the
    // resulting value — echoing the patch would misreport the slot.
    expect(eventsOf(result)[0]).toMatchObject({
      type: "pinned.set",
      key: "state",
      content: { cursor: 20, label: "kept" },
      revision: 3,
    });
  });

  it("documents the conflict protocol in its description", () => {
    const { fetchFn } = stubFetch([{ json: {} }]);
    const tool = toolsFor(["update_slot"], fetchFn).get("update_slot")!;

    // `tools/list` is the agent's only documentation for this tool: if the
    // description omits the rebase step, the model has no way to recover.
    expect(tool.descriptor.description).toContain("expected_revision");
    expect(tool.descriptor.description).toContain("conflict");
  });
});
