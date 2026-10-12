// SPDX-License-Identifier: Apache-2.0

/**
 * A connection pick leaves the overrides panel as `(integration, set)`, never as a whole value
 * built from the render's snapshot: a picker writes once its connect popup settles, minutes
 * after that render, and a value built then would revert every change made meanwhile.
 *
 * No DOM: a probe runs the panel's hooks during a static render and keeps its element tree.
 */

import { describe, expect, it } from "bun:test";
import { isValidElement, type ReactNode } from "react";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { render } = await import("../../test/render.tsx");
const { RunOverridesPanel } = await import("../run-overrides-panel.tsx");

type PanelProps = Parameters<typeof RunOverridesPanel>[0];
type PickHandler = PanelProps["onConnectionPick"];

/** The handler the panel hands its connection section, found in the panel's element tree. */
function sectionHandler(node: ReactNode): PickHandler | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = sectionHandler(child);
      if (found) return found;
    }
    return undefined;
  }
  if (!isValidElement<Record<string, unknown>>(node)) return undefined;
  if ("integrations" in node.props) return node.props.onChange as PickHandler;
  return sectionHandler(node.props.children as ReactNode);
}

describe("RunOverridesPanel — a connection pick", () => {
  it("goes out as (integration, set), not as a value built from the render's snapshot", () => {
    const values: unknown[] = [];
    const picks: unknown[] = [];
    const trees: ReactNode[] = [];
    function Probe() {
      trees.push(
        RunOverridesPanel({
          packageId: "@acme/mailer",
          persistedModelId: null,
          persistedGenerationConfig: null,
          persistedProxyId: null,
          agentIntegrations: [{ id: "@acme/gmail" }],
          value: { model_id_override: "m1" },
          onChange: (next) => values.push(next),
          onConnectionPick: (integrationId, connectionIds) =>
            picks.push([integrationId, connectionIds]),
          version: "draft",
        }),
      );
      return null;
    }
    render(<Probe />);

    const pick = sectionHandler(trees[0]);
    if (!pick) throw new Error("the panel should render its connection section");
    pick("@acme/gmail", ["conn_1"]);
    pick("@acme/gmail", null);

    expect(picks).toEqual([
      ["@acme/gmail", ["conn_1"]],
      ["@acme/gmail", null],
    ]);
    expect(values).toEqual([]);
  });
});
