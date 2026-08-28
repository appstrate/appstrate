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
  { path: "/agents?create=agent", name: "agent-creation" },
  { path: "/skills", name: "skills" },
  { path: "/skills?create=skill", name: "skill-creation" },
  { path: "/mcp-servers", name: "mcp-servers" },
  { path: "/mcp-servers?create=mcp-server", name: "mcp-server-creation" },
  {
    path: "/skills/@tractr/compta-references",
    name: "skill-detail",
    expectedText: "compta-references",
    settleMs: 2500,
    via: { path: "/skills", text: "compta-references" },
  },
  {
    path: "/mcp-servers/@tractr/qbo-mcp",
    name: "mcp-server-detail",
    expectedText: "qbo-mcp",
    via: { path: "/mcp-servers", text: "qbo-mcp" },
  },
  { path: "/integrations", name: "integrations" },
  { path: "/integrations?create=integration", name: "integration-creation" },
  { path: "/integrations?catalogue=1", name: "integration-catalogue" },
  { path: "/integrations/@appstrate/google-drive", name: "integration-detail" },
  {
    path: "/integrations/@appstrate/google-drive#configuration",
    name: "integration-detail-config",
  },
  { path: "/documents", name: "documents" },
  // The two detail pages that host the compact lists: an agent's Connexions
  // and Mémoire tabs, and a run's Documents and Mémoire tabs. They are here
  // because the third body of a collection lives on them and nowhere else.
  {
    path: "/agents/@tractr/compta-trimestrielle#overview",
    name: "agent-overview",
    settleMs: 1500,
  },
  {
    path: "/agents/@default/wiki-brain#overview",
    name: "agent-overview-warning",
    settleMs: 1500,
  },
  {
    path: "/agents/@tractr/analyse-recurrence-articles-tastet#overview",
    name: "agent-overview-blocking",
    settleMs: 1500,
  },
  {
    path: "/agents/@tractr/compta-trimestrielle?agentSettings=map#settings",
    name: "agent-map",
  },
  {
    path: "/agents/@default/wiki-brain?agentSettings=map#settings",
    name: "agent-map-warning",
  },
  {
    path: "/agents/@tractr/analyse-recurrence-articles-tastet?agentSettings=map#settings",
    name: "agent-map-blocking",
  },
  { path: "/agents/@tractr/compta-trimestrielle#runs", name: "agent-runs" },
  { path: "/agents/@tractr/compta-trimestrielle#settings", name: "agent-configuration" },
  { path: "/agents/@tractr/compta-trimestrielle#memory", name: "agent-memory" },
  {
    path: "/agents/@tractr/compta-trimestrielle?agentSettings=files#settings",
    name: "agent-files",
  },
  {
    path: "/agents/@tractr/compta-trimestrielle/runs/run_01",
    name: "run-overview-active",
  },
  {
    path: "/agents/@tractr/compta-trimestrielle/runs/run_01#results",
    name: "run-results-active",
  },
  {
    path: "/agents/@tractr/compta-trimestrielle/runs/run_01#journal",
    name: "run-journal-search-open",
    steps: [{ type: "clickLabel", label: "Rechercher dans le journal…" }],
  },
  {
    path: "/agents/@tractr/compta-trimestrielle/runs/run_01#journal",
    name: "run-journal-filter-open",
    steps: [
      { type: "clickLabel", label: "Filtres du journal" },
      { type: "clickText", text: "Avertissement" },
    ],
  },
  {
    path: "/agents/@tractr/compta-trimestrielle/runs/run_01#journal",
    name: "run-journal-search-empty",
    steps: [
      { type: "clickLabel", label: "Rechercher dans le journal…" },
      {
        type: "fillTextbox",
        label: "Rechercher dans le journal…",
        value: "aucun-evenement-ne-correspond",
      },
    ],
  },
  {
    path: "/agents/@tractr/compta-trimestrielle/runs/run_01",
    name: "run-overview-turns-modal",
    settleMs: 1200,
    clickText: "Voir le détail par tour",
  },
  {
    path: "/agents/@tractr/compta-trimestrielle/runs/run_02#results",
    name: "run-results-success",
  },
  {
    path: "/agents/@tractr/compta-trimestrielle/runs/run_02",
    name: "run-overview-success",
  },
  {
    path: "/agents/@default/wiki-brain/runs/run_06",
    name: "run-overview-empty-input",
  },
  {
    path: "/agents/@tractr/compta-trimestrielle/runs/run_02#journal",
    name: "run-journal-success",
  },
  {
    path: "/agents/@tractr/rq-entreprise-communications/runs/run_03#journal",
    name: "run-journal-failed",
  },
  {
    path: "/agents/@tractr/analyse-recurrence-articles-tastet/runs/run_05#results",
    name: "run-results-cancelled-partial",
  },
  { path: "/agents/@inline/r-8f2c41/runs/run_07#results", name: "run-results-inline" },
  {
    path: "/agents/@default/wiki-brain/runs/run_06#journal",
    name: "run-journal-success-empty",
  },
  {
    path: "/agents/@tractr/compta-trimestrielle/runs/run_08#journal",
    name: "run-journal-failed-empty",
  },
  // The settings surfaces, which are routed modals over whatever page you were
  // on. Every one of them is a list, and step B is about what they draw while
  // that list is on its way.
  { path: "/org-settings/general", name: "settings-general" },
  { path: "/org-settings/members", name: "settings-members" },
  { path: "/org-settings/applications", name: "settings-applications" },
  { path: "/org-settings/library", name: "settings-library" },
  { path: "/org-settings/models", name: "settings-models" },
  { path: "/org-settings/proxies", name: "settings-proxies" },
  { path: "/org-settings/oauth", name: "settings-oauth" },
  { path: "/org-settings/cli-sessions", name: "settings-cli-sessions" },
  { path: "/org-settings/mcp-access", name: "settings-mcp-access" },
  { path: "/app-settings", name: "workspace-settings" },
  { path: "/workspace-settings/api-keys", name: "settings-api-keys" },
  { path: "/preferences/general", name: "preferences-general" },
  { path: "/preferences/appearance", name: "preferences-appearance" },
  { path: "/preferences/security", name: "preferences-security" },
  { path: "/preferences/devices", name: "preferences-devices" },
  { path: "/preferences/connections", name: "preferences-connections" },
  { path: "/webhooks", name: "webhooks" },
  { path: "/end-users", name: "end-users" },
  { path: "/workspace-settings/end-users?user=eu_lab_detail", name: "end-user-detail" },
  { path: "/workspace-settings/end-users?user=eu_lab_detail&edit=1", name: "end-user-edit" },
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
