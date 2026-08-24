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
  /**
   * Answer with BYTES under this content type instead of JSON. Only the
   * document content route needs it: a thumbnail is fetched as a blob and
   * turned into an object URL, so JSON cannot stand in for it — the tile falls
   * back to a placeholder and the gallery is a wall of grey squares.
   */
  contentType?: string;
};

type Handler = (url: URL, scenario: Scenario, headers: Headers, body: unknown) => LabResponse;

type LabEndUser = f.Json200<"/api/end-users/{id}", "get">;
type EndUserPatch = f.JsonRequest<"/api/end-users/{id}", "patch">;

const changedEndUsers = new Map<string, LabEndUser>();
const deletedEndUsers = new Set<string>();

export function resetEndUserLabState(): void {
  changedEndUsers.clear();
  deletedEndUsers.clear();
}

function endUserFixture(id: string): LabEndUser | null {
  if (deletedEndUsers.has(id)) return null;
  return (
    changedEndUsers.get(id) ??
    f.endUsers.data.find((candidate) => candidate.id === id) ??
    (f.endUserDetail.id === id ? f.endUserDetail : null)
  );
}

function endUserId(url: URL): string {
  const parts = url.pathname.split("/");
  return decodeURIComponent(parts[parts.length - 1] ?? "");
}

function typedPackageId(url: URL): string {
  const parts = url.pathname.split("/").filter(Boolean);
  return `${decodeURIComponent(parts[3] ?? "")}/${decodeURIComponent(parts[4] ?? "")}`;
}

function genericPackageId(url: URL): string {
  const parts = url.pathname.split("/").filter(Boolean);
  return `${decodeURIComponent(parts[2] ?? "")}/${decodeURIComponent(parts[3] ?? "")}`;
}

function isPermanentPackageDetail(headers: Headers): boolean {
  const location = headers.get("X-Appstrate-Lab-Location") ?? "";
  return /^\/(skills|mcp-servers)\/[^/]+\/[^/]+(?:\/|$)/.test(location);
}

function isEndUserPatch(body: unknown): body is EndUserPatch {
  return typeof body === "object" && body !== null && !Array.isArray(body);
}

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
    handler: (_u, s, headers) => ({
      status: 200,
      body: {
        ...f.orgs,
        data: isPermanentPackageDetail(headers) ? f.orgs.data : list(f.orgs.data, s),
      },
    }),
  },
  {
    method: "GET",
    pattern: /^\/api\/library$/,
    handler: () => ({ status: 200, body: f.library }),
  },
  {
    method: "GET",
    pattern: /^\/api\/models$/,
    handler: (_u, s) => ({ status: 200, body: { ...f.models, data: list(f.models.data, s) } }),
  },
  {
    method: "GET",
    pattern: /^\/api\/model-provider-credentials\/registry$/,
    handler: () => ({ status: 200, body: f.providerRegistry }),
  },
  {
    method: "GET",
    pattern: /^\/api\/model-provider-credentials$/,
    handler: (_u, s) => ({
      status: 200,
      body: { ...f.modelCredentials, data: list(f.modelCredentials.data, s) },
    }),
  },
  {
    method: "GET",
    pattern: /^\/api\/proxies$/,
    handler: (_u, s) => ({
      status: 200,
      body: { ...f.proxies, data: list(f.proxies.data, s) },
    }),
  },
  {
    method: "POST",
    pattern: /^\/api\/models\/[^/]+\/test$/,
    handler: () => ({ status: 200, body: f.connectionTest, delayMs: 800 }),
  },
  {
    method: "POST",
    pattern: /^\/api\/model-provider-credentials\/[^/]+\/test$/,
    handler: () => ({ status: 200, body: f.connectionTest, delayMs: 800 }),
  },
  {
    method: "POST",
    pattern: /^\/api\/proxies\/[^/]+\/test$/,
    handler: () => ({ status: 200, body: f.connectionTest, delayMs: 800 }),
  },
  {
    // The catalogue the integrations page holds whole and filters client-side.
    method: "GET",
    pattern: /^\/api\/integrations$/,
    handler: (_u, s) => ({
      status: 200,
      body: { ...f.integrations, data: list(f.integrations.data, s, f.heavyIntegrations) },
    }),
  },
  {
    // The integration detail — one package, its auths, and the accounts
    // connected to each. The clients of an auth come from their own endpoint
    // below; everything else on the screen is in this one body.
    method: "GET",
    pattern: /^\/api\/integrations\/[^/]+\/[^/]+$/,
    handler: (_u, s) => ({
      status: 200,
      body: {
        ...f.integrationDetail,
        auths: f.integrationDetail.auths.map((a) =>
          a.auth_key === f.INTEGRATION_AUTH_KEY
            ? { ...a, connections: list(a.connections, s, f.heavyIntegrationConnections) }
            : a,
        ),
      },
    }),
  },
  {
    method: "GET",
    pattern: /^\/api\/integrations\/[^/]+\/[^/]+\/auths\/[^/]+\/clients$/,
    // Per auth, like the endpoint: only the oauth2 one has clients, and the
    // other auth showing an empty table rather than someone else's rows is
    // half of what the second auth is in the fixture for.
    handler: (url, s) => {
      const authKey = /\/auths\/([^/]+)\/clients$/.exec(url.pathname)?.[1] ?? "";
      const rows = authKey === f.INTEGRATION_AUTH_KEY ? f.integrationClients.data : [];
      return { status: 200, body: { ...f.integrationClients, data: list(rows, s) } };
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/integrations\/[^/]+\/[^/]+\/connections$/,
    handler: (_u, s) => ({
      status: 200,
      body: {
        object: "list" as const,
        hasMore: false,
        data: list(
          f.integrationDetail.auths.find((a) => a.auth_key === f.INTEGRATION_AUTH_KEY)!.connections,
          s,
          f.heavyIntegrationConnections,
        ),
      },
    }),
  },
  {
    method: "GET",
    pattern: /^\/api\/integrations\/[^/]+\/[^/]+\/consuming-agents$/,
    handler: (_u, s) => ({
      status: 200,
      body: { ...f.integrationConsumingAgents, data: list(f.integrationConsumingAgents.data, s) },
    }),
  },
  {
    method: "GET",
    pattern: /^\/api\/integrations\/[^/]+\/[^/]+\/pins$/,
    handler: () => ({ status: 200, body: { object: "list" as const, hasMore: false, data: [] } }),
  },
  {
    // 204 is the real server's "no org default is set", and the section reads
    // it as such — a 404 there would look like a broken endpoint instead.
    method: "GET",
    pattern: /^\/api\/integrations\/[^/]+\/[^/]+\/default$/,
    handler: () => ({ status: 204, body: null }),
  },
  {
    method: "GET",
    pattern: /^\/api\/packages\/integrations\/[^/]+\/[^/]+$/,
    handler: () => ({ status: 200, body: f.integrationPackage }),
  },
  {
    method: "GET",
    pattern: /^\/api\/orgs\/[^/]+\/settings$/,
    handler: () => ({ status: 200, body: f.orgSettings }),
  },
  {
    method: "GET",
    pattern: /^\/api\/oauth\/clients$/,
    handler: (_u, s) => ({
      status: 200,
      body: { ...f.oauthClients, data: list(f.oauthClients.data, s) },
    }),
  },
  {
    method: "GET",
    pattern: /^\/api\/oauth\/scopes$/,
    handler: () => ({ status: 200, body: f.oauthScopes }),
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
    pattern: /^\/api\/api-keys\/available-scopes$/,
    handler: () => ({ status: 200, body: f.availableApiKeyScopes }),
  },
  {
    method: "GET",
    pattern: /^\/api\/applications$/,
    // Answers for the org the request asks for, not the one the app is in: the
    // org switcher reads another org's workspaces before switching to it.
    handler: (_u, s, headers) => {
      const orgId = headers.get("X-Org-Id") ?? "";
      const rows = f.applicationsByOrg[orgId] ?? f.applications.data;
      return {
        status: 200,
        body: {
          ...f.applications,
          data: isPermanentPackageDetail(headers) ? rows : list(rows, s),
        },
      };
    },
  },

  /* Runs — paginated, so the offset/limit query has to be honoured or the
     list keeps asking for a page it already has. */
  {
    method: "GET",
    pattern: /^\/api\/runs$/,
    handler: (url, s) => {
      const all = list(f.runs, s, f.heavyRuns);
      // The three filters the toolbar sets, applied the way the API applies
      // them — together. `user=me` is "mine OR nobody's" for a member, which
      // is what `actorScopeFilter` means server-side.
      // `?status=failed,timeout` — several at once, like the endpoint.
      const statuses = (url.searchParams.get("status") ?? "").split(",").filter(Boolean);
      const kind = url.searchParams.get("kind");
      const mine = url.searchParams.get("user") === "me";
      // `?q=` — the agent, the error, the number, like the endpoint.
      const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
      const filtered = all.filter((r) => {
        if (q) {
          const number = q.replace(/^#/, "");
          const hit =
            (r.agent_name ?? "").toLowerCase().includes(q) ||
            (r.agent_scope ?? "").toLowerCase().includes(q) ||
            (r.error ?? "").toLowerCase().includes(q) ||
            (/^\d+$/.test(number) && r.runNumber === Number(number));
          if (!hit) return false;
        }
        if (statuses.length > 0 && !statuses.includes(r.status)) return false;
        if (kind === "inline" && r.package_ephemeral !== true) return false;
        if (kind === "package" && r.package_ephemeral === true) return false;
        if (mine && r.userId != null && r.userId !== f.USER_ID) return false;
        return true;
      });
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
    handler: (_u, s) => ({
      status: 200,
      body: { ...f.agents, data: list(f.agents.data, s, f.heavyAgents) },
    }),
  },
  {
    method: "GET",
    pattern: /^\/api\/packages\/skills$/,
    handler: (_u, s) => ({ status: 200, body: { ...f.skills, data: list(f.skills.data, s) } }),
  },
  {
    method: "GET",
    pattern: /^\/api\/packages\/skills\/[^/]+\/[^/]+$/,
    handler: (url) => {
      const detail = f.skillDetails.find((candidate) => candidate.id === typedPackageId(url));
      return detail ? { status: 200, body: detail } : { status: 404, body: {} };
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/packages\/skills\/[^/]+\/[^/]+\/versions\/info$/,
    handler: (url) => {
      const info = f.skillVersionInfoById[typedPackageId(url)];
      return info ? { status: 200, body: info } : { status: 404, body: {} };
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/packages\/skills\/[^/]+\/[^/]+\/versions\/[^/]+$/,
    handler: (url) =>
      typedPackageId(url) === f.wikiBrainSkillDetail.id
        ? { status: 200, body: f.wikiBrainLatestVersion }
        : { status: 404, body: {} },
  },
  {
    method: "GET",
    pattern: /^\/api\/packages\/mcp-servers$/,
    handler: (_u, s) => ({
      status: 200,
      body: { ...f.mcpServers, data: list(f.mcpServers.data, s) },
    }),
  },
  {
    method: "GET",
    pattern: /^\/api\/packages\/mcp-servers\/[^/]+\/[^/]+$/,
    handler: (url) => {
      const detail = f.mcpServerDetails.find((candidate) => candidate.id === typedPackageId(url));
      return detail ? { status: 200, body: detail } : { status: 404, body: {} };
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/packages\/mcp-servers\/[^/]+\/[^/]+\/versions\/info$/,
    handler: (url) => {
      const info = f.mcpServerVersionInfoById[typedPackageId(url)];
      return info ? { status: 200, body: info } : { status: 404, body: {} };
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/packages\/mcp-servers\/[^/]+\/[^/]+\/versions\/[^/]+$/,
    handler: (url) =>
      typedPackageId(url) === f.qboMcpServerDetail.id
        ? { status: 200, body: f.qboMcpServerLatestVersion }
        : { status: 404, body: {} },
  },
  {
    method: "GET",
    pattern: /^\/api\/packages\/[^/]+\/[^/]+\/files$/,
    handler: (url) => {
      const files = f.packageFileIndexes[genericPackageId(url)];
      return files ? { status: 200, body: files } : { status: 404, body: {} };
    },
  },
  {
    // The gallery pages with `limit` + an accumulator on the caller's side, so
    // the handler has to honour the query or "load more" asks forever.
    method: "GET",
    pattern: /^\/api\/documents$/,
    handler: (url, s) => {
      const all = list(f.documents.data, s, f.heavyDocuments);
      const purpose = url.searchParams.get("purpose");
      const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
      const filtered = all.filter((document) => {
        if (purpose && document.purpose !== purpose) return false;
        return !q || document.name.toLowerCase().includes(q);
      });
      const limit = Number(url.searchParams.get("limit") ?? 25);
      const cursor = url.searchParams.get("startingAfter");
      const cursorIndex = cursor ? filtered.findIndex((document) => document.id === cursor) : -1;
      const offset = cursorIndex >= 0 ? cursorIndex + 1 : 0;
      const page = filtered.slice(offset, offset + limit);
      return {
        status: 200,
        body: {
          object: "list" as const,
          data: page,
          hasMore: offset + page.length < filtered.length,
          limit,
        },
      };
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/documents\/[^/]+\/content$/,
    handler: (url) => {
      const id = /\/documents\/([^/]+)\/content$/.exec(url.pathname)?.[1] ?? "";
      const row = [...f.documents.data, ...f.heavyDocuments].find((d) => d.id === id);
      // The real route echoes the stored mime and refuses a row the caller may
      // not download; both matter here, since that is what the tile branches on.
      if (!row || !row.capabilities.download) return { status: 403, body: {} };
      if (!row.mime.startsWith("image/")) return { status: 200, body: {} };
      return { status: 200, body: f.thumbnailPng(), contentType: row.mime };
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/packages\/agents\/[^/]+\/[^/]+$/,
    handler: () => ({ status: 200, body: f.agentDetail }),
  },
  {
    // Served out of the same array the run LIST answers from, so a run cannot
    // say one thing in the table and another on its own page.
    method: "GET",
    pattern: /^\/api\/runs\/[^/]+$/,
    handler: (url) => {
      const id = url.pathname.split("/").pop() ?? "";
      const run = [...f.runs, ...f.heavyRuns].find((r) => r.id === id);
      return run ? { status: 200, body: run } : { status: 404, body: {} };
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/runs\/[^/]+\/logs$/,
    handler: (_u, s) => ({ status: 200, body: { ...f.runLogs, data: list(f.runLogs.data, s) } }),
  },
  {
    // `?kind=pinned` and `?kind=memory` are two calls against one endpoint, and
    // the panel fires both. Answering the whole body to each would show the
    // archive under the pinned heading.
    method: "GET",
    pattern: /^\/api\/agents\/[^/]+\/[^/]+\/persistence$/,
    handler: (url, s) => {
      const kind = url.searchParams.get("kind");
      const pinned = list(f.agentPersistence.pinned ?? [], s);
      const memories = list(f.agentPersistence.memories ?? [], s);
      if (kind === "pinned") return { status: 200, body: { pinned } };
      if (kind === "memory") return { status: 200, body: { memories } };
      return { status: 200, body: { pinned, memories } };
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/agents\/[^/]+\/[^/]+\/connection-readiness$/,
    handler: () => ({ status: 200, body: f.agentConnectionReadiness }),
  },
  {
    method: "GET",
    pattern: /^\/api\/agents\/[^/]+\/[^/]+\/model$/,
    handler: () => ({ status: 200, body: f.agentModel }),
  },
  {
    method: "GET",
    pattern: /^\/api\/agents\/[^/]+\/[^/]+\/runs$/,
    handler: (url, s) => {
      const all = list(f.runs, s, f.heavyRuns);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 12);
      const page = all.slice(offset, offset + limit);
      return {
        status: 200,
        body: {
          object: "list" as const,
          data: page,
          total: all.length,
          hasMore: offset + page.length < all.length,
        },
      };
    },
  },
  {
    // The version selector asks for both on mount, and they are two different
    // shapes: `info` is the pair of version STRINGS, `latest` is a version
    // resolved through `/versions/{version}`.
    method: "GET",
    pattern: /^\/api\/packages\/agents\/[^/]+\/[^/]+\/versions\/info$/,
    handler: () => ({ status: 200, body: f.agentVersionInfo }),
  },
  {
    method: "GET",
    pattern: /^\/api\/packages\/agents\/[^/]+\/[^/]+\/versions\/[^/]+$/,
    handler: () => ({ status: 200, body: f.agentLatestVersion }),
  },
  {
    method: "GET",
    pattern: /^\/api\/webhooks$/,
    handler: (_u, s) => ({ status: 200, body: { ...f.webhooks, data: list(f.webhooks.data, s) } }),
  },
  {
    method: "GET",
    pattern: /^\/api\/end-users$/,
    handler: (_u, s) => ({
      status: 200,
      body: {
        ...f.endUsers,
        data: list(f.endUsers.data, s)
          .filter((user) => !deletedEndUsers.has(user.id))
          .map((user) => changedEndUsers.get(user.id) ?? user),
      },
    }),
  },
  {
    method: "GET",
    pattern: /^\/api\/end-users\/[^/]+$/,
    handler: (u) => {
      const user = endUserFixture(endUserId(u));
      if (!user) {
        return {
          status: 404,
          body: { type: "about:blank", title: "Not found", status: 404 },
        };
      }
      return {
        status: 200,
        body: user,
      };
    },
  },
  {
    method: "PATCH",
    pattern: /^\/api\/end-users\/[^/]+$/,
    handler: (u, scenario, _headers, body) => {
      const user = endUserFixture(endUserId(u));
      if (!user) return { status: 404, body: null, delayMs: 800 };
      if (scenario === "error" || !isEndUserPatch(body)) {
        return { status: 200, body: user, delayMs: 800 };
      }
      const updated = {
        ...user,
        ...body,
        updatedAt: new Date().toISOString(),
      } satisfies LabEndUser;
      changedEndUsers.set(user.id, updated);
      return { status: 200, body: updated, delayMs: 800 };
    },
  },
  {
    method: "DELETE",
    pattern: /^\/api\/end-users\/[^/]+$/,
    handler: (u, scenario) => {
      const id = endUserId(u);
      if (!endUserFixture(id)) return { status: 404, body: null, delayMs: 800 };
      if (scenario !== "error") {
        deletedEndUsers.add(id);
        changedEndUsers.delete(id);
      }
      return { status: 204, body: null, delayMs: 800 };
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/orgs\/[^/]+\/cli-sessions$/,
    handler: (_u, s) => ({
      status: 200,
      body: { ...f.cliSessions, data: list(f.cliSessions.data, s) },
    }),
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
  // The same reasoning, one level in: on a DETAIL page the resource the page is
  // ABOUT survives, and everything hanging off it fails. Without this the page
  // itself 500s and you get its page-level error, so no panel on it ever draws
  // its own — the memory panel's failure state was unreachable in the very
  // scenario that exists to show failure. Now the shell stands, the header
  // stands, and each tab shows what broke inside it.
  /^\/api\/packages\/(agents|skills|mcp-servers|integrations)\/[^/]+\/[^/]+$/,
  /^\/api\/integrations\/[^/]+\/[^/]+$/,
];

export function resolveHandler(
  method: string,
  url: URL,
  scenario: Scenario,
  headers: Headers = new Headers(),
  body?: unknown,
): LabResponse | null {
  const route = ROUTES.find((r) => r.method === method && r.pattern.test(url.pathname));
  if (!route) return null;
  const response = route.handler(url, scenario, headers, body);
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
