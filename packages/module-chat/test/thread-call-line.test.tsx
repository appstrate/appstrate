// SPDX-License-Identifier: Apache-2.0

/**
 * A call's line in the thread opens the call in the host's context panel: the one host entry point
 * (`openThreadItem`) the run card opens its run through too. The line is rendered as a function, so
 * its control's click handler is reached without a DOM.
 */

import { describe, expect, it } from "bun:test";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatHostProvider, type ThreadItem } from "../src/ui/runtime-context.ts";
import { ThreadCallLine } from "../src/ui/tool-uis.tsx";
import { testHost } from "./test-host.ts";

/** The first element under `node`, through every prop, that has an `onClick`. */
function clickable(node: ReactNode): ReactElement<{ onClick: () => void }> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = clickable(child as ReactNode);
      if (hit) return hit;
    }
    return undefined;
  }
  if (!isValidElement<Record<string, unknown>>(node)) return undefined;
  if (typeof node.props.onClick === "function") {
    return node as ReactElement<{ onClick: () => void }>;
  }
  for (const value of Object.values(node.props)) {
    const hit = clickable(value as ReactNode);
    if (hit) return hit;
  }
  return undefined;
}

function clickLine(running: boolean): ThreadItem[] {
  const opened: ThreadItem[] = [];
  function Probe() {
    const tree = ThreadCallLine({
      call: running
        ? { toolCallId: "call_1", status: { type: "running" } }
        : { toolCallId: "call_1", result: { agents: [] } },
      lead: null,
      label: "Lire",
      running,
    });
    clickable(tree)?.props.onClick();
    return null;
  }
  renderToStaticMarkup(
    <ChatHostProvider value={testHost({ openThreadItem: (item) => opened.push(item) })}>
      <Probe />
    </ChatHostProvider>,
  );
  return opened;
}

describe("a call's line in the thread", () => {
  it("opens its call in the context panel on a click", () => {
    expect(clickLine(false)).toEqual([{ kind: "call", id: "call_1" }]);
  });

  it("opens it the same while the call still runs", () => {
    expect(clickLine(true)).toEqual([{ kind: "call", id: "call_1" }]);
  });

  it("is no disclosure, and anchors the panel's reveal on itself", () => {
    const html = renderToStaticMarkup(
      <ChatHostProvider value={testHost()}>
        <ThreadCallLine
          call={{ toolCallId: "call_1", result: { status: 404, error: "Agent introuvable" } }}
          lead={null}
          label="Lire"
          running={false}
        />
      </ChatHostProvider>,
    );
    expect(html).not.toContain("aria-expanded");
    expect(html).toContain('data-tool-call-id="call_1"');
    expect(html).toContain('aria-label="tool.failedHttp"');
    expect(html).toContain("Agent introuvable");
  });
});
