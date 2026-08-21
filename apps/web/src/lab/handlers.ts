// SPDX-License-Identifier: Apache-2.0

/**
 * Route table for lab mode: `METHOD /api/…` → canned response.
 *
 * Adding a screen to the lab means adding rows here. When a screen calls an
 * endpoint that has no row, `mock-fetch` logs
 * `[lab] no fixture for GET /api/…` and returns a 404 — so the missing fixture
 * announces itself in the console instead of showing up as an empty panel you
 * mistake for a design decision.
 */
import type { Scenario } from "./scenario";
import * as f from "./fixtures";

export type LabResponse = {
  status: number;
  body: unknown;
  delayMs?: number;
  /** Server-sent events instead of JSON (the realtime channel). */
  stream?: boolean;
};

type Handler = (url: URL, scenario: Scenario, headers: Headers) => LabResponse;

/** `heavy` swaps the list bodies; `empty` empties them; `nominal` is as authored. */
function list<T>(rows: T[], scenario: Scenario, heavy?: T[]): T[] {
  if (scenario === "empty") return [];
  if (scenario === "heavy" && heavy) return heavy;
  return rows;
}

const ROUTES: Array<{ method: string; pattern: RegExp; handler: Handler }> = [
  /* Identity — the three reads main.tsx fires before React mounts. */
  {
    method: "GET",
    pattern: /^\/api\/auth\/get-session$/,
    handler: () => ({ status: 200, body: f.session, delayMs: 40 }),
  },
  { method: "GET", pattern: /^\/api\/profile$/, handler: () => ({ status: 200, body: f.profile }) },
  {
    method: "GET",
    pattern: /^\/api\/orgs$/,
    handler: (_u, s) => ({
      status: 200,
      body: { ...f.orgs, data: list(f.orgs.data, s) },
    }),
  },
  {
    method: "GET",
    pattern: /^\/api\/orgs\/[^/]+\/settings$/,
    handler: () => ({ status: 200, body: f.orgSettings }),
  },
  {
    method: "GET",
    pattern: /^\/api\/orgs\/[^/]+$/,
    handler: (_u, s) => ({
      status: 200,
      body: s === "empty" ? { ...f.orgDetail, members: [], invitations: [] } : f.orgDetail,
    }),
  },
  {
    method: "GET",
    pattern: /^\/api\/applications\/[^/]+$/,
    handler: () => ({ status: 200, body: f.applications.data[0] }),
  },
  {
    // Empty on purpose: the point in the lab is the settings shell and its
    // Developers section, not a list of secrets.
    method: "GET",
    pattern: /^\/api\/api-keys$/,
    handler: () => ({ status: 200, body: { object: "list", data: [], hasMore: false } }),
  },
  {
    method: "GET",
    pattern: /^\/api\/applications$/,
    // Answers for the org the request asks for, not the one the app is in: the
    // org switcher reads another org's workspaces before switching to it.
    handler: (_u, s, headers) => {
      const orgId = headers.get("X-Org-Id") ?? "";
      const rows = f.applicationsByOrg[orgId] ?? f.applications.data;
      return { status: 200, body: { ...f.applications, data: list(rows, s) } };
    },
  },

  /* Runs — paginated, so the offset/limit query has to be honoured or the
     list keeps asking for a page it already has. */
  {
    method: "GET",
    pattern: /^\/api\/runs$/,
    handler: (url, s) => {
      const all = list(f.runs, s, f.heavyRuns);
      const status = url.searchParams.get("status");
      const filtered = status ? all.filter((r) => r.status === status) : all;
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 15);
      const page = filtered.slice(offset, offset + limit);
      return {
        status: 200,
        body: {
          object: "list" as const,
          data: page,
          total: filtered.length,
          hasMore: offset + page.length < filtered.length,
        },
      };
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/agents$/,
    handler: (_u, s) => ({ status: 200, body: { ...f.agents, data: list(f.agents.data, s) } }),
  },
  {
    method: "GET",
    pattern: /^\/api\/schedules$/,
    handler: (_u, s) => ({
      status: 200,
      body: { ...f.schedules, data: list(f.schedules.data, s) },
    }),
  },
  {
    method: "GET",
    pattern: /^\/api\/chat\/sessions$/,
    handler: (_u, s) => ({
      status: 200,
      body: { ...f.chatSessions, data: list(f.chatSessions.data, s, f.heavyChatSessions) },
    }),
  },

  {
    // The resume probe every conversation fires on mount. 204 is the real
    // server's "nothing is generating" — without it the probe 404s and a
    // brand-new conversation opens on a generation error instead of its
    // welcome screen.
    method: "GET",
    pattern: /^\/api\/chat\/sessions\/[^/]+\/stream$/,
    handler: () => ({ status: 204, body: null }),
  },
  {
    method: "GET",
    pattern: /^\/api\/chat\/sessions\/[^/]+$/,
    handler: (_u, s) => ({
      status: 200,
      body: { messages: list(f.chatHistory.messages, s) },
    }),
  },

  /* Notification badges — small, but they drive visible chrome (the bell, the
     per-agent dots), so a 404 here changes what the design looks like. */
  {
    method: "GET",
    pattern: /^\/api\/notifications$/,
    handler: (_u, s) => ({
      status: 200,
      body: { ...f.notifications, data: list(f.notifications.data, s) },
    }),
  },
  {
    method: "GET",
    pattern: /^\/api\/notifications\/unread-count$/,
    handler: (_u, s) => ({ status: 200, body: { count: s === "empty" ? 0 : 3 } }),
  },
  {
    method: "GET",
    pattern: /^\/api\/notifications\/unread-counts-by-agent$/,
    handler: (_u, s) => ({
      status: 200,
      body: { counts: s === "empty" ? {} : { "@tractr/compta-trimestrielle": 3 } },
    }),
  },
  {
    method: "POST",
    pattern: /^\/api\/notifications\/read-all$/,
    handler: () => ({ status: 200, body: {} }),
  },

  { method: "GET", pattern: /^\/api\/billing$/, handler: () => ({ status: 200, body: f.billing }) },

  /* Live run channel. Answered with an open, silent event-stream: closing it
     or 404-ing sends the client into a reconnect loop that floods the console
     and makes the lab unusable. */
  {
    method: "GET",
    pattern: /^\/api\/realtime\/runs$/,
    handler: () => ({ status: 200, body: null, stream: true }),
  },
];

/**
 * What keeps answering under the `error` scenario: who you are, and which org
 * and workspace you are in.
 *
 * Failing these too was failing the wrong thing. A 500 on the session logs you
 * straight out, so the scenario meant to show what a broken screen looks like
 * never got past the login form — no list ever rendered its error state. The
 * failure a user actually meets is one request breaking under a shell that
 * still stands, which is what this list leaves standing.
 */
const ERROR_SCENARIO_SURVIVORS = [
  /^\/api\/auth\//,
  /^\/api\/profile$/,
  /^\/api\/orgs$/,
  /^\/api\/applications$/,
];

export function resolveHandler(
  method: string,
  url: URL,
  scenario: Scenario,
  headers: Headers = new Headers(),
): LabResponse | null {
  const route = ROUTES.find((r) => r.method === method && r.pattern.test(url.pathname));
  if (!route) return null;
  const response = route.handler(url, scenario, headers);
  // The realtime stream stays up in every scenario — a dead channel is not the
  // failure mode `error` is meant to exercise.
  const survives = ERROR_SCENARIO_SURVIVORS.some((p) => p.test(url.pathname));
  if (scenario === "error" && !response.stream && !survives) {
    return {
      status: 500,
      body: {
        type: "about:blank",
        title: "Lab : panne simulée",
        status: 500,
        detail: "Scénario « Erreur » — chaque endpoint échoue volontairement.",
      },
    };
  }
  return response;
}
