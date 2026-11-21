// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import type { AgentListIntegration, AgentListItem } from "@appstrate/shared-types";
import { agentCardItem } from "../package-card-item.ts";

const integration = (id: string, authenticated: boolean): AgentListIntegration => ({
  id,
  name: id,
  icon: null,
  required: false,
  authenticated,
});

const agent = (integrations: AgentListIntegration[]): AgentListItem => ({
  id: "@acme/agent",
  space_ids: ["spc_a"],
  home_space_id: "spc_a",
  icon: null,
  color: null,
  keywords: [],
  dependencies: { integrations: {} },
  integrations,
  running_runs: 0,
  unread_count: 0,
  published: true,
  type: "agent",
  scope: "@acme",
  source: "local",
  version: "1.0.0",
});

describe("agentCardItem", () => {
  it("stacks only the integrations that take a connection", () => {
    const item = agentCardItem(
      agent([integration("@appstrate/platform", false), integration("@appstrate/gmail", true)]),
    );
    expect(item.integrations?.map((i) => i.id)).toEqual(["@appstrate/gmail"]);
  });

  it("carries the required integrations not active in the space, which refuse the launch", () => {
    const item = agentCardItem({
      ...agent([integration("@appstrate/gmail", true)]),
      inactive_required_integrations: ["@appstrate/gmail"],
    });
    expect(item.inactiveIntegrations).toEqual(["@appstrate/gmail"]);
  });
});
