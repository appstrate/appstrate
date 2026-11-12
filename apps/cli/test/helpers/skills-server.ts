// SPDX-License-Identifier: Apache-2.0

/**
 * A stand-in for the routes `appstrate code sync` reads — `GET /api/spaces` and
 * the REST reflection of the MCP Skills extension (`GET /api/mcp/skills`,
 * `/content`) — driven by a table of skills rather than by per-test URL
 * matching.
 *
 * Entries are served the way the server serves them: packaging entries
 * dropped, the `SKILL.md` `name` pointed at the served name with the shared
 * `normalizeSkillMd`, `metadata.version` set with the shared
 * `setSkillMdVersion` (none for a draft), and every file listed with the `sha256` digest of the
 * bytes `/content` returns, so the digest check is exercised for real.
 */

import { createHash } from "node:crypto";
import {
  isValidSkillName,
  normalizeSkillMd,
  parseSkillFrontmatter,
  setSkillMdVersion,
  SKILL_NAME_MAX_LENGTH,
} from "@appstrate/afps-shared/companion-files";
import { toSlug } from "@appstrate/core/naming";
import { zipArtifact } from "@appstrate/core/zip";

const encoder = new TextEncoder();

/** Same reason: `Space` declares it, nothing in the sync reads it. */
const SPACE_STAMP = { createdAt: "2026-01-01T00:00:00.000Z" };

/** What a member's role grants here: enough to read skills and to run agents through MCP. */
const MEMBER_PERMISSIONS = ["agents:read", "agents:run", "mcp:invoke", "runs:read", "skills:read"];

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
  /** Supporting files of the working copy, path → text. */
  files?: Record<string, string>;
  /**
   * The caller cannot WRITE this skill. The draft is served to its authors
   * only, so the draft list leaves it out and its `@draft` URI answers 404.
   */
  notWritable?: boolean;
}

export interface SkillFixture {
  /** `@scope/name`. */
  id: string;
  /** Full `SKILL.md` text, frontmatter included. */
  skillMd: string;
  /** Published version, served as `metadata.version`. Defaults to `"1.0.0"`. */
  version?: string;
  /** Extra files of the skill, path → text. */
  extraFiles?: Record<string, string>;
  /**
   * The skill is PLACED in the space but switched off there. The real list
   * route IS the active set, so it drops the skill from the only listing the
   * sync reads — a fixture marked this way must never reach the plan.
   */
  inactive?: boolean;
  /** Never published: the list, which serves published skills, leaves it out. */
  unpublished?: boolean;
  /**
   * HTTP status `/content` answers with for this skill's published files.
   * Models a transient server-side failure — distinct from `unpublished`, a
   * definite "there is nothing to sync".
   */
  resolveError?: number;
  /** When true, `/content` serves bytes that do not match the listed digest. */
  corruptDownload?: boolean;
  /** Working-copy state for `--source draft`. */
  draft?: DraftFixture;
}

export interface SkillServer {
  /** Install the stub over `globalThis.fetch`. */
  install(): void;
  /** Count of published `SKILL.md` reads — the "no re-download" assertion. */
  downloads(): number;
  /** Count of draft `SKILL.md` reads. */
  draftDownloads(): number;
  /** Highest number of requests the stub held open at once. */
  peakInFlight(): number;
}

interface Served {
  name: string;
  frontmatter: Record<string, unknown>;
  files: Record<string, Uint8Array>;
}

interface Prepared {
  fixture: SkillFixture;
  scope: string;
  name: string;
  published: Served;
  draft: Served | null;
}

/** The server's rule: the frontmatter `name` when valid, else the package name segment. */
function serve(
  packageName: string,
  skill: string,
  version: string | null,
  extra: Record<string, string> = {},
): Served {
  const authored = parseSkillFrontmatter(skill).name;
  const name = isValidSkillName(authored)
    ? authored
    : toSlug(packageName, SKILL_NAME_MAX_LENGTH).replace(/-+$/, "");
  const served = setSkillMdVersion(normalizeSkillMd(skill, name), version);
  const files: Record<string, Uint8Array> = { "SKILL.md": encoder.encode(served) };
  for (const [path, text] of Object.entries(extra)) files[path] = encoder.encode(text);
  return { name, frontmatter: parseSkillFrontmatter(served).fields, files };
}

function prepare(fixture: SkillFixture): Prepared {
  const [scope, name] = fixture.id.split("/") as [string, string];
  const draft = fixture.draft;
  return {
    fixture,
    scope,
    name,
    published: serve(name, fixture.skillMd, fixture.version ?? "1.0.0", fixture.extraFiles),
    draft: draft ? serve(name, draft.skillMd ?? fixture.skillMd, null, draft.files) : null,
  };
}

const digest = (bytes: Uint8Array): string =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function skillDirUri(spaceId: string, p: Prepared, draft: boolean, name: string): string {
  return `skill://${spaceId}/${p.scope.slice(1)}/${p.name}${draft ? "@draft" : ""}/${name}/`;
}

function entryOf(spaceId: string, p: Prepared, draft: boolean) {
  const served = draft ? p.draft! : p.published;
  const dir = skillDirUri(spaceId, p, draft, served.name);
  return {
    uri: `${dir}SKILL.md`,
    frontmatter: served.frontmatter,
    resources: Object.keys(served.files)
      .sort()
      .map((path) => ({
        uri: `${dir}${path.split("/").map(encodeURIComponent).join("/")}`,
        digest: digest(served.files[path]!),
        size: served.files[path]!.byteLength,
      })),
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

    // The sync selects its skill sources from the spaces this profile reaches,
    // so every run starts here. The two default ids are the ones the suites pin.
    if (path === "/api/spaces") {
      return json({ object: "list", data: spaces.map(spaceWire) });
    }

    if (path === "/api/mcp/skills") {
      // The list IS the ACTIVE set of the space at the definition asked — its
      // published skills, or the drafts this caller may read — the narrowing the
      // server applies, reproduced here so a sync that read a wider listing fails.
      const draft = url.searchParams.get("definition") === "draft";
      return json({
        object: "list",
        data: prepared
          .filter((p) =>
            p.fixture.inactive
              ? false
              : draft
                ? p.draft !== null && !p.fixture.draft?.notWritable
                : !p.fixture.unpublished,
          )
          .map((p) => entryOf(spaceId, p, draft)),
      });
    }

    const uri = url.searchParams.get("uri") ?? "";
    if (path === "/api/mcp/skills/archive") {
      const found = locate(uri, spaceId);
      if (!found || found.filePath !== "SKILL.md") {
        return json({ code: "not_found", message: `No skill readable at ${uri}` }, 404);
      }
      const { p, draft } = found;
      if (!draft && p.fixture.resolveError) {
        return json({ code: "internal_error", message: "read blew up" }, p.fixture.resolveError);
      }
      if (draft) draftDownloads += 1;
      else downloads += 1;
      const files = { ...(draft ? p.draft! : p.published).files };
      if (!draft && p.fixture.corruptDownload) files["SKILL.md"] = encoder.encode("tampered");
      return new Response(new Uint8Array(zipArtifact(files)), {
        status: 200,
        headers: { "Content-Type": "application/zip" },
      });
    }

    return json({ code: "not_found", message: `not stubbed: ${path}` }, 404);
  };

  /** The skill and file a URI of `spaceId` names, `null` when this caller may read none there. */
  const locate = (
    uri: string,
    spaceId: string,
  ): { p: Prepared; draft: boolean; filePath: string } | null => {
    const prefix = `skill://${spaceId}/`;
    if (!uri.startsWith(prefix)) return null;
    const [scope, packageSegment, name, ...rest] = uri.slice(prefix.length).split("/");
    const draft = packageSegment?.endsWith("@draft") ?? false;
    const packageName = draft ? packageSegment!.slice(0, -"@draft".length) : packageSegment;
    const p = prepared.find((c) => c.scope === `@${scope}` && c.name === packageName);
    if (!p || p.fixture.inactive) return null;
    if (draft ? !p.draft || p.fixture.draft?.notWritable : p.fixture.unpublished) return null;
    if ((draft ? p.draft! : p.published).name !== name) return null;
    return { p, draft, filePath: rest.map(decodeURIComponent).join("/") };
  };

  return {
    install(): void {
      globalThis.fetch = stub as unknown as typeof fetch;
    },
    downloads: () => downloads,
    draftDownloads: () => draftDownloads,
    peakInFlight: () => peakInFlight,
  };
}

/**
 * What each route guards on in the space: every skill route `skills:read`.
 * `null` for the one route that is not space-scoped.
 */
function routePermissions(path: string): string[] | null {
  if (path === "/api/spaces") return null;
  return ["skills:read"];
}

/** A minimal conforming `SKILL.md`. */
export function skillMd(name: string, description = "Does a thing."): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nBody.\n`;
}
