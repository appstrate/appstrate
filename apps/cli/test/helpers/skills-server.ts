// SPDX-License-Identifier: Apache-2.0

/**
 * A stand-in for the package routes `appstrate packages sync` reads,
 * driven by a table of skills and agents rather than by per-test URL matching.
 *
 * The artifacts are REAL `.afps` archives built with `zipArtifact` and hashed
 * with `computeIntegrity`, so the download path exercises the same
 * SRI-verify → `unzipArtifact` chain production does. A fixture of
 * hand-written bytes would let the integrity check pass vacuously — which is
 * the one thing these suites must not be able to do.
 *
 * Lives in `test/helpers/` because both `skills-plan.test.ts` and
 * `skills-command.test.ts` need it and neither owns it.
 */

import type { SchemaWrapper } from "@appstrate/core/form";
import { computeIntegrity } from "@appstrate/core/integrity";
import { withoutLockedFields } from "@appstrate/core/input-resolution";
import { zipArtifact } from "@appstrate/core/zip";

const encoder = new TextEncoder();

/** The sync never reads it; the stub carries it because the real DTOs do. */
const MANIFEST_DESCRIPTION = "A skill.";

/** Same reason: `Space` declares it, nothing in the sync reads it. */
const SPACE_STAMP = { createdAt: "2026-01-01T00:00:00.000Z" };

/** What a member's role grants here: enough to read skills and to launch agents and read runs. */
const MEMBER_PERMISSIONS = ["agents:read", "agents:run", "runs:read", "skills:read"];

/**
 * A row of `GET /api/spaces`. The listing reports what the caller may SEE, and
 * `access` / `permissions` are what separates that from what it may USE — a
 * `closed` space an org member has not joined is listed with `access: "none"`
 * and every space-scoped read of it is refused 403 `not_a_space_member`.
 */
export interface SpaceFixture {
  id: string;
  name: string;
  isDefault?: boolean;
  /** Defaults to `"member"`. */
  access?: "member" | "none";
  /** Effective permissions in the space. Defaults to `MEMBER_PERMISSIONS`. */
  permissions?: string[];
}

const DEFAULT_SPACES: SpaceFixture[] = [
  { id: "spc_1", name: "Space One", isDefault: true },
  { id: "spc_2", name: "Space Two" },
];

function spaceWire(fixture: SpaceFixture) {
  const access = fixture.access ?? "member";
  return {
    id: fixture.id,
    orgId: "org_1",
    name: fixture.name,
    isDefault: fixture.isDefault ?? false,
    access,
    role: access === "member" ? { kind: "preset", key: "builder", name: "builder" } : null,
    permissions: fixture.permissions ?? (access === "member" ? MEMBER_PERMISSIONS : []),
    ...SPACE_STAMP,
  };
}

/** Draft-side state of a fixture, read by `--source draft`. */
export interface DraftFixture {
  /** `SKILL.md` of the working copy. Defaults to the published one. */
  skillMd?: string;
  /** The draft version, served as its detail `ETag`: half of the draft change token. */
  lockVersion?: number;
  /** File-index `ETag`, the other half. */
  etag?: string;
  /** Supporting files of the working copy, path → text; the draft archive carries them. */
  files?: Record<string, string>;
  /**
   * The caller cannot WRITE this skill. Naming the working copy is an author's
   * act, so the detail and index routes answer `403 draft_not_writable` to an
   * explicit `?version=draft` from anyone else, and the draft archive to them all.
   */
  notWritable?: boolean;
}

export interface SkillFixture {
  /** `@scope/name`. */
  id: string;
  /** Full `SKILL.md` text, frontmatter included. */
  skillMd: string;
  /** Published version label. */
  version?: string;
  /** Extra archive entries, path → text. */
  extraFiles?: Record<string, string>;
  /** `source` on the list DTO — set to `"system"` to assert it is skipped. */
  source?: "local" | "system";
  /**
   * The skill is PLACED in the space but switched off there. The real list
   * route IS the active set, so it drops the skill from the only listing the
   * sync reads — a fixture marked this way must never reach the plan.
   */
  inactive?: boolean;
  /** When true, `versions/latest` answers 404 (never published). */
  unpublished?: boolean;
  /**
   * HTTP status `versions/latest` answers with instead of resolving. Models a
   * transient server-side failure — distinct from `unpublished`, which is a
   * definite "there is nothing to sync".
   */
  resolveError?: number;
  /** When true, the download serves bytes that do not match `X-Integrity`. */
  corruptDownload?: boolean;
  /** Working-copy state for `--source draft`. */
  draft?: DraftFixture;
}

/**
 * An agent as `GET /api/agents` and its detail answer it. The detail
 * carries the space's input layer (`values` + `locked_fields`) next to the
 * schema, in one read, exactly like the launch form's own projection.
 */
export interface AgentFixture {
  /** `@scope/name`. */
  id: string;
  display_name?: string;
  description?: string;
  /** Published versions, oldest first; the last one is `latest`. `[]` = never published. */
  versions?: string[];
  /** `source` on the list DTO — a system agent has no draft anybody may name. */
  source?: "local" | "system";
  /** Spaces where the agent is ACTIVE, which is what the list route answers. Defaults to all. */
  activeIn?: string[];
  /** The manifest's input wrapper. Defaults to an empty object schema. */
  input?: SchemaWrapper;
  /** The space's stored values — never to be written to disk (D20). */
  values?: Record<string, unknown>;
  locked_fields?: string[];
  /** Working-copy state for `--source draft`; defaults to the published definition. */
  draft?: { description?: string; notWritable?: boolean };
  /** HTTP status the detail answers with instead of resolving — a transient failure. */
  detailError?: number;
}

export interface SkillServer {
  /** Install the stub over `globalThis.fetch`. */
  install(): void;
  /** Count of published `/download` requests — the "no re-download" assertion. */
  downloads(): number;
  /** Count of `/files` index reads. */
  indexReads(): number;
  /** Count of `/draft/download` requests. */
  draftDownloads(): number;
  /** Highest number of requests the stub held open at once. */
  peakInFlight(): number;
  /** Requests to the agent list and detail routes. */
  agentReads(): number;
}

interface Prepared {
  fixture: SkillFixture;
  scope: string;
  name: string;
  version: string;
  bytes: Uint8Array;
  integrity: string;
}

function prepare(fixture: SkillFixture): Prepared {
  const [scope, name] = fixture.id.split("/") as [string, string];
  const entries: Record<string, Uint8Array> = {
    "manifest.json": encoder.encode(
      JSON.stringify({
        afps_version: "0.2",
        type: "skill",
        name: fixture.id,
        version: fixture.version ?? "1.0.0",
        description: MANIFEST_DESCRIPTION,
      }),
    ),
    "SKILL.md": encoder.encode(fixture.skillMd),
  };
  for (const [path, text] of Object.entries(fixture.extraFiles ?? {})) {
    entries[path] = encoder.encode(text);
  }
  const bytes = zipArtifact(entries);
  return {
    fixture,
    scope,
    name,
    version: fixture.version ?? "1.0.0",
    bytes,
    integrity: computeIntegrity(bytes),
  };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

export function createSkillServer(
  fixtures: SkillFixture[],
  spaces: SpaceFixture[] = DEFAULT_SPACES,
  agents: AgentFixture[] = [],
): SkillServer {
  const prepared = fixtures.map(prepare);
  const spaceById = new Map(spaces.map((space) => [space.id, space]));
  let agentReads = 0;
  let downloads = 0;
  let indexReads = 0;
  let draftDownloads = 0;
  let inFlight = 0;
  let peakInFlight = 0;

  const stub = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    inFlight += 1;
    peakInFlight = Math.max(peakInFlight, inFlight);
    try {
      // One macrotask of latency, so overlapping requests are observable at
      // all: a stub that answers synchronously never has two in flight and
      // would measure a concurrency cap of 1 as if it were the real one.
      await new Promise((resolve) => setTimeout(resolve, 0));
      return await respond(input, init);
    } finally {
      inFlight -= 1;
    }
  };

  /**
   * The refusal a space-scoped route answers with when `X-Space-Id` names a
   * space this caller cannot use — `applySpacePermissions` for a non-member,
   * the route's permission guard for a member whose role is too thin (any one
   * of `required` suffices). Returning it here is what makes a selection bug
   * fail a test instead of quietly working against a stub that ignores the header.
   */
  const spaceRefusal = (spaceId: string, required: string[]): Response | null => {
    const space = spaceById.get(spaceId);
    if (!space) return null;
    if ((space.access ?? "member") === "none") {
      return json(
        { code: "not_a_space_member", message: `You are not a member of space '${spaceId}'` },
        403,
      );
    }
    if (!required.some((permission) => grants(spaceId, permission))) {
      return json(
        { code: "forbidden", message: `Insufficient permissions: ${required.join(" or ")}` },
        403,
      );
    }
    return null;
  };
  const grants = (spaceId: string, permission: string): boolean =>
    (spaceById.get(spaceId)?.permissions ?? MEMBER_PERMISSIONS).includes(permission);

  const respond = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const path = url.pathname;
    const spaceId = new Headers(init?.headers).get("X-Space-Id") ?? "";
    // `/api/spaces` is not space-scoped (`SPACE_SCOPED_PREFIXES`); every other
    // route the sync reads is, so it is refused exactly as the server would.
    const required = routePermissions(path);
    if (required) {
      const refusal = spaceRefusal(spaceId, required);
      if (refusal) return refusal;
    }

    if (path === "/api/agents" || path.startsWith("/api/packages/agents/")) {
      agentReads += 1;
      return agentRoute(agents, path, url, spaceId, grants(spaceId, "agents:read"));
    }

    // The sync selects its skill sources from the spaces this profile reaches,
    // so every run starts here. The two default ids are the ones the suites pin.
    if (path === "/api/spaces") {
      return json({ object: "list", data: spaces.map(spaceWire) });
    }

    if (path === "/api/packages/skills") {
      // The index IS the ACTIVE set, not the placed one — the narrowing the
      // server applies, reproduced here unconditionally so a sync that read a
      // wider listing fails instead of quietly syncing switched-off skills.
      //
      // The route takes no `active` filter. The real server ignores unknown
      // query keys, so it would answer this same body either way; the stub is
      // deliberately stricter and refuses, so a sync still sending the
      // parameter turns red here instead of passing on a coincidence.
      if (url.searchParams.has("active")) {
        return json({ code: "bad_request", message: "Unknown query parameter: active" }, 400);
      }
      return json({
        object: "list",
        data: prepared
          .filter((p) => !p.fixture.inactive)
          .map((p) => ({
            id: p.fixture.id,
            name: p.name,
            description: MANIFEST_DESCRIPTION,
            source: p.fixture.source ?? "local",
            version: p.version,
            updatedAt: "2026-01-01T00:00:00.000Z",
          })),
      });
    }

    const latest = path.match(/^\/api\/packages\/skills\/(@[^/]+)\/([^/]+)\/versions\/latest$/);
    if (latest) {
      const found = prepared.find((p) => p.scope === latest[1] && p.name === latest[2]);
      if (!found || found.fixture.unpublished) {
        return json({ code: "not_found", message: "Version not found" }, 404);
      }
      if (found.fixture.resolveError) {
        return json(
          { code: "internal_error", message: "resolution blew up" },
          found.fixture.resolveError,
        );
      }
      return json({
        id: found.fixture.id,
        version: found.version,
        manifest: {
          afps_version: "0.2",
          type: "skill",
          name: found.fixture.id,
          version: found.version,
          description: MANIFEST_DESCRIPTION,
        },
        content: found.fixture.skillMd,
        yanked: false,
        integrity: found.integrity,
        artifact_size: found.bytes.byteLength,
        createdAt: "2026-01-01T00:00:00.000Z",
        dist_tags: ["latest"],
      });
    }

    // Before the published route, whose version segment `draft` would match.
    const draftDownload = path.match(/^\/api\/packages\/(@[^/]+)\/([^/]+)\/draft\/download$/);
    if (draftDownload) {
      const found = prepared.find(
        (p) => p.scope === draftDownload[1] && p.name === draftDownload[2],
      );
      if (!found?.fixture.draft) {
        return json({ code: "not_found", message: "Package not found" }, 404);
      }
      if (found.fixture.draft.notWritable) return draftNotWritable(found);
      draftDownloads += 1;
      const entries: Record<string, Uint8Array> = {};
      for (const [entryPath, text] of Object.entries(draftEntries(found))) {
        entries[entryPath] = encoder.encode(text);
      }
      return new Response(new Uint8Array(zipArtifact(entries)), {
        status: 200,
        headers: {
          "Content-Type": "application/zip",
          ETag: `"${found.fixture.draft.etag ?? "idx-1"}"`,
        },
      });
    }

    const download = path.match(/^\/api\/packages\/(@[^/]+)\/([^/]+)\/([^/]+)\/download$/);
    if (download) {
      const found = prepared.find((p) => p.scope === download[1] && p.name === download[2]);
      if (!found) return json({ code: "not_found", message: "Package not found" }, 404);
      downloads += 1;
      const body = found.fixture.corruptDownload
        ? zipArtifact({ "manifest.json": encoder.encode("{}") })
        : found.bytes;
      return new Response(new Uint8Array(body), {
        status: 200,
        headers: { "Content-Type": "application/afps+zip", "X-Integrity": found.integrity },
      });
    }

    // --- draft side -------------------------------------------------------

    const detail = path.match(/^\/api\/packages\/skills\/(@[^/]+)\/([^/]+)$/);
    if (detail) {
      const found = prepared.find((p) => p.scope === detail[1] && p.name === detail[2]);
      if (!found?.fixture.draft) {
        return json({ code: "not_found", message: "Package not found" }, 404);
      }
      // The detail route reserves an explicit `?version=draft` exactly as the
      // file routes do, and it is the FIRST request the draft resolution
      // makes — so this is where a non-author is refused, before `/files` is
      // ever reached.
      const refusal = draftSelectorRefusal(found, url);
      if (refusal) return refusal;
      return json(
        {
          id: found.fixture.id,
          name: found.name,
          description: MANIFEST_DESCRIPTION,
          // Same rule as the file routes: the working copy answers only when the
          // selector NAMES it, so a resolution that forgets it reads published
          // metadata and fails on content.
          content:
            url.searchParams.get("version") === "draft"
              ? draftSkillMd(found)
              : found.fixture.skillMd,
          source: found.fixture.source ?? "local",
          version: found.version,
          manifest: {
            afps_version: "0.2",
            type: "skill",
            name: found.fixture.id,
            version: found.version,
            description: MANIFEST_DESCRIPTION,
          },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
        },
        200,
        // The draft version is the detail's ETag, never a body field.
        { ETag: `"${found.fixture.draft.lockVersion ?? 1}"` },
      );
    }

    const index = path.match(/^\/api\/packages\/(@[^/]+)\/([^/]+)\/files$/);
    if (index) {
      const found = prepared.find((p) => p.scope === index[1] && p.name === index[2]);
      if (!found?.fixture.draft) {
        return json({ code: "not_found", message: "Package not found" }, 404);
      }
      const refusal = draftSelectorRefusal(found, url);
      if (refusal) return refusal;
      indexReads += 1;
      // `buildFileIndex` shape in the list envelope: sorted entries of
      // { path, size, media_kind }, with `inline` carrying the full text.
      const entries = Object.entries(entriesFor(found, url))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([entryPath, text]) => ({
          path: entryPath,
          size: encoder.encode(text).byteLength,
          media_kind: "text",
          inline: text,
        }));
      return json({ object: "list", data: entries, hasMore: false }, 200, {
        ETag: `"${indexEtag(found, url)}"`,
      });
    }

    return json({ code: "not_found", message: `not stubbed: ${path}` }, 404);
  };

  return {
    install(): void {
      globalThis.fetch = stub as unknown as typeof fetch;
    },
    downloads: () => downloads,
    indexReads: () => indexReads,
    draftDownloads: () => draftDownloads,
    peakInFlight: () => peakInFlight,
    agentReads: () => agentReads,
  };
}

/**
 * What each route guards on in the space: the agent list and detail take
 * either grant (`requireAgentRead`), every skill route `skills:read`. `null`
 * for the one route that is not space-scoped.
 */
function routePermissions(path: string): string[] | null {
  if (path === "/api/spaces") return null;
  if (path === "/api/agents" || path.startsWith("/api/packages/agents/")) {
    return ["agents:read", "agents:run"];
  }
  return ["skills:read"];
}

/**
 * `GET /api/agents` (the ACTIVE, launchable set of the space) and the agent
 * detail. The detail NAMES its definition: `latest` resolves the dist-tag and
 * answers 404 when nothing is published, `draft` is reserved to whoever may
 * write the agent (never anyone for a system agent), and the stub refuses a
 * read without a selector so a sync that forgets it fails here.
 */
function agentRoute(
  agents: AgentFixture[],
  path: string,
  url: URL,
  spaceId: string,
  fullRead: boolean,
): Response {
  if (path === "/api/agents") {
    return json({
      object: "list",
      data: agents
        .filter((agent) => !agent.activeIn || agent.activeIn.includes(spaceId))
        .map((agent) => ({
          id: agent.id,
          name: agent.id.split("/")[1],
          display_name: agent.display_name ?? agent.id,
          description: agent.description ?? "",
          source: agent.source ?? "local",
          updatedAt: "2026-01-01T00:00:00.000Z",
        })),
      hasMore: false,
    });
  }
  const detail = path.match(/^\/api\/packages\/agents\/(@[^/]+)\/([^/]+)$/);
  const agent = detail && agents.find((a) => a.id === `${detail[1]}/${detail[2]}`);
  if (!agent) return json({ code: "not_found", message: "Agent not found" }, 404);
  if (agent.detailError) {
    return json({ code: "internal_error", message: "detail blew up" }, agent.detailError);
  }
  const selector = url.searchParams.get("version");
  const versions = agent.versions ?? ["1.0.0"];
  const system = agent.source === "system";
  let version: string | null;
  let description = agent.description ?? "";
  if (selector === "draft") {
    if (system || agent.draft?.notWritable) {
      return json(
        {
          code: "draft_not_writable",
          detail: `Running the draft of '${agent.id}' requires write authority on it`,
        },
        403,
      );
    }
    version = versions.at(-1) ?? null;
    description = agent.draft?.description ?? description;
  } else if (selector === "latest" || (selector !== null && versions.includes(selector))) {
    // A system agent ships its definition with the platform: any selector resolves to it.
    version = selector === "latest" ? (versions.at(-1) ?? null) : selector;
    if (version === null && !system) {
      return json({ code: "not_found", detail: `Version '${selector}' not found` }, 404);
    }
  } else {
    return json({ code: "bad_request", message: `Unexpected version selector: ${selector}` }, 400);
  }
  const values = agent.values ?? {};
  const lockedFields = agent.locked_fields ?? [];
  return json({
    id: agent.id,
    display_name: agent.display_name ?? agent.id,
    description,
    source: agent.source ?? "local",
    scope: detail![1],
    version: version ?? "1.0.0",
    definition: selector === "draft" ? "draft" : "published",
    dependencies: { integrations: [] },
    input: {
      ...(agent.input ?? { schema: { type: "object", properties: {} } }),
      // A summary read (`agents:run` alone) keeps the lock names, not the values behind them.
      values: fullRead ? values : withoutLockedFields(values, lockedFields),
      locked_fields: lockedFields,
    },
    active: !agent.activeIn || agent.activeIn.includes(spaceId),
  });
}

function draftSkillMd(p: Prepared): string {
  return p.fixture.draft?.skillMd ?? p.fixture.skillMd;
}

/**
 * The detail and index routes serve the definition the detail page renders
 * unless a selector names one, and `draft` named explicitly is reserved to
 * whoever may WRITE the package. Both call this, so a sync that forgets to
 * name the working copy gets the PUBLISHED metadata — the way the routes
 * answer it — and fails its assertion on content rather than on nothing.
 */
function draftSelectorRefusal(p: Prepared, url: URL): Response | null {
  if (url.searchParams.get("version") !== "draft") return null;
  if (!p.fixture.draft?.notWritable) return null;
  return draftNotWritable(p);
}

function draftNotWritable(p: Prepared): Response {
  return json(
    {
      code: "draft_not_writable",
      detail: `You cannot write ${p.fixture.id}, so its draft is not yours to read`,
    },
    403,
  );
}

function entriesFor(p: Prepared, url: URL): Record<string, string> {
  return url.searchParams.get("version") === "draft" ? draftEntries(p) : publishedEntries(p);
}

/** The index ETag is a property of the snapshot it describes, not of the package. */
function indexEtag(p: Prepared, url: URL): string {
  return url.searchParams.get("version") === "draft"
    ? (p.fixture.draft?.etag ?? "idx-1")
    : `published-${p.version}`;
}

/** The published snapshot of the same two-or-more entries. */
function publishedEntries(p: Prepared): Record<string, string> {
  return {
    "manifest.json": manifestJson(p),
    "SKILL.md": p.fixture.skillMd,
    ...p.fixture.extraFiles,
  };
}

function manifestJson(p: Prepared): string {
  return JSON.stringify({
    afps_version: "0.2",
    type: "skill",
    name: p.fixture.id,
    version: p.version,
    description: MANIFEST_DESCRIPTION,
  });
}

/** Flat map of every draft entry — what the index lists and the draft archive carries. */
function draftEntries(p: Prepared): Record<string, string> {
  return {
    "manifest.json": manifestJson(p),
    "SKILL.md": draftSkillMd(p),
    ...p.fixture.draft!.files,
  };
}

/** A minimal conforming `SKILL.md`. */
export function skillMd(name: string, description = "Does a thing."): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nBody.\n`;
}
