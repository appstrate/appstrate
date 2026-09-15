// SPDX-License-Identifier: Apache-2.0

/**
 * A stand-in for the four package routes `appstrate skills sync` reads,
 * driven by a table of skills rather than by per-test URL matching.
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

import { computeIntegrity } from "@appstrate/core/integrity";
import { zipArtifact } from "@appstrate/core/zip";

const encoder = new TextEncoder();

/** The sync never reads it; the stub carries it because the real DTOs do. */
const MANIFEST_DESCRIPTION = "A skill.";

/** Same reason: `Space` declares it, nothing in the sync reads it. */
const SPACE_STAMP = { createdAt: "2026-01-01T00:00:00.000Z" };

/** What a member's role grants here; `skills:read` is what the list route wants. */
const MEMBER_PERMISSIONS = ["agents:read", "skills:read"];

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
  /** Optimistic-concurrency counter, half of the draft change token. */
  lockVersion?: number;
  /** File-index `ETag`, the other half. */
  etag?: string;
  /**
   * Supporting files small enough that `buildFileIndex` inlines their text in
   * the index — the sync must NOT re-request these.
   */
  inlineFiles?: Record<string, string>;
  /** Supporting files listed without `inline`, so they need a content fetch. */
  fetchedFiles?: Record<string, string>;
  /**
   * The caller cannot WRITE this skill. Naming the working copy is an author's
   * act, so the detail route and the file routes alike answer
   * `403 draft_not_writable` to an explicit `?version=draft` from anyone else.
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
   * route drops it from `?active=true`, which is the only listing the sync
   * reads — so a fixture marked this way must never reach the plan.
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

export interface SkillServer {
  /** Install the stub over `globalThis.fetch`. */
  install(): void;
  /** Count of `/download` requests — the "no re-download" assertion. */
  downloads(): number;
  /** Count of `/files` index reads. */
  indexReads(): number;
  /** Count of `/files/content` reads — the "inline is reused" assertion. */
  contentReads(): number;
  /** Highest number of requests the stub held open at once. */
  peakInFlight(): number;
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
): SkillServer {
  const prepared = fixtures.map(prepare);
  const spaceById = new Map(spaces.map((space) => [space.id, space]));
  let downloads = 0;
  let indexReads = 0;
  let contentReads = 0;
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
   * `requirePermission("skills", "read")` for a member whose role is too thin.
   * Returning it here is what makes a selection bug fail a test instead of
   * quietly working against a stub that ignores the header.
   */
  const spaceRefusal = (spaceId: string): Response | null => {
    const space = spaceById.get(spaceId);
    if (!space) return null;
    if ((space.access ?? "member") === "none") {
      return json(
        { code: "not_a_space_member", message: `You are not a member of space '${spaceId}'` },
        403,
      );
    }
    const permissions = space.permissions ?? MEMBER_PERMISSIONS;
    if (!permissions.includes("skills:read")) {
      return json({ code: "forbidden", message: "Insufficient permissions: skills:read" }, 403);
    }
    return null;
  };

  const respond = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const path = url.pathname;
    const spaceId = new Headers(init?.headers).get("X-Space-Id") ?? "";
    // `/api/spaces` is not space-scoped (`SPACE_SCOPED_PREFIXES`); every other
    // route the sync reads is, so it is refused exactly as the server would.
    if (path !== "/api/spaces") {
      const refusal = spaceRefusal(spaceId);
      if (refusal) return refusal;
    }

    // The sync selects its skill sources from the spaces this profile reaches,
    // so every run starts here. The two default ids are the ones the suites pin.
    if (path === "/api/spaces") {
      return json({ object: "list", data: spaces.map(spaceWire) });
    }

    if (path === "/api/packages/skills") {
      // `?active=true` is the ACTIVE set, not the placed one — the narrowing
      // the server applies, reproduced here so a sync that dropped the query
      // parameter fails instead of quietly syncing switched-off skills.
      const activeOnly = url.searchParams.get("active") === "true";
      return json({
        object: "list",
        data: prepared
          .filter((p) => !(activeOnly && p.fixture.inactive))
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
      return json({
        id: found.fixture.id,
        name: found.name,
        description: MANIFEST_DESCRIPTION,
        // Same rule as the file routes: the working copy answers only when the
        // selector NAMES it, so a resolution that forgets it reads published
        // metadata and fails on content.
        content:
          url.searchParams.get("version") === "draft" ? draftSkillMd(found) : found.fixture.skillMd,
        source: found.fixture.source ?? "local",
        version: found.version,
        manifest: {
          afps_version: "0.2",
          type: "skill",
          name: found.fixture.id,
          version: found.version,
          description: MANIFEST_DESCRIPTION,
        },
        lock_version: found.fixture.draft.lockVersion ?? 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      });
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
      // `buildFileIndex` shape: sorted entries of { path, size, media_kind },
      // with `inline` carrying the full text of small text files.
      const entries = Object.entries(entriesFor(found, url))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([entryPath, entry]) => ({
          path: entryPath,
          size: encoder.encode(entry.text).byteLength,
          media_kind: "text",
          ...(entry.inline ? { inline: entry.text } : {}),
        }));
      return json({ entries }, 200, { ETag: `"${indexEtag(found, url)}"` });
    }

    const content = path.match(/^\/api\/packages\/(@[^/]+)\/([^/]+)\/files\/content$/);
    if (content) {
      const found = prepared.find((p) => p.scope === content[1] && p.name === content[2]);
      if (found?.fixture.draft) {
        const refusal = draftSelectorRefusal(found, url);
        if (refusal) return refusal;
      }
      const wanted = url.searchParams.get("path") ?? "";
      const entry = found?.fixture.draft ? entriesFor(found, url)[wanted] : undefined;
      if (!entry) return json({ code: "not_found", message: "File not found" }, 404);
      contentReads += 1;
      return new Response(encoder.encode(entry.text), {
        status: 200,
        headers: { "Content-Type": "application/octet-stream" },
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
    contentReads: () => contentReads,
    peakInFlight: () => peakInFlight,
  };
}

function draftSkillMd(p: Prepared): string {
  return p.fixture.draft?.skillMd ?? p.fixture.skillMd;
}

/**
 * The detail and file routes serve the definition the detail page renders
 * unless a selector names one, and `draft` named explicitly is reserved to
 * whoever may WRITE the package. All three call this, so a sync that forgets
 * to name the working copy gets the PUBLISHED bytes — the way the routes
 * answer it — and fails its assertion on content rather than on nothing.
 */
function draftSelectorRefusal(p: Prepared, url: URL): Response | null {
  if (url.searchParams.get("version") !== "draft") return null;
  if (!p.fixture.draft?.notWritable) return null;
  return json(
    {
      code: "draft_not_writable",
      message: `You cannot write ${p.fixture.id}, so its draft is not yours to read`,
    },
    403,
  );
}

function entriesFor(p: Prepared, url: URL): Record<string, { text: string; inline: boolean }> {
  return url.searchParams.get("version") === "draft" ? draftEntries(p) : publishedEntries(p);
}

/** The index ETag is a property of the snapshot it describes, not of the package. */
function indexEtag(p: Prepared, url: URL): string {
  return url.searchParams.get("version") === "draft"
    ? (p.fixture.draft?.etag ?? "idx-1")
    : `published-${p.version}`;
}

/** The published snapshot of the same three-or-more entries. */
function publishedEntries(p: Prepared): Record<string, { text: string; inline: boolean }> {
  const out: Record<string, { text: string; inline: boolean }> = {
    "manifest.json": { text: manifestJson(p), inline: true },
    "SKILL.md": { text: p.fixture.skillMd, inline: true },
  };
  for (const [path, text] of Object.entries(p.fixture.extraFiles ?? {})) {
    out[path] = { text, inline: true };
  }
  return out;
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

/** Flat map of every draft entry, and whether the index inlines its text. */
function draftEntries(p: Prepared): Record<string, { text: string; inline: boolean }> {
  const draft = p.fixture.draft!;
  const out: Record<string, { text: string; inline: boolean }> = {
    "manifest.json": { text: manifestJson(p), inline: true },
    "SKILL.md": { text: draftSkillMd(p), inline: true },
  };
  for (const [path, text] of Object.entries(draft.inlineFiles ?? {})) {
    out[path] = { text, inline: true };
  }
  for (const [path, text] of Object.entries(draft.fetchedFiles ?? {})) {
    out[path] = { text, inline: false };
  }
  return out;
}

/** A minimal conforming `SKILL.md`. */
export function skillMd(name: string, description = "Does a thing."): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nBody.\n`;
}
