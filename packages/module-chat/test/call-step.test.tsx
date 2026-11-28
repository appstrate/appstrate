// SPDX-License-Identifier: Apache-2.0

/**
 * A tool call's step line, as the thread and the context panel both draw it (`CallLine`), and the
 * panel's disclosure around it (`CallStep`): rendered with no chat host around it, everything from
 * its props. And the count both say a set of calls with.
 */

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CallLine, CallName, CallStep } from "../src/ui/call-step.tsx";
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

  it("says a failure by its cross, named by its label, its message under the line", () => {
    const html = step({ failure: { label: "Échec" }, errorText: "boom" });
    expect(html).toContain('role="img" aria-label="Échec"');
    expect(html).not.toContain(">Échec<");
    expect(html).toContain("boom");
  });

  it("passes what the root is given to it (an anchor, a class)", () => {
    const html = step({ className: "rounded-sm", "data-tool-call-id": "call_1" } as never);
    expect(html).toContain('data-tool-call-id="call_1"');
    expect(html).toContain('class="rounded-sm"');
  });
});

describe("CallLine", () => {
  it("draws the control it is given, what follows it, the cross, the message under the line", () => {
    const html = renderToStaticMarkup(
      <CallLine
        lead={<svg />}
        control={
          <button type="button">
            <CallName label="Lire" idText="getAgent" />
          </button>
        }
        trailing={<span>1,2 s</span>}
        failure={{ label: "Échec" }}
        errorText="boom"
      />,
    );
    expect(html).not.toContain("aria-expanded");
    expect(html.indexOf("getAgent")).toBeGreaterThan(html.indexOf("Lire"));
    expect(html.indexOf("1,2 s")).toBeGreaterThan(html.indexOf("</button>"));
    expect(html.indexOf('aria-label="Échec"')).toBeGreaterThan(html.indexOf("1,2 s"));
    expect(html).toMatch(/<p class="text-muted-foreground[^"]*pl-6[^"]*">boom<\/p>/);
  });

  it("draws no message line for a call that did not fail", () => {
    const html = renderToStaticMarkup(<CallLine lead={<svg />} control={<button />} />);
    expect(html).not.toContain("<p");
    expect(html).not.toContain("text-destructive");
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
