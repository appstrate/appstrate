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
import type { PackageType } from "@appstrate/core/validation";
import type { Scenario } from "./scenario";
import * as f from "./fixtures";
import { getRole } from "./role";
import { projectDraftFiles } from "../lib/package-file-drafts";
import type { PackageFileEntry, PackageFileWriteOperation } from "../lib/package-file-tree";

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
  /** Response headers — the `ETag` a package detail and its save carry. */
  headers?: Record<string, string>;
};

type Handler = (url: URL, scenario: Scenario, headers: Headers, body: unknown) => LabResponse;

function labFile(id: string | undefined) {
  return [...f.documents.data, ...f.heavyDocuments].find((file) => file.id === id);
}

type LabEndUser = f.Json200<"/api/end-users/{id}", "get">;
type EndUserPatch = f.JsonRequest<"/api/end-users/{id}", "patch">;
type LabAgentDetail = f.Json200<"/api/packages/agents/{scope}/{name}", "get">;
type AgentUpdate = f.JsonRequest<"/api/packages/agents/{scope}/{name}", "patch">;

const changedEndUsers = new Map<string, LabEndUser>();
const deletedEndUsers = new Set<string>();
const dashboardSsoByOrg = new Map<string, boolean>();
const organizationLogoByOrg = new Map<string, string | null>();
const changedAgentBundles = new Map<string, LabAgentDetail>();
/** Skill and MCP-server drafts saved in this lab session. */
const changedPackageDrafts = new Map<string, (typeof f.skillDetails)[number]>();
type IntegrationOrgDefault = f.Json200<"/api/integrations/{packageId}/default", "get">;
/** Org defaults written in this lab session; `null` is one deleted. */
const integrationDefaults = new Map<string, IntegrationOrgDefault | null>();
const defaultKey = (url: URL, headers: Headers) =>
  `${headers.get("X-Org-Id")}:${headers.get("X-Application-Id")}:${url.pathname}`;

/** The org default the lab's org starts with, until a write replaces or deletes it. */
function integrationDefault(url: URL, headers: Headers): IntegrationOrgDefault | null {
  const key = defaultKey(url, headers);
  if (integrationDefaults.has(key)) return integrationDefaults.get(key) ?? null;
  return headers.get("X-Org-Id") === f.ORG_ID && genericPackageId(url) === f.INTEGRATION_ID
    ? f.integrationOrgDefault
    : null;
}

export function resetEndUserLabState(): void {
  changedEndUsers.clear();
  deletedEndUsers.clear();
}

export function resetSettingsLabState(): void {
  integrationDefaults.clear();
  oauthClientTiers.clear();
  dashboardSsoByOrg.clear();
  organizationLogoByOrg.clear();
}

export function resetAgentEditorLabState(): void {
  changedAgentBundles.clear();
  draftRevisions.clear();
}

/**
 * The draft version of each package, as its `ETag` (`W/"<n>"`). A detail read
 * carries it, a save sends it back as `If-Match` and moves it forward one, the
 * way the server's optimistic concurrency does: a stale tag is a 412, a missing
 * one a 428.
 */
const draftRevisions = new Map<string, number>();

function draftEtag(packageId: string): string {
  return `W/"${draftRevisions.get(packageId) ?? 1}"`;
}

/** The refusal a save gets for its `If-Match`, or `null` when it is current. */
function staleDraft(packageId: string, headers: Headers): LabResponse | null {
  const ifMatch = headers.get("If-Match");
  if (!ifMatch)
    return {
      status: 428,
      body: { title: "Precondition Required", status: 428, code: "precondition_required" },
    };
  if (ifMatch !== draftEtag(packageId))
    return {
      status: 412,
      body: { title: "Precondition Failed", status: 412, code: "precondition_failed" },
    };
  return null;
}

/** A save that went through: the draft moves forward one version. */
function savedDraft(packageId: string, scenario: Scenario, body: unknown): LabResponse {
  if (scenario === "error") return { status: 500, body };
  draftRevisions.set(packageId, (draftRevisions.get(packageId) ?? 1) + 1);
  return { status: 200, body, headers: { ETag: draftEtag(packageId) } };
}

/** A detail read, stamped with its draft version. */
function draftDetail(packageId: string, body: unknown): LabResponse {
  return { status: 200, body, headers: { ETag: draftEtag(packageId) } };
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
  return /^\/(skills|mcp-servers|integrations)\/[^/]+\/[^/]+(?:\/|$)/.test(location);
}

function isEndUserPatch(body: unknown): body is EndUserPatch {
  return typeof body === "object" && body !== null && !Array.isArray(body);
}

function isAgentUpdate(body: unknown): body is AgentUpdate {
  return typeof body === "object" && body !== null && !Array.isArray(body);
}

type LabFileIndex = f.Json200<"/api/packages/{scope}/{name}/files", "get">;

/** Draft file trees changed by a save in this lab session. */
const changedFileIndexes = new Map<string, LabFileIndex>();

function labFileIndex(packageId: string): LabFileIndex | undefined {
  return (
    changedFileIndexes.get(packageId) ??
    (packageId === f.INTEGRATION_ID
      ? f.integrationFiles
      : packageId === "@lab/auth-methods"
        ? f.integrationAuthLabFiles
        : (f.packageFileIndexes[packageId] ?? integrationManifestIndex(packageId)))
  );
}

/**
 * A save's file operations, applied the way the platform applies them: the
 * same reducer the editor projects its draft with. Returns the text of a file
 * the save wrote, so a detail that mirrors it (prompt, SKILL.md) follows.
 */
function applyLabFileOperations(
  packageId: string,
  type: PackageType,
  body: unknown,
): (path: string) => string | undefined {
  const operations = (body as { operations?: PackageFileWriteOperation[] } | null)?.operations;
  if (!operations?.length) return () => undefined;
  const entries: PackageFileEntry[] = projectDraftFiles(
    labFileIndex(packageId)?.data ?? [],
    operations,
    type,
  ).map(({ sourcePath: _source, ...entry }) => entry);
  changedFileIndexes.set(packageId, { object: "list", data: entries, hasMore: false });
  return (path) => entries.find((entry) => entry.path === path)?.inline;
}

function agentDetailFixture(packageId: string): LabAgentDetail {
  const changed = changedAgentBundles.get(packageId);
  if (changed) return changed;
  if (packageId === f.agentDetail.id) return f.agentDetail;
  const listed = f.agents.data.find((agent) => agent.id === packageId);
  const name = packageId.split("/").pop() ?? packageId;
  const displayName =
    listed?.display_name ??
    name
      .split("-")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  const lastRun = f.runs.find((run) => run.packageId === packageId);
  const detailVersion = listed?.version ?? f.agentDetail.version ?? "0.1.0";
  const baseManifest = f.agentDetail.manifest!;
  const detail: LabAgentDetail = {
    ...f.agentDetail,
    id: packageId,
    icon: listed?.icon ?? f.agentDetail.icon,
    color: listed?.color ?? f.agentDetail.color,
    display_name: displayName,
    description: listed?.description ?? f.agentDetail.description,
    source: listed?.source ?? f.agentDetail.source,
    scope: listed?.scope ?? f.agentDetail.scope,
    version: detailVersion,
    running_runs: listed?.running_runs ?? 0,
    last_run: lastRun?.started_at
      ? {
          id: lastRun.id,
          status: lastRun.status,
          started_at: lastRun.started_at,
          duration: lastRun.duration,
        }
      : null,
    manifest: {
      ...baseManifest,
      name: packageId,
      icon: listed?.icon ?? f.agentDetail.icon,
      version: detailVersion,
      display_name: displayName,
      description: listed?.description ?? f.agentDetail.description,
      _meta: listed?.color ? { "dev.appstrate/ui": { color: listed.color } } : baseManifest._meta,
      dependencies: { integrations: {} },
    },
    dependencies: { skills: [], mcp_servers: [], integrations: [] },
  };
  if (packageId !== "@tractr/analyse-recurrence-articles-tastet") return detail;
  return {
    ...detail,
    prompt: "",
    // `config` became `input`, and the per-space values moved into it
    // alongside the schema (`values` / `locked_fields`).
    input: {
      ...detail.input,
      schema: {
        type: "object",
        properties: {
          editorial_period: { type: "string", title: "Période éditoriale" },
        },
        required: ["editorial_period"],
      } as never,
      values: {},
      locked_fields: [],
    },
  };
}

function agentPackageId(url: URL): string {
  const parts = url.pathname.split("/").filter(Boolean);
  return `${decodeURIComponent(parts[2] ?? "")}/${decodeURIComponent(parts[3] ?? "")}`;
}

function orgIdFromSettingsUrl(url: URL): string {
  return decodeURIComponent(url.pathname.split("/")[3] ?? "");
}

/** `heavy` swaps the list bodies; `empty` empties them; `nominal` is as authored. */
/**
 * The space a request is scoped to, as the client stamps it. The lab opens on
 * the default space, so an unstamped request answers for that one.
 */
function currentSpace(headers: Headers): string {
  return headers.get("X-Space-Id") || "app_lab_default";
}

/**
 * What the lab activated or deactivated since it loaded, per space. Without it
 * the fixtures would answer the same thing after an install as before, and the
 * one thing this screen is for — a package moving from the catalogue into the
 * space — could never be seen.
 */
const labActivations = new Map<string, { on: Set<string>; off: Set<string> }>();

function activationOverlay(spaceId: string) {
  let entry = labActivations.get(spaceId);
  if (!entry) {
    entry = { on: new Set<string>(), off: new Set<string>() };
    labActivations.set(spaceId, entry);
  }
  return entry;
}

function activeIdsFor(
  type: "agent" | "skill" | "mcp-server" | "integration",
  spaceId: string,
): Set<string> {
  const ids = f.activePackageIds(type, spaceId);
  const overlay = labActivations.get(spaceId);
  for (const id of overlay?.on ?? []) ids.add(id);
  for (const id of overlay?.off ?? []) ids.delete(id);
  return ids;
}

/**
 * A list route answers with what is ACTIVE in this space: that is the rule for
 * agents always, and for the other types when `?active=true` asks for it.
 */
function activeHere<T extends { id: string }>(
  rows: T[],
  type: "agent" | "skill" | "mcp-server",
  headers: Headers,
): T[] {
  const active = activeIdsFor(type, currentSpace(headers));
  return rows.filter((row) => active.has(row.id));
}

/**
 * Chat enforcement toggled in this lab session, per `space:package`. Read by
 * every surface that shows it — both library routes and the chat's own list —
 * so a box ticked in the catalogue locks the skill in the conversation.
 */
const chatEnforcedOverrides = new Map<string, boolean>();

function chatEnforcedIn(spaceId: string, packageId: string, authored: boolean): boolean {
  return chatEnforcedOverrides.get(`${spaceId}:${packageId}`) ?? authored;
}

/** The skills a space imposes on its conversations, as `GET /api/chat/enforced-skills` names them. */
function enforcedSkills(spaceId: string): f.Json200<"/api/chat/enforced-skills", "get">["data"] {
  return f.library.packages.skill
    .filter((pkg) =>
      pkg.placements.some(
        (placement) =>
          placement.space_id === spaceId &&
          chatEnforcedIn(spaceId, pkg.id, placement.chat_enforced),
      ),
    )
    .map((pkg) => {
      const row = f.skills.data.find((skill) => skill.id === pkg.id);
      return { id: pkg.id, name: row?.name ?? pkg.name, version: row?.version ?? null };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

function list<T>(rows: T[], scenario: Scenario, heavy?: T[]): T[] {
  if (scenario === "empty") return [];
  if (scenario === "heavy" && heavy) return heavy;
  return rows;
}

/** One placement as `/api/spaces/{spaceId}/packages…` answers it, overlays applied. */
function spacePackage(
  spaceId: string,
  packageId: string,
): f.Json200<"/api/spaces/{spaceId}/packages/{scope}/{name}", "patch"> {
  const row = Object.values(f.library.packages)
    .flat()
    .find((pkg) => pkg.id === packageId);
  const placement = row?.placements.find((candidate) => candidate.space_id === spaceId);
  const type = row?.type ?? "agent";
  return {
    object: "space_package",
    packageId,
    generation_config: null,
    modelId: null,
    proxyId: null,
    enabled: activeIdsFor(type, spaceId).has(packageId),
    chat_enforced: chatEnforcedIn(spaceId, packageId, placement?.chat_enforced ?? false),
    installed_at: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    package_type: type,
    package_source: row?.source === "system" ? "system" : "local",
    draft_manifest: null,
  };
}

/** The organization's map, with the activations the lab's lists made overlaid. */
function libraryResponse() {
  return {
    status: 200,
    body: {
      ...f.library,
      packages: Object.fromEntries(
        Object.entries(f.library.packages).map(([type, rows]) => [
          type,
          rows.map((pkg) => ({
            ...pkg,
            // The overlay the lists use, expressed as PLACEMENTS: a package a
            // catalogue activated in a space is placed there and running.
            placements: f.library.spaces.flatMap((space) => {
              const existing = pkg.placements.find((p) => p.space_id === space.id);
              const activated =
                pkg.source !== "system" && activeIdsFor(type as "agent", space.id).has(pkg.id);
              if (existing) {
                return [
                  {
                    ...existing,
                    state: activated ? ("active" as const) : existing.state,
                    chat_enforced: chatEnforcedIn(space.id, pkg.id, existing.chat_enforced),
                  },
                ];
              }
              return activated
                ? [
                    {
                      space_id: space.id,
                      via: "shared" as const,
                      state: "active" as const,
                      chat_enforced: false,
                      shared_by: null,
                    },
                  ]
                : [];
            }),
          })),
        ]),
      ),
    },
  };
}

/** What the server answers anybody but an owner or admin (`routes/library.ts`). */
const forbiddenLibrary = {
  status: 403,
  body: {
    title: "Forbidden",
    detail: "The organization library requires the user's own credential holding owner or admin",
  },
};

/* -------------------------------------------------------------------------- */
/* Integration OAuth clients — the space tier and the org tier                 */
/* -------------------------------------------------------------------------- */

type ClientDescriptor = f.Json200<
  "/api/integrations/{packageId}/auths/{authKey}/clients",
  "get"
>["data"][number];
type OAuthClientRow = f.Json200<
  "/api/integrations/{packageId}/oauth-clients/{clientId}/promote",
  "post"
>;

/** A registered client of one tier, as `integration_oauth_clients` holds it. */
type LabOAuthClient = Omit<OAuthClientRow, "spaceId"> & {
  tier: "space" | "org";
  is_default: boolean;
};

/** Both tiers of one `(integration, auth)`, keyed `packageId:authKey`. */
const oauthClientTiers = new Map<string, { space: LabOAuthClient[]; org: LabOAuthClient[] }>();

/** The deployment's system client: the `drive` auth has one, the others none. */
function systemClient(authKey: string): ClientDescriptor | null {
  return authKey === f.INTEGRATION_AUTH_KEY
    ? (f.integrationClients.data.find((row) => row.source === "system") ?? null)
    : null;
}

function clientTiers(packageId: string, authKey: string) {
  const key = `${packageId}:${authKey}`;
  let tiers = oauthClientTiers.get(key);
  if (!tiers) {
    const seeded = (tier: "space" | "org", row: ClientDescriptor): LabOAuthClient => ({
      id: row.client_ref,
      integration_package_id: packageId,
      auth_key: authKey,
      client_id: row.client_id,
      has_client_secret: row.has_client_secret,
      token_endpoint_auth_method: row.token_endpoint_auth_method,
      redirect_uri: row.redirect_uri,
      createdAt: "2026-05-02T10:00:00.000Z",
      updatedAt: "2026-05-02T10:00:00.000Z",
      tier,
      is_default: row.is_default,
    });
    const rows = authKey === f.INTEGRATION_AUTH_KEY ? f.integrationClients.data : [];
    tiers = {
      space: rows.filter((row) => row.source === "space").map((row) => seeded("space", row)),
      org: rows.filter((row) => row.source === "org").map((row) => seeded("org", row)),
    };
    oauthClientTiers.set(key, tiers);
  }
  return tiers;
}

/** The client new connections use: a flagged space one, a flagged org one, the system one, then the oldest. */
function pickDefault(
  space: readonly LabOAuthClient[],
  org: readonly LabOAuthClient[],
  system: ClientDescriptor | null,
): LabOAuthClient | ClientDescriptor | null {
  return (
    space.find((c) => c.is_default) ??
    org.find((c) => c.is_default) ??
    system ??
    space[0] ??
    org[0] ??
    null
  );
}

const refOf = (client: LabOAuthClient | ClientDescriptor) =>
  "client_ref" in client ? client.client_ref : client.id;

/** What the tier inherits: the default it would get with none of its own clients flagged. */
function inheritedClient(tier: "space" | "org", packageId: string, authKey: string) {
  const { space, org } = clientTiers(packageId, authKey);
  const unflagged = (rows: LabOAuthClient[]) => rows.map((c) => ({ ...c, is_default: false }));
  return tier === "space"
    ? pickDefault(unflagged(space), org, systemClient(authKey))
    : pickDefault([], unflagged(org), systemClient(authKey));
}

/** `listIntegrationClients` on the server: the inherited default first, then the tier's own. */
function listOAuthClients(tier: "space" | "org", packageId: string, authKey: string) {
  const tiers = clientTiers(packageId, authKey);
  const own = tiers[tier];
  const system = systemClient(authKey);
  const defaultClient = pickDefault(tier === "space" ? tiers.space : [], tiers.org, system);
  const defaultRef = defaultClient ? refOf(defaultClient) : null;
  const inherited = inheritedClient(tier, packageId, authKey);
  const listed =
    inherited && !own.some((c) => c.id === refOf(inherited)) ? [inherited, ...own] : own;
  const data: ClientDescriptor[] = listed.map((c) =>
    "client_ref" in c
      ? { ...c, is_default: c.client_ref === defaultRef }
      : {
          client_ref: c.id,
          source: c.tier,
          client_id: c.client_id,
          is_default: c.id === defaultRef,
          auto_provisioned: false,
          has_client_secret: c.has_client_secret,
          token_endpoint_auth_method: c.token_endpoint_auth_method,
          redirect_uri: c.redirect_uri,
        },
  );
  return { object: "list" as const, hasMore: false, data };
}

function clientRow({ tier, is_default: _default, ...client }: LabOAuthClient): OAuthClientRow {
  return { ...client, spaceId: tier === "space" ? "app_lab_default" : null };
}

/** `packageId` and `authKey` out of either tier's auth route. */
function clientAuthPath(url: URL, tier: "space" | "org") {
  const parts = url.pathname.split("/").map(decodeURIComponent);
  // /api/integrations/@s/n/auths/k/… and /api/org-integrations/@s/n/auths/k/…
  return { packageId: `${parts[3]}/${parts[4]}`, authKey: parts[6] ?? "", tier };
}

/** `packageId` and `clientId` out of either tier's client route. */
function clientIdPath(url: URL) {
  const parts = url.pathname.split("/").map(decodeURIComponent);
  return { packageId: `${parts[3]}/${parts[4]}`, clientId: parts[6] ?? "" };
}

function findOAuthClient(packageId: string, clientId: string) {
  // A client route names no auth: the seeded one may not have been listed yet.
  clientTiers(packageId, f.INTEGRATION_AUTH_KEY);
  for (const [key, tiers] of oauthClientTiers) {
    if (!key.startsWith(`${packageId}:`)) continue;
    for (const tier of ["space", "org"] as const) {
      const client = tiers[tier].find((c) => c.id === clientId);
      if (client) return { client, tiers, tier };
    }
  }
  return null;
}

const tierOf = (url: URL): "space" | "org" =>
  url.pathname.startsWith("/api/org-integrations/") ? "org" : "space";

function clientWriteBody(body: unknown) {
  const b = (body ?? {}) as {
    client_id?: unknown;
    client_secret?: unknown;
    token_endpoint_auth_method?: OAuthClientRow["token_endpoint_auth_method"];
    redirect_uri?: unknown;
  };
  if (typeof b.client_id !== "string" || !b.client_id.trim()) return null;
  return {
    client_id: b.client_id,
    has_client_secret: typeof b.client_secret === "string" && b.client_secret.length > 0,
    token_endpoint_auth_method: b.token_endpoint_auth_method ?? null,
    redirect_uri: typeof b.redirect_uri === "string" ? b.redirect_uri : null,
  };
}

/**
 * `updateIntegrationOAuthClient` on the server: a partial write. `client_id`
 * cannot change and is ignored; an omitted field keeps its stored value, a
 * `null` `redirect_uri` clears it, an empty `client_secret` clears the secret
 * and is accepted only beside `token_endpoint_auth_method: "none"`.
 */
function clientPatchBody(stored: LabOAuthClient, body: unknown) {
  const b = (body ?? {}) as {
    client_secret?: unknown;
    token_endpoint_auth_method?: OAuthClientRow["token_endpoint_auth_method"];
    redirect_uri?: unknown;
  };
  const fields: Partial<
    Pick<LabOAuthClient, "has_client_secret" | "token_endpoint_auth_method" | "redirect_uri">
  > = {};
  if (typeof b.client_secret === "string") {
    if (b.client_secret === "" && b.token_endpoint_auth_method !== "none") return null;
    fields.has_client_secret = b.client_secret.length > 0;
  }
  if (b.token_endpoint_auth_method !== undefined) {
    fields.token_endpoint_auth_method = b.token_endpoint_auth_method;
  } else if (fields.has_client_secret && stored.token_endpoint_auth_method === "none") {
    // A new secret on a public client: the manifest's method applies again.
    fields.token_endpoint_auth_method = null;
  }
  if (b.redirect_uri === null) fields.redirect_uri = null;
  else if (typeof b.redirect_uri === "string") fields.redirect_uri = b.redirect_uri;
  return fields;
}

const badClientRequest: LabResponse = {
  status: 400,
  body: { title: "Bad Request", status: 400, code: "validation_failed" },
};

/** The same doors on both tiers: list, register, rotate, delete, choose the default. */
const OAUTH_CLIENT_ROUTES: Array<{ method: string; pattern: RegExp; handler: Handler }> = [
  {
    method: "GET",
    pattern: /^\/api\/(org-)?integrations\/[^/]+\/[^/]+\/auths\/[^/]+\/clients$/,
    handler: (url, s) => {
      const { packageId, authKey, tier } = clientAuthPath(url, tierOf(url));
      const body = listOAuthClients(tier, packageId, authKey);
      return { status: 200, body: { ...body, data: list(body.data, s) } };
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/(org-)?integrations\/[^/]+\/[^/]+\/auths\/[^/]+\/oauth-clients$/,
    handler: (url, scenario, _headers, body) => {
      const { packageId, authKey, tier } = clientAuthPath(url, tierOf(url));
      const fields = clientWriteBody(body);
      if (!fields) return badClientRequest;
      const own = clientTiers(packageId, authKey)[tier];
      const now = new Date().toISOString();
      const created: LabOAuthClient = {
        id: `cli_lab_${Math.random().toString(36).slice(2, 8)}`,
        integration_package_id: packageId,
        auth_key: authKey,
        ...fields,
        createdAt: now,
        updatedAt: now,
        tier,
        // Only a tier's first client becomes its default.
        is_default: own.length === 0,
      };
      if (scenario !== "error") own.push(created);
      return { status: 201, body: clientRow(created) };
    },
  },
  {
    method: "PATCH",
    pattern: /^\/api\/(org-)?integrations\/[^/]+\/[^/]+\/oauth-clients\/[^/]+$/,
    handler: (url, scenario, _headers, body) => {
      const { packageId, clientId } = clientIdPath(url);
      const found = findOAuthClient(packageId, clientId);
      if (!found || found.tier !== tierOf(url)) return { status: 404, body: {} };
      const fields = clientPatchBody(found.client, body);
      if (!fields) return badClientRequest;
      const rotated = { ...found.client, ...fields, updatedAt: new Date().toISOString() };
      if (scenario !== "error") Object.assign(found.client, rotated);
      return { status: 200, body: clientRow(rotated) };
    },
  },
  {
    method: "DELETE",
    pattern: /^\/api\/(org-)?integrations\/[^/]+\/[^/]+\/oauth-clients\/[^/]+$/,
    handler: (url, scenario) => {
      const { packageId, clientId } = clientIdPath(url);
      const found = findOAuthClient(packageId, clientId);
      if (!found || found.tier !== tierOf(url)) return { status: 404, body: {} };
      if (scenario !== "error")
        found.tiers[found.tier] = found.tiers[found.tier].filter((c) => c.id !== clientId);
      return { status: 204, body: null };
    },
  },
  {
    method: "PUT",
    pattern: /^\/api\/(org-)?integrations\/[^/]+\/[^/]+\/auths\/[^/]+\/default-client$/,
    handler: (url, scenario, _headers, body) => {
      const { packageId, authKey, tier } = clientAuthPath(url, tierOf(url));
      const ref = (body as { client_ref?: unknown } | null)?.client_ref;
      const own = clientTiers(packageId, authKey)[tier];
      const inherited = inheritedClient(tier, packageId, authKey);
      const target = own.find((c) => c.id === ref);
      if (!target && (!inherited || refOf(inherited) !== ref)) return badClientRequest;
      // An own client is flagged; the inherited one clears the tier's flags.
      if (scenario !== "error") for (const c of own) c.is_default = c === target;
      return { status: 200, body: listOAuthClients(tier, packageId, authKey) };
    },
  },
  {
    // A space's own client moved to the org tier: same id, so the
    // connections it minted keep working, and every space inherits it.
    method: "POST",
    pattern: /^\/api\/integrations\/[^/]+\/[^/]+\/oauth-clients\/[^/]+\/promote$/,
    handler: (url, scenario) => {
      const { packageId, clientId } = clientIdPath(url);
      const found = findOAuthClient(packageId, clientId);
      if (!found || found.tier !== "space") return { status: 404, body: {} };
      const promoted: LabOAuthClient = { ...found.client, tier: "org", is_default: false };
      if (scenario !== "error") {
        found.tiers.space = found.tiers.space.filter((c) => c.id !== clientId);
        found.tiers.org.push(promoted);
      }
      return { status: 200, body: clientRow(promoted) };
    },
  },
];

const ROUTES: Array<{ method: string; pattern: RegExp; handler: Handler }> = [
  ...OAUTH_CLIENT_ROUTES,
  /* Identity — the three reads main.tsx fires before React mounts. */
  {
    method: "GET",
    pattern: /^\/api\/auth\/get-session$/,
    handler: () => ({ status: 200, body: f.session, delayMs: 40 }),
  },
  {
    method: "GET",
    pattern: /^\/api\/auth\/list-accounts$/,
    handler: () => ({ status: 200, body: f.linkedAccounts }),
  },
  {
    method: "GET",
    pattern: /^\/api\/auth\/cli\/sessions$/,
    handler: (_u, s) => ({
      status: 200,
      body: { ...f.personalCliSessions, data: list(f.personalCliSessions.data, s) },
    }),
  },
  { method: "GET", pattern: /^\/api\/profile$/, handler: () => ({ status: 200, body: f.profile }) },
  {
    method: "GET",
    pattern: /^\/api\/me\/connections$/,
    handler: (_u, s) => ({
      status: 200,
      body: { ...f.myConnections, data: list(f.myConnections.data, s) },
    }),
  },
  {
    method: "GET",
    pattern: /^\/api\/me\/connections\/[^/]+\/delete-impact$/,
    handler: (_u, s) => ({
      status: 200,
      body: s === "empty" ? { pins: [], schedules: [] } : f.connectionDeleteImpact,
    }),
  },
  {
    // A pasted credential leaves nothing on a target host: no teardown step.
    method: "GET",
    pattern: /^\/api\/me\/connections\/[^/]+\/handoff$/,
    handler: () => ({ status: 200, body: { object: "list", hasMore: false, data: [] } }),
  },
  {
    method: "GET",
    pattern: /^\/api\/orgs$/,
    handler: (_u, s, headers) => ({
      status: 200,
      body: {
        ...f.orgs,
        data: (isPermanentPackageDetail(headers) ? f.orgs.data : list(f.orgs.data, s)).map(
          (org) => ({
            ...org,
            logo: organizationLogoByOrg.has(org.id) ? organizationLogoByOrg.get(org.id) : org.logo,
          }),
        ),
      },
    }),
  },
  {
    // ONE space's placements: the same rows as the org library, narrowed to the
    // space the caller stands in, plus what they could still place here. A
    // pending offer is a placement whose state is `none` — the state this lab
    // gives `@tractr/radar-ia`, so the screen has one to take up.
    method: "GET",
    pattern: /^\/api\/spaces\/[^/]+\/library$/,
    handler: (url) => {
      const spaceId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
      const here = f.library.spaces.filter((space) => space.id === spaceId);
      return {
        status: 200,
        body: {
          ...f.library,
          spaces: here,
          packages: Object.fromEntries(
            Object.entries(f.library.packages).map(([type, rows]) => [
              type,
              rows
                .map((pkg) => ({
                  ...pkg,
                  placements: pkg.placements
                    .filter((placement) => placement.space_id === spaceId)
                    .map((placement) => ({
                      ...placement,
                      chat_enforced: chatEnforcedIn(spaceId, pkg.id, placement.chat_enforced),
                    })),
                }))
                // As the server does (`services/package-library.ts`): a package
                // with no placement here is listed only as a CANDIDATE — one
                // whose home grants this caller `share`, so one click would
                // offer and activate it — and never into a personal space.
                .filter(
                  (pkg) =>
                    pkg.placements.length > 0 ||
                    (pkg.home_shareable && spaceId !== "app_lab_personal"),
                ),
            ]),
          ),
        },
      };
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/library$/,
    // The matrix reads the same overlay as the lists, so a box ticked here and
    // a package activated from a catalogue tell the same story. Owners and
    // admins only, as on the server: anybody else gets the 403 that kept the
    // catalogue broken for members while the lab signed in as an owner.
    handler: () =>
      getRole() === "owner" || getRole() === "admin" ? libraryResponse() : forbiddenLibrary,
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
    handler: (url, scenario) => {
      const id = genericPackageId(url);
      const technical = id === "@lab/auth-methods";
      const detail = technical ? f.integrationAuthLabDetail : f.integrationDetail;
      // Every other integration borrows Google Drive's auths, but keeps its
      // own name, activation and source: the lab used to open Google Drive
      // whatever row was clicked.
      const row = f.integrations.data.find((integration) => integration.id === id);
      return {
        status: 200,
        body: {
          ...detail,
          ...(row
            ? {
                id: row.id,
                active: row.active,
                block_user_connections: row.block_user_connections ?? detail.block_user_connections,
              }
            : {}),
          manifest: technical
            ? {
                ...detail.manifest,
                display_name: "Cas de test : authentification",
                description:
                  "Scénarios techniques de démonstration, pas une intégration de production.",
              }
            : row
              ? { ...detail.manifest, ...row.manifest }
              : detail.manifest,
          auths: detail.auths.map((auth) => {
            const connections =
              auth.auth_key === f.INTEGRATION_AUTH_KEY
                ? list(auth.connections, scenario, f.heavyIntegrationConnections)
                : auth.connections;
            return {
              ...auth,
              connections,
              ready: connections.some((connection) => !connection.needs_reconnection),
            };
          }),
        },
      };
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
    handler: (url, s) => ({
      status: 200,
      body: {
        ...f.integrationPins,
        data: list(
          f.integrationPins.data.filter(
            (pin) => pin.integration_package_id === genericPackageId(url),
          ),
          s,
        ),
      },
    }),
  },
  {
    // 204 is the real server's "no org default is set", and the section reads
    // it as such — a 404 there would look like a broken endpoint instead.
    method: "GET",
    pattern: /^\/api\/integrations\/[^/]+\/[^/]+\/default$/,
    handler: (url, _scenario, headers) => {
      const value = integrationDefault(url, headers);
      return value ? { status: 200, body: value } : { status: 204, body: null };
    },
  },
  {
    // The WHOLE default set, replaced: one to ten connections, and whether it
    // outranks the members' own pins.
    method: "PUT",
    pattern: /^\/api\/integrations\/[^/]+\/[^/]+\/default$/,
    handler: (url, scenario, headers, body) => {
      const update = body as { connection_ids?: unknown; enforce?: unknown } | null;
      const ids = update?.connection_ids;
      if (
        !Array.isArray(ids) ||
        ids.length < 1 ||
        ids.length > 10 ||
        !ids.every((id): id is string => typeof id === "string") ||
        (update?.enforce !== undefined && typeof update.enforce !== "boolean")
      )
        return { status: 400, body: { title: "Bad Request", status: 400 } };
      const key = defaultKey(url, headers);
      const now = new Date().toISOString();
      const value: IntegrationOrgDefault = {
        integration_package_id: genericPackageId(url),
        connection_ids: [...new Set(ids)],
        enforce: update?.enforce === true,
        createdAt: integrationDefault(url, headers)?.createdAt ?? now,
        updatedAt: now,
      };
      if (scenario !== "error") integrationDefaults.set(key, value);
      return { status: 200, body: value };
    },
  },
  {
    method: "DELETE",
    pattern: /^\/api\/integrations\/[^/]+\/[^/]+\/default$/,
    handler: (url, scenario, headers) => {
      if (scenario !== "error") integrationDefaults.set(defaultKey(url, headers), null);
      return { status: 204, body: null };
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/packages\/integrations$/,
    handler: (url, scenario) => {
      const activeIds = new Set(
        f.integrations.data
          .filter((integration) => integration.active)
          .map((integration) => integration.id),
      );
      const rows = f.integrationPackageList.data.filter(
        (item) => url.searchParams.get("active") !== "true" || activeIds.has(item.id),
      );
      return { status: 200, body: { ...f.integrationPackageList, data: list(rows, scenario) } };
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/packages\/integrations\/[^/]+\/[^/]+\/versions$/,
    handler: (url) => ({ status: 200, body: f.integrationVersionHistory(typedPackageId(url)) }),
  },
  {
    method: "GET",
    pattern: /^\/api\/packages\/integrations\/[^/]+\/[^/]+$/,
    handler: (url) =>
      draftDetail(
        typedPackageId(url),
        typedPackageId(url) === "@lab/auth-methods"
          ? {
              ...f.integrationPackage,
              id: "@lab/auth-methods",
              name: "auth-methods",
              orgId: f.ORG_ID,
              source: "local",
              agents: [],
            }
          : integrationPackageFor(typedPackageId(url)),
      ),
  },
  {
    method: "GET",
    pattern: /^\/api\/orgs\/[^/]+\/settings$/,
    handler: (url) => ({
      status: 200,
      body: {
        ...f.orgSettings,
        dashboard_sso_enabled:
          dashboardSsoByOrg.get(orgIdFromSettingsUrl(url)) ?? f.orgSettings.dashboard_sso_enabled,
      },
    }),
  },
  {
    method: "PATCH",
    pattern: /^\/api\/orgs\/[^/]+\/settings$/,
    handler: (url, scenario, _headers, body) => {
      const enabled =
        typeof body === "object" &&
        body !== null &&
        "dashboard_sso_enabled" in body &&
        typeof body.dashboard_sso_enabled === "boolean"
          ? body.dashboard_sso_enabled
          : (f.orgSettings.dashboard_sso_enabled ?? false);
      if (scenario !== "error") dashboardSsoByOrg.set(orgIdFromSettingsUrl(url), enabled);
      return { status: 200, body: { ...f.orgSettings, dashboard_sso_enabled: enabled } };
    },
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
    method: "PATCH",
    pattern: /^\/api\/orgs\/[^/]+$/,
    handler: (url, scenario, _headers, body) => {
      const orgId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
      const logo =
        typeof body === "object" && body !== null && "logo" in body
          ? typeof body.logo === "string" || body.logo === null
            ? body.logo
            : undefined
          : undefined;
      if (scenario !== "error" && logo !== undefined) organizationLogoByOrg.set(orgId, logo);
      return {
        status: 200,
        body: {
          ...f.orgDetail,
          logo: organizationLogoByOrg.has(orgId)
            ? organizationLogoByOrg.get(orgId)
            : f.orgDetail.logo,
        },
      };
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/orgs\/[^/]+$/,
    handler: (url, s) => ({
      status: 200,
      body: {
        ...(orgIdFromSettingsUrl(url) === f.soloOrgDetail.id
          ? f.soloOrgDetail
          : s === "empty"
            ? { ...f.orgDetail, members: [], invitations: [] }
            : f.orgDetail),
        logo: organizationLogoByOrg.has(orgIdFromSettingsUrl(url))
          ? organizationLogoByOrg.get(orgIdFromSettingsUrl(url))
          : f.orgDetail.logo,
      },
    }),
  },
  {
    // The UI leaves the org on this answer; nothing to remember in the lab.
    method: "POST",
    pattern: /^\/api\/orgs\/[^/]+\/leave$/,
    handler: () => ({ status: 204, body: null }),
  },
  {
    // A role change sticks for the session, so the table and the user detail
    // read it back the way they would from the server.
    method: "PUT",
    pattern: /^\/api\/orgs\/[^/]+\/members\/[^/]+$/,
    handler: (url, _scenario, _headers, body) => {
      const userId = decodeURIComponent(url.pathname.split("/").pop() ?? "");
      const role = (body as { role?: unknown } | null)?.role;
      const member = f.orgDetail.members?.find((m) => m.userId === userId);
      if (!member) return { status: 404, body: {} };
      if (role !== "owner" && role !== "admin" && role !== "member" && role !== "guest") {
        return { status: 400, body: { code: "validation_error", detail: "role" } };
      }
      member.role = role;
      return { status: 200, body: member };
    },
  },
  {
    method: "DELETE",
    pattern: /^\/api\/orgs\/[^/]+\/members\/[^/]+$/,
    handler: (url) => {
      const userId = decodeURIComponent(url.pathname.split("/").pop() ?? "");
      const members = f.orgDetail.members ?? [];
      const index = members.findIndex((m) => m.userId === userId);
      if (index === -1) return { status: 404, body: {} };
      members.splice(index, 1);
      return { status: 204, body: null };
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/spaces\/[^/]+$/,
    handler: () => ({ status: 200, body: f.spaces.data[0] }),
  },
  /* RBAC: the role catalog, its vocabulary, and who reaches a space. */
  {
    method: "GET",
    pattern: /^\/api\/roles$/,
    // Presets are platform constants, so "empty" still lists them: only the
    // org's own bundles can be absent.
    handler: (_u, scenario) => ({
      status: 200,
      body: {
        ...f.roles,
        data: scenario === "empty" ? f.roles.data.filter((r) => r.kind === "preset") : f.roles.data,
      },
    }),
  },
  {
    method: "GET",
    pattern: /^\/api\/roles\/vocabulary$/,
    handler: () => ({ status: 200, body: f.roleVocabulary }),
  },
  {
    method: "GET",
    pattern: /^\/api\/spaces\/[^/]+\/roles$/,
    handler: () => ({
      status: 200,
      body: { object: "list", hasMore: false, data: f.assignableSpaceRoles },
    }),
  },
  {
    method: "GET",
    pattern: /^\/api\/spaces\/[^/]+\/members$/,
    // Answers for the space that was ASKED for: a roster identical everywhere
    // would hide the very thing these screens exist to show.
    handler: (url, scenario) => ({
      status: 200,
      body: {
        object: "list",
        hasMore: false,
        data: list(f.membersOfSpace(url.pathname.split("/")[3] ?? ""), scenario),
      },
    }),
  },
  {
    method: "GET",
    pattern: /^\/api\/api-keys$/,
    handler: (_u, scenario) => ({
      status: 200,
      body: { ...f.apiKeys, data: list(f.apiKeys.data, scenario) },
    }),
  },
  {
    method: "GET",
    pattern: /^\/api\/api-keys\/available-scopes$/,
    handler: () => ({ status: 200, body: f.availableApiKeyScopes }),
  },
  {
    method: "GET",
    pattern: /^\/api\/spaces$/,
    // Answers for the org the request asks for, not the one the app is in: the
    // org switcher reads another org's workspaces before switching to it.
    handler: (_u, s, headers) => {
      const orgId = headers.get("X-Org-Id") ?? "";
      const rows = f.spacesByOrg[orgId] ?? f.spaces.data;
      return {
        status: 200,
        body: {
          ...f.spaces,
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
      const mine = url.searchParams.get("user") === "me" || !f.LAB_READS_ALL_RUNS;
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
    // Space-scoped, like the real route: what can be launched HERE.
    handler: (_u, s, headers) => ({
      status: 200,
      body: {
        ...f.agents,
        data: activeHere(list(f.agents.data, s, f.heavyAgents), "agent", headers),
      },
    }),
  },
  {
    method: "GET",
    // The agent catalogue reads the package family, not `/api/agents`, which
    // answers for the current space only.
    pattern: /^\/api\/packages\/agents$/,
    handler: (url, s, headers) => {
      const rows = list(f.agents.data, s, f.heavyAgents);
      const scoped =
        url.searchParams.get("active") === "true" ? activeHere(rows, "agent", headers) : rows;
      return {
        status: 200,
        body: {
          object: "list",
          hasMore: false,
          // The package family names its rows `name`, where `/api/agents` says
          // `display_name`: answering with the wrong shape showed raw ids.
          data: scoped.map((agent) => ({
            id: agent.id,
            name: agent.display_name,
            description: agent.description,
            source: agent.source,
          })),
        },
      };
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/packages\/skills$/,
    handler: (url, s, headers) => {
      const rows = list(f.skills.data, s);
      return {
        status: 200,
        body: {
          ...f.skills,
          data:
            url.searchParams.get("active") === "true" ? activeHere(rows, "skill", headers) : rows,
        },
      };
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/packages\/skills\/[^/]+\/[^/]+$/,
    handler: (url) => {
      const id = typedPackageId(url);
      const detail =
        changedPackageDrafts.get(id) ?? f.skillDetails.find((candidate) => candidate.id === id);
      return detail ? draftDetail(id, detail) : { status: 404, body: {} };
    },
  },
  {
    // Saving a skill's or a server's definition: the draft moves forward one
    // version (its `ETag`) and the page reads it back.
    method: "PATCH",
    pattern: /^\/api\/packages\/(skills|mcp-servers)\/[^/]+\/[^/]+$/,
    handler: (url, scenario, headers, body) => {
      const update = body as {
        manifest?: Record<string, unknown>;
        content?: string | null;
      } | null;
      const id = typedPackageId(url);
      const current =
        changedPackageDrafts.get(id) ??
        [...f.skillDetails, ...f.mcpServerDetails].find((candidate) => candidate.id === id);
      if (!current) return { status: 404, body: {} };
      const refused = staleDraft(id, headers);
      if (refused) return refused;
      const isSkill = url.pathname.includes("/skills/");
      const written =
        scenario === "error"
          ? () => undefined
          : applyLabFileOperations(id, isSkill ? "skill" : "mcp-server", body);
      const updated = {
        ...current,
        manifest: update?.manifest ?? current.manifest,
        content: isSkill
          ? (written("SKILL.md") ?? update?.content ?? current.content)
          : current.content,
      };
      if (scenario !== "error") changedPackageDrafts.set(id, updated);
      return savedDraft(id, scenario, updated);
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/packages\/(skills|mcp-servers)\/[^/]+\/[^/]+\/versions$/,
    handler: (url, scenario) => {
      const history = f.packageVersionsById[typedPackageId(url)];
      return history
        ? { status: 200, body: { ...history, data: list(history.data, scenario) } }
        : { status: 404, body: {} };
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
    handler: (url) => {
      const detail = f.publishedPackageVersion(typedPackageId(url), endUserId(url));
      return detail ? { status: 200, body: detail } : { status: 404, body: {} };
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/packages\/mcp-servers$/,
    handler: (url, s, headers) => {
      const rows = list(f.mcpServers.data, s);
      return {
        status: 200,
        body: {
          ...f.mcpServers,
          data:
            url.searchParams.get("active") === "true"
              ? activeHere(rows, "mcp-server", headers)
              : rows,
        },
      };
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/packages\/mcp-servers\/[^/]+\/[^/]+$/,
    handler: (url) => {
      const id = typedPackageId(url);
      const detail =
        changedPackageDrafts.get(id) ?? f.mcpServerDetails.find((candidate) => candidate.id === id);
      return detail ? draftDetail(id, detail) : { status: 404, body: {} };
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
    handler: (url) => {
      const detail = f.publishedPackageVersion(typedPackageId(url), endUserId(url));
      return detail ? { status: 200, body: detail } : { status: 404, body: {} };
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/packages\/[^/]+\/[^/]+\/files$/,
    handler: (url) => {
      const files = labFileIndex(genericPackageId(url));
      return files ? { status: 200, body: files } : { status: 404, body: {} };
    },
  },
  {
    // The gallery pages with `limit` + an accumulator on the caller's side, so
    // the handler has to honour the query or "load more" asks forever.
    method: "GET",
    pattern: /^\/api\/files$/,
    handler: (url, s) => {
      const all = list(f.documents.data, s, f.heavyDocuments);
      const purpose = url.searchParams.get("purpose");
      const runId = url.searchParams.get("runId");
      const chatSessionId = url.searchParams.get("context_chat_session_id");
      const run = runId ? f.runs.find((candidate) => candidate.id === runId) : undefined;
      const inputDocumentIds = new Set<string>();
      const collectInputDocumentIds = (value: unknown) => {
        if (typeof value === "string" && value.startsWith("appfile://")) {
          inputDocumentIds.add(value.slice("appfile://".length));
          return;
        }
        if (Array.isArray(value)) {
          value.forEach(collectInputDocumentIds);
          return;
        }
        if (value && typeof value === "object") {
          Object.values(value).forEach(collectInputDocumentIds);
        }
      };
      collectInputDocumentIds(run?.input);
      const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
      const filtered = all.filter((document) => {
        if (purpose && document.purpose !== purpose) return false;
        if (chatSessionId && document.chat_session_id !== chatSessionId) return false;
        if (runId && document.runId !== runId && !inputDocumentIds.has(document.id)) {
          return false;
        }
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
    pattern: /^\/api\/files\/[^/]+\/content$/,
    handler: (url) => {
      const row = labFile(/\/files\/([^/]+)\/content$/.exec(url.pathname)?.[1]);
      // The real route echoes the stored mime and refuses a row the caller may
      // not download; both matter here, since that is what the tile branches on.
      if (!row || !row.capabilities.download) return { status: 403, body: {} };
      return { status: 200, ...f.fileContent(row) };
    },
  },
  {
    // The single-file read is the one that mints `preview_url`.
    method: "GET",
    pattern: /^\/api\/files\/[^/]+$/,
    handler: (url) => {
      const row = labFile(/\/files\/([^/]+)$/.exec(url.pathname)?.[1]);
      if (!row) return { status: 404, body: {} };
      return { status: 200, body: { ...row, preview_url: f.previewUrl(row) } };
    },
  },
  {
    // The agent's input settings save themselves: the lab answers with what it
    // was sent, so the form reads "Enregistré" instead of a missing fixture.
    method: "PUT",
    pattern: /^\/api\/agents\/[^/]+\/[^/]+\/input-settings$/,
    handler: (_url, _scenario, _headers, body) => ({ status: 200, body }),
  },
  {
    method: "GET",
    pattern: /^\/api\/packages\/agents\/[^/]+\/[^/]+$/,
    handler: (url) => draftDetail(typedPackageId(url), agentDetailFixture(typedPackageId(url))),
  },
  {
    // Saving an integration's definition from its settings: the draft moves
    // forward one version (its `ETag`) and the page reads it back.
    method: "PATCH",
    pattern: /^\/api\/packages\/integrations\/[^/]+\/[^/]+$/,
    handler: (url, scenario, headers, body) => {
      const update = body as {
        manifest?: Record<string, unknown>;
        content?: string;
      } | null;
      const packageId = typedPackageId(url);
      const refused = staleDraft(packageId, headers);
      if (refused) return refused;
      const current = integrationPackageFor(packageId);
      const written =
        scenario === "error"
          ? () => undefined
          : applyLabFileOperations(packageId, "integration", body);
      const content = update?.content;
      const updated = {
        ...current,
        manifest: update?.manifest ?? current.manifest,
        // As the API does: a manifest copy never overwrites a real document.
        content:
          written("INTEGRATION.md") ??
          (content === undefined || content.trim().startsWith("{") ? current.content : content),
      } as typeof f.integrationPackage;
      if (scenario !== "error") changedIntegrationPackages.set(packageId, updated);
      return savedDraft(packageId, scenario, updated);
    },
  },
  {
    method: "PATCH",
    pattern: /^\/api\/packages\/agents\/[^/]+\/[^/]+$/,
    handler: (url, scenario, headers, body) => {
      if (!isAgentUpdate(body)) return { status: 400, body: {} };
      const packageId = typedPackageId(url);
      const refused = staleDraft(packageId, headers);
      if (refused) return refused;
      const current = agentDetailFixture(packageId);
      const written =
        scenario === "error" ? () => undefined : applyLabFileOperations(packageId, "agent", body);
      const updated: LabAgentDetail = {
        ...current,
        manifest: body.manifest ?? current.manifest,
        prompt: written("prompt.md") ?? body.content ?? current.prompt,
      };
      if (scenario !== "error") changedAgentBundles.set(packageId, updated);
      return savedDraft(packageId, scenario, updated);
    },
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
    handler: (url, s) => {
      const parts = url.pathname.split("/");
      const runId = parts[parts.length - 2] ?? "";
      const run = f.runs.find((candidate) => candidate.id === runId);
      const journal = runId === "run_03" ? f.rqRunLogs : f.runLogs;
      const rows = journal.data.map((row, index) => ({
        ...row,
        id: index + 1,
        runId,
      }));
      if (run?.status === "failed" && run.error) {
        rows.push({
          id: rows.length + 1,
          runId,
          type: "system",
          level: "error",
          event: "run.failed",
          message: run.error,
          createdAt: run.completed_at ?? run.started_at ?? rows[0]!.createdAt,
        });
      }
      return { status: 200, body: { ...f.runLogs, data: list(rows, s) } };
    },
  },
  {
    // `?kind=pinned` and `?kind=memory` are two calls against one endpoint, and
    // the panel fires both. Answering the whole body to each would show the
    // archive under the pinned heading.
    method: "GET",
    pattern: /^\/api\/agents\/[^/]+\/[^/]+\/persistence$/,
    handler: (url, s) => {
      const kind = url.searchParams.get("kind");
      const runId = url.searchParams.get("runId");
      const pinned = list(f.agentPersistence.pinned ?? [], s).filter(
        (row) => !runId || row.runId === runId,
      );
      const memories = list(f.agentPersistence.memories ?? [], s).filter(
        (row) => !runId || row.runId === runId,
      );
      const object = "agent_persistence" as const;
      if (kind === "pinned") return { status: 200, body: { object, pinned } };
      if (kind === "memory") return { status: 200, body: { object, memories } };
      return { status: 200, body: { object, pinned, memories } };
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/agents\/[^/]+\/[^/]+\/connection-readiness$/,
    handler: () => ({ status: 200, body: f.agentConnectionReadiness }),
  },
  {
    method: "GET",
    pattern: /^\/api\/agents\/[^/]+\/[^/]+\/map$/,
    // The map is a PROJECTION of the definition, so a prompt written from one
    // of its cards has to come back on the next read. Without this the card
    // kept showing the fixture and the round trip could only be judged on a
    // real instance — which is how the map's save path went unlooked at.
    handler: (url, scenario) => {
      if (scenario === "error") return { status: 500, body: { title: "Agent map unavailable" } };
      const written = changedAgentBundles.get(agentPackageId(url))?.prompt;
      if (written === undefined || written === null) return { status: 200, body: f.agentMap };
      return {
        status: 200,
        body: {
          ...f.agentMap,
          nodes: f.agentMap.nodes.map((node) =>
            node.type === "agent" ? { ...node, data: { ...node.data, prompt: written } } : node,
          ),
        },
      };
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/agents\/[^/]+\/[^/]+\/diagnostics$/,
    handler: (url, scenario) => {
      const packageId = agentPackageId(url);
      const nominal =
        packageId === "@tractr/wiki-brain"
          ? f.agentDiagnosticsWarnings
          : packageId === "@tractr/analyse-recurrence-articles-tastet"
            ? f.agentDiagnosticsBlocking
            : f.agentDiagnosticsHealthy;
      return {
        status: 200,
        body:
          scenario === "empty"
            ? f.agentDiagnosticsBlocking
            : scenario === "heavy"
              ? f.agentDiagnosticsWarnings
              : nominal,
      };
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/agents\/[^/]+\/[^/]+\/model$/,
    handler: () => ({ status: 200, body: f.agentModel }),
  },
  {
    method: "GET",
    pattern: /^\/api\/agents\/[^/]+\/[^/]+\/proxy$/,
    handler: () => ({ status: 200, body: f.agentProxy }),
  },
  {
    method: "GET",
    pattern: /^\/api\/agents\/[^/]+\/[^/]+\/schedules$/,
    handler: (url, scenario) => {
      const packageId = agentPackageId(url);
      const rows = f.schedules.data.filter((schedule) => schedule.packageId === packageId);
      return {
        status: 200,
        body: { ...f.schedules, data: list(rows, scenario) },
      };
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/agents\/[^/]+\/[^/]+\/run-activity$/,
    handler: (_url, scenario) => ({
      status: 200,
      body:
        scenario === "empty"
          ? { ...f.agentRunActivity, total: 0, success: 0, failed: 0, timeout: 0 }
          : f.agentRunActivity,
    }),
  },
  {
    method: "GET",
    pattern: /^\/api\/agents\/[^/]+\/[^/]+\/runs$/,
    handler: (url, s) => {
      const packageId = genericPackageId(url);
      const requestedStatuses = new Set(
        (url.searchParams.get("status") ?? "").split(",").filter(Boolean),
      );
      const all = list(f.runs, s, f.heavyRuns).filter(
        (run) =>
          run.packageId === packageId &&
          (f.LAB_READS_ALL_RUNS || run.userId == null || run.userId === f.USER_ID) &&
          (requestedStatuses.size === 0 || requestedStatuses.has(run.status)),
      );
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
    method: "GET",
    pattern: /^\/api\/packages\/agents\/[^/]+\/[^/]+\/versions$/,
    handler: (_url, s) => ({
      status: 200,
      body: { ...f.agentVersions, data: list(f.agentVersions.data, s) },
    }),
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
    pattern: /^\/api\/webhooks\/[^/]+$/,
    handler: (url) => {
      const webhook = f.webhooks.data.find((row) => row.id === endUserId(url));
      return webhook ? { status: 200, body: webhook } : { status: 404, body: {} };
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/webhooks\/[^/]+\/deliveries$/,
    handler: (_u, s) => ({
      status: 200,
      body: { ...f.webhookDeliveries, data: list(f.webhookDeliveries.data, s) },
    }),
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
    pattern: /^\/api\/schedules\/[^/]+$/,
    handler: (url) => {
      const schedule = f.scheduleDetails[endUserId(url)];
      return schedule ? { status: 200, body: schedule } : { status: 404, body: {} };
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/schedules\/[^/]+\/runs$/,
    handler: (url, scenario) => {
      const id = url.pathname.split("/")[3];
      const statuses = (url.searchParams.get("status") ?? "").split(",").filter(Boolean);
      const q = (url.searchParams.get("q") ?? "").trim().toLocaleLowerCase();
      const rows = list(f.runs, scenario).filter(
        (run) =>
          run.scheduleId === id &&
          (!statuses.length || statuses.includes(run.status)) &&
          (!q ||
            [run.agent_name, run.agent_scope, run.error].some((value) =>
              value?.toLocaleLowerCase().includes(q),
            ) ||
            Number(q.replace(/^#/, "")) === run.runNumber),
      );
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 20);
      const data = rows.slice(offset, offset + limit);
      const body: f.Json200<"/api/schedules/{id}/runs", "get"> = {
        object: "list",
        data,
        total: rows.length,
        hasMore: offset + data.length < rows.length,
      };
      return { status: 200, body };
    },
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
    // Keyset pages of 100, as the chat module serves them: the long history
    // under "Charge" takes two, so "load more" has something to load.
    handler: (url, s) => {
      const all = list(f.chatSessions.data, s, f.heavyChatSessions);
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 100, 1), 100);
      const cursor = url.searchParams.get("startingAfter");
      const offset = cursor ? all.findIndex((session) => session.id === cursor) + 1 : 0;
      const data = all.slice(offset, offset + limit);
      return {
        status: 200,
        body: { ...f.chatSessions, data, hasMore: offset + data.length < all.length },
      };
    },
  },
  {
    // The skills the space imposes on every conversation, read off the same
    // placements as the library: the default space imposes one, so the
    // picker's locked row can be looked at, and the others impose none.
    method: "GET",
    pattern: /^\/api\/chat\/enforced-skills$/,
    handler: (_u, s, headers) => ({
      status: 200,
      body: {
        object: "list" as const,
        data: s === "empty" ? [] : enforcedSkills(currentSpace(headers)),
      } satisfies f.Json200<"/api/chat/enforced-skills", "get">,
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
    handler: (url, s) => {
      const id = endUserId(url);
      // A conversation that no longer exists (deleted, or another member's):
      // the route's 404, which the chat renders as "Conversation introuvable".
      // Any other unknown id still answers, so a fresh conversation opens.
      // Open /chat/chat_gone to see it.
      if (id === "chat_gone") {
        return { status: 404, body: { title: "Not Found", status: 404, code: "not_found" } };
      }
      const session = [...f.chatSessions.data, ...f.heavyChatSessions].find(
        (candidate) => candidate.id === id,
      ) ?? { ...f.chatSessions.data[0]!, id, title: null };
      return {
        status: 200,
        body: { ...session, messages: list(f.chatHistory.messages, s) },
      };
    },
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
    method: "PUT",
    pattern: /^\/api\/notifications\/read-all$/,
    handler: () => ({ status: 200, body: { updated_count: 0 } }),
  },
  {
    method: "PUT",
    pattern: /^\/api\/notifications\/read\/[^/]+$/,
    handler: () => ({ status: 204, body: null }),
  },
  {
    method: "PUT",
    pattern: /^\/api\/notifications\/[^/]+\/read$/,
    handler: () => ({ status: 204, body: null }),
  },

  /* Activating a package in a space, and taking it back out. */
  {
    method: "POST",
    pattern: /^\/api\/spaces\/[^/]+\/packages$/,
    handler: (url, _s, headers, body) => {
      const spaceId = url.pathname.split("/")[3] ?? currentSpace(headers);
      const packageId = (body as { packageId?: string } | undefined)?.packageId;
      if (!packageId) return { status: 400, body: null };
      const overlay = activationOverlay(spaceId);
      overlay.off.delete(packageId);
      overlay.on.add(packageId);
      return { status: 201, body: spacePackage(spaceId, packageId) };
    },
  },
  {
    // Enforcing a skill in the space's chat — the one field of this patch the
    // lab plays. Refused as the server refuses it: a non-skill (400) and a
    // skill with no published version (409 `no_published_version`).
    method: "PATCH",
    pattern: /^\/api\/spaces\/[^/]+\/packages\/[^/]+\/[^/]+$/,
    handler: (url, scenario, _headers, body) => {
      const parts = url.pathname.split("/");
      const spaceId = decodeURIComponent(parts[3] ?? "");
      const packageId = `${decodeURIComponent(parts[5] ?? "")}/${decodeURIComponent(parts[6] ?? "")}`;
      const enforced = (body as { chat_enforced?: unknown } | undefined)?.chat_enforced;
      const skill = f.library.packages.skill.find((pkg) => pkg.id === packageId);
      const placement = skill?.placements.find((candidate) => candidate.space_id === spaceId);
      if (typeof enforced === "boolean") {
        if (!skill)
          return {
            status: 400,
            body: { title: "Bad Request", status: 400, code: "chat_enforced_not_skill" },
          };
        if (!placement) return { status: 404, body: { title: "Not Found", status: 404 } };
        if (enforced && !skill.published)
          return {
            status: 409,
            body: {
              title: "Conflict",
              status: 409,
              code: "no_published_version",
              detail: `${packageId} has no published version`,
            },
          };
        if (scenario !== "error") chatEnforcedOverrides.set(`${spaceId}:${packageId}`, enforced);
      }
      return { status: 200, body: spacePackage(spaceId, packageId) };
    },
  },
  {
    method: "DELETE",
    pattern: /^\/api\/spaces\/[^/]+\/packages\/[^/]+\/[^/]+$/,
    handler: (url, _s, headers) => {
      const parts = url.pathname.split("/");
      const spaceId = parts[3] ?? currentSpace(headers);
      const packageId = `${decodeURIComponent(parts[5] ?? "")}/${decodeURIComponent(parts[6] ?? "")}`;
      const overlay = activationOverlay(spaceId);
      overlay.on.delete(packageId);
      overlay.off.add(packageId);
      return { status: 204, body: null };
    },
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
  /^\/api\/spaces$/,
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

/** The package row behind an integration, named after the integration asked for. */
/** Integration drafts saved in this lab session. */
const changedIntegrationPackages = new Map<string, typeof f.integrationPackage>();

function integrationPackageFor(id: string): typeof f.integrationPackage {
  return (
    changedIntegrationPackages.get(id) ??
    (integrationPackageBase(id) as typeof f.integrationPackage)
  );
}

/** Any other integration's bundle: its manifest, as the archive would hold it. */
function integrationManifestIndex(id: string) {
  if (!f.integrations.data.some((integration) => integration.id === id)) return undefined;
  const pkg = integrationPackageFor(id);
  const inline = `${JSON.stringify(pkg.manifest, null, 2)}\n`;
  return {
    object: "list" as const,
    hasMore: false,
    data: [
      { path: "manifest.json", size: inline.length, media_kind: "text" as const, inline },
      ...(pkg.content
        ? [
            {
              path: "INTEGRATION.md",
              size: pkg.content.length,
              media_kind: "text" as const,
              inline: pkg.content,
            },
          ]
        : []),
    ],
  };
}

function integrationPackageBase(id: string) {
  const row = f.integrations.data.find((integration) => integration.id === id);
  if (!row || row.id === f.integrationPackage.id) return f.integrationPackage;
  return {
    ...f.integrationPackage,
    id: row.id,
    name: row.id.split("/")[1] ?? row.id,
    orgId: row.source === "system" ? null : f.ORG_ID,
    source: row.source,
    description: row.manifest?.description ?? "",
    version: row.manifest?.version ?? f.integrationPackage.version,
    // Its own document, not Google Drive's: none until one is written.
    content: null,
    // A manifest carries its own id; the editor refuses to save without it.
    manifest: { ...f.integrationPackage.manifest, ...row.manifest, name: row.id },
  };
}
