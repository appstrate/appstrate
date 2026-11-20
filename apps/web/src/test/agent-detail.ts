// SPDX-License-Identifier: Apache-2.0

import type { AgentDetail } from "@appstrate/shared-types";

/** Published agent placed in Studio and Coffre, read from Atelier by default. */
export function reporter(over: Partial<AgentDetail> = {}): AgentDetail {
  return {
    id: "@acme/reporter",
    icon: null,
    color: null,
    source: "local",
    display_name: "Rapporteur",
    dependencies: { skills: [], integrations: [] },
    input: { schema: { type: "object", properties: {} }, values: {}, locked_fields: [] },
    running_runs: 0,
    last_run: null,
    prompt: "Rapporte.",
    manifest: { name: "@acme/reporter" },
    scope: "@acme",
    version: "1.0.0",
    version_count: 1,
    definition: "published",
    home_space_id: "spc_b",
    home_writable: false,
    home_deletable: false,
    home_shareable: false,
    effective_timeout_seconds: 300,
    active: false,
    space_ids: ["spc_b", "spc_c"],
    read_space_ids: ["spc_b", "spc_c"],
    ...over,
  };
}
