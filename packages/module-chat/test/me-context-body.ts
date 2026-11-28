// SPDX-License-Identifier: Apache-2.0

/** A well-formed `/api/me/context` body for the space `rest.space` names, `rest` overriding its lists. */
export const meBody = (rest: Record<string, unknown>) => ({
  user: { id: "u_1", name: null, email: null },
  org: { id: "org_1", role: "admin", name: "Acme", slug: "acme" },
  connections: [],
  connectable_integrations: { data: [], truncated: false, total: 0 },
  recent_runs: [],
  agents: { data: [], truncated: false, total: 0 },
  skills: { data: [], truncated: false, total: 0 },
  ...rest,
  space: { name: "S", personal: false, ...(rest.space as object) },
});

/** An agent entry with every field the route lists. */
export const fullAgent = (packageId: string, display_name: string) => ({
  packageId,
  display_name,
  description: "",
  takes_input: false,
  inactive_required_integrations: [],
  published: true,
  home_writable: false,
  source: "local",
});
