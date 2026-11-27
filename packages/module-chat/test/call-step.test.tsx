// SPDX-License-Identifier: Apache-2.0

/**
 * A tool call's step line, as the thread and the context panel both draw it: rendered with no chat
 * host around it, everything from its props. And the count both say a set of calls with.
 */

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CallStep } from "../src/ui/call-step.tsx";
import { activityCounts } from "../src/ui/conversation-tools.ts";

const t = (key: string, params?: Record<string, string | number>) =>
  params?.count === undefined ? key : `${key}:${params.count}`;

function step(props: Partial<React.ComponentProps<typeof CallStep>> = {}) {
  return renderToStaticMarkup(
    <CallStep lead={<svg />} label="Lire" open={false} onOpenChange={() => {}} {...props}>
      <p>detail</p>
    </CallStep>,
  );
}

describe("CallStep", () => {
  it("draws its label and id in one trigger, folded until open", () => {
    const html = step({ idText: "getAgent" });
    expect(html).toContain('aria-expanded="false"');
    expect(html.indexOf("getAgent")).toBeGreaterThan(html.indexOf("Lire"));
    expect(html).not.toContain("shimmer-text");
    expect(html).not.toContain("detail");
  });

  it("holds its detail in a card once open", () => {
    const html = step({ open: true });
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("bg-card rounded-lg border p-3");
    expect(html).toContain("detail");
  });

  it("shimmers while the call runs, and draws what follows the trigger", () => {
    const html = step({ running: true, trailing: <span>1,2 s</span> });
    expect(html).toContain("shimmer-text");
    expect(html.indexOf("1,2 s")).toBeGreaterThan(html.indexOf("Lire"));
  });

  it("says a failure by its cross, named or beside its word, its message under the line", () => {
    const named = step({ failure: { label: "Échec" }, errorText: "boom" });
    expect(named).toContain('role="img" aria-label="Échec"');
    expect(named).toContain("boom");

    const visible = step({ failure: { label: "Échoué", visible: true } });
    expect(visible).not.toContain('role="img"');
    expect(visible).toContain(">Échoué</span>");
  });

  it("passes what the root is given to it (an anchor, a class)", () => {
    const html = step({ className: "rounded-sm", "data-tool-call-id": "call_1" } as never);
    expect(html).toContain('data-tool-call-id="call_1"');
    expect(html).toContain('class="rounded-sm"');
  });
});

describe("activityCounts", () => {
  it("counts lookups then actions, a zero part left out", () => {
    expect(activityCounts(t, { lookups: 3, actions: 1 })).toBe(
      "tool.reads.done:3 · tool.actions.done:1",
    );
    expect(activityCounts(t, { lookups: 0, actions: 2 })).toBe("tool.actions.done:2");
    expect(activityCounts(t, { lookups: 1, actions: 0 })).toBe("tool.reads.done:1");
    expect(activityCounts(t, { lookups: 0, actions: 0 })).toBe("");
  });
});
