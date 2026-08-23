// SPDX-License-Identifier: Apache-2.0

/**
 * The screens the lab is expected to be able to draw.
 *
 * This is a COVERAGE STATEMENT, not a mirror of the API. The distinction
 * matters, because a hand-maintained list of API endpoints is exactly the thing
 * that drifts and lies: it would have to be updated every time a hook changed,
 * and nothing would notice when it was not. A list of SCREENS is a product
 * claim ("these are lookable in the lab") that a human makes on purpose, and
 * the endpoints each one needs are discovered at RUNTIME by watching what the
 * browser actually fetches — see `shots.mjs`.
 *
 * Add a row when a screen becomes worth looking at. Deleting a row is a
 * decision to stop covering it, which is a different thing from forgetting.
 */

/** Paths with a parameter take a real id out of `apps/web/src/lab/fixtures.ts`. */
export const SCREENS = [
  { path: "/", name: "dashboard" },
  { path: "/runs", name: "runs" },
  { path: "/schedules", name: "schedules" },
  { path: "/agents", name: "agents" },
  { path: "/skills", name: "skills" },
  { path: "/mcp-servers", name: "mcp-servers" },
  { path: "/integrations", name: "integrations" },
  { path: "/integrations/@appstrate/google-drive", name: "integration-detail" },
  {
    path: "/integrations/@appstrate/google-drive#configuration",
    name: "integration-detail-config",
  },
  { path: "/documents", name: "documents" },
  { path: "/library", name: "library" },
  // The two detail pages that host the compact lists: an agent's Connexions
  // and Mémoire tabs, and a run's Documents and Mémoire tabs. They are here
  // because the third body of a collection lives on them and nowhere else.
  { path: "/agents/@tractr/compta-trimestrielle", name: "agent-detail" },
  { path: "/agents/@tractr/compta-trimestrielle#connections", name: "agent-connections" },
  { path: "/agents/@tractr/compta-trimestrielle#memory", name: "agent-memory" },
  { path: "/agents/@tractr/compta-trimestrielle/runs/run_01", name: "run-detail" },
  { path: "/agents/@tractr/compta-trimestrielle/runs/run_01#memory", name: "run-memory" },
  // The settings surfaces, which are routed modals over whatever page you were
  // on. Every one of them is a list, and step B is about what they draw while
  // that list is on its way.
  { path: "/org-settings/general", name: "settings-general" },
  { path: "/org-settings/members", name: "settings-members" },
  { path: "/org-settings/applications", name: "settings-applications" },
  { path: "/org-settings/models", name: "settings-models" },
  { path: "/org-settings/proxies", name: "settings-proxies" },
  { path: "/org-settings/oauth", name: "settings-oauth" },
  { path: "/org-settings/cli-sessions", name: "settings-cli-sessions" },
  { path: "/app-settings", name: "workspace-settings" },
  { path: "/workspace-settings/api-keys", name: "settings-api-keys" },
  { path: "/preferences", name: "preferences" },
  { path: "/webhooks", name: "webhooks" },
  { path: "/end-users", name: "end-users" },
];

/** The four the scenario switcher offers. `empty` lands on onboarding by design. */
export const SCENARIOS = ["nominal", "empty", "heavy", "error"];

export function parseList(value, fallback) {
  if (!value) return fallback;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Screens named by `LAB_SCREENS`, or all of them. */
export function selectScreens(spec) {
  if (!spec) return SCREENS;
  const wanted = parseList(spec, []);
  return SCREENS.filter((s) => wanted.includes(s.name) || wanted.includes(s.path));
}
