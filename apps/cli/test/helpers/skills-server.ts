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
import { unzipArtifact, zipArtifact } from "@appstrate/core/zip";

const encoder = new TextEncoder();

/** The sync never reads it; the stub carries it because the real DTOs do. */
const MANIFEST_DESCRIPTION = "A skill.";

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
  draft?: DraftFixture & { version?: string };
  /**
   * Spaces the package is installed in. When set, the stub behaves like the
   * platform: the package is listed only under one of these `X-Space-Id`s and
   * its routes answer 404 under any other. Unset means "every space".
   */
  spaces?: string[];
}

export interface SkillServerOptions {
  /** Rows served by `/api/spaces`, for `--space <name>` resolution. */
  spaces?: { id: string; name: string; isDefault?: boolean }[];
  /** Rows served by `/api/orgs`, for `push` / `publish` slug resolution. */
  orgs?: { id: string; slug: string; name?: string }[];
  /** `POST /import?draft=true` answers `409 draft_overwrite` unless `force=true`. */
  draftDirty?: boolean;
  /** `POST …/versions` answers `409 version_exists`. */
  versionExists?: boolean;
  /** Behave like an instance that predates `?draft=true`: always publish. */
  ignoresDraft?: boolean;
  /** Answer the first N imports with `429` and a `Retry-After` of one second. */
  rateLimitFirst?: number;
}

/** What one `POST /api/packages/import` carried. */
export interface RecordedImport {
  query: Record<string, string>;
  filename: string;
  /** Archive entries, path → text. */
  files: Record<string, string>;
  manifest: Record<string, unknown> | null;
}

/** What one `POST …/versions` carried. */
export interface RecordedPublish {
  packageId: string;
  body: Record<string, unknown>;
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
  /** Every `POST /api/packages/import` received, in order. */
  imports(): RecordedImport[];
  /** Every `POST …/versions` received, in order. */
  publishes(): RecordedPublish[];
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
  options: SkillServerOptions = {},
): SkillServer {
  const prepared = fixtures.map(prepare);
  let downloads = 0;
  let indexReads = 0;
  let contentReads = 0;
  let inFlight = 0;
  let peakInFlight = 0;
  const imports: RecordedImport[] = [];
  const publishes: RecordedPublish[] = [];
  let rateLimited = 0;
  /** Optimistic lock per package, as the draft import moves it. */
  const locks = new Map<string, number>();

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

  /** Whether the request's space may see this fixture. */
  const visible = (p: Prepared, space: string | null): boolean =>
    !p.fixture.spaces || (space !== null && p.fixture.spaces.includes(space));

  const respond = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const path = url.pathname;
    const space = new Headers(init?.headers).get("x-space-id");
    const find = (scope: string, name: string): Prepared | undefined => {
      const p = prepared.find((p) => p.scope === scope && p.name === name);
      return p && visible(p, space) ? p : undefined;
    };

    if (path === "/api/orgs") {
      return json({
        object: "list",
        data: (options.orgs ?? []).map((o) => ({
          id: o.id,
          slug: o.slug,
          name: o.name ?? o.slug,
          role: "owner",
          createdAt: "2026-01-01T00:00:00.000Z",
        })),
      });
    }

    if (path === "/api/packages/import" && init?.method === "POST") {
      if ((options.rateLimitFirst ?? 0) > rateLimited) {
        rateLimited += 1;
        return json({ code: "rate_limited", detail: "Too many requests." }, 429, {
          "Retry-After": "1",
        });
      }
      const form = init.body as FormData;
      const file = form.get("file") as File;
      const entries = unzipArtifact(new Uint8Array(await file.arrayBuffer()));
      const decoder = new TextDecoder();
      const files: Record<string, string> = {};
      for (const [entryPath, bytes] of Object.entries(entries))
        files[entryPath] = decoder.decode(bytes);
      const manifest = files["manifest.json"]
        ? (JSON.parse(files["manifest.json"]) as Record<string, unknown>)
        : null;
      const query = Object.fromEntries(url.searchParams.entries());
      imports.push({ query, filename: file.name, files, manifest });
      const packageId = String(manifest?.name ?? "");
      const currentLock = locks.get(packageId) ?? 1;
      const lockMatches =
        query.lock_version !== undefined && Number(query.lock_version) === currentLock;
      if (options.draftDirty && query.force !== "true" && !lockMatches) {
        return json(
          {
            code: "draft_overwrite",
            detail: "This package has unpublished changes that will be overwritten by the import.",
          },
          409,
        );
      }
      const version = manifest?.version;
      const nextLock = currentLock + 1;
      locks.set(packageId, nextLock);
      return json(
        query.draft === "true" && !options.ignoresDraft
          ? {
              packageId: manifest?.name,
              type: "skill",
              draft: true,
              draftVersion: version,
              lock_version: nextLock,
            }
          : { packageId: manifest?.name, type: "skill", version },
        201,
      );
    }

    const publish = path.match(/^\/api\/packages\/skills\/(@[^/]+)\/([^/]+)\/versions$/);
    if (publish && init?.method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
      const packageId = `${publish[1]}/${publish[2]}`;
      publishes.push({ packageId, body });
      if (options.versionExists) {
        return json({ code: "version_exists", detail: "Version 1.2.0 already exists." }, 409);
      }
      const found = prepared.find((p) => p.fixture.id === packageId);
      const version = (body.version as string | undefined) ?? found?.version ?? "1.0.0";
      return json({ id: packageId, version, integrity: "sha256-x" }, 201);
    }

    if (path === "/api/spaces") {
      return json({
        object: "list",
        data: (options.spaces ?? []).map((s) => ({
          id: s.id,
          orgId: "org_1",
          name: s.name,
          isDefault: s.isDefault ?? false,
          createdAt: "2026-01-01T00:00:00.000Z",
        })),
      });
    }

    if (path === "/api/packages/skills") {
      return json({
        object: "list",
        data: prepared
          .filter((p) => visible(p, space))
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

    const latest = path.match(/^\/api\/packages\/skills\/(@[^/]+)\/([^/]+)\/versions\/([^/]+)$/);
    if (latest) {
      const found = find(latest[1]!, latest[2]!);
      const wantedVersion = decodeURIComponent(latest[3]!);
      if (
        !found ||
        found.fixture.unpublished ||
        (wantedVersion !== "latest" && wantedVersion !== found.version)
      ) {
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
      const found = find(download[1]!, download[2]!);
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
      const found = find(detail[1]!, detail[2]!);
      if (!found?.fixture.draft) {
        return json({ code: "not_found", message: "Package not found" }, 404);
      }
      return json({
        id: found.fixture.id,
        name: found.name,
        description: MANIFEST_DESCRIPTION,
        content: draftSkillMd(found),
        source: found.fixture.source ?? "local",
        version: found.version,
        manifest: {
          afps_version: "0.2",
          type: "skill",
          name: found.fixture.id,
          version: found.fixture.draft.version ?? found.version,
          description: MANIFEST_DESCRIPTION,
        },
        lock_version: found.fixture.draft.lockVersion ?? 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      });
    }

    const index = path.match(/^\/api\/packages\/(@[^/]+)\/([^/]+)\/files$/);
    if (index) {
      const found = find(index[1]!, index[2]!);
      if (!found?.fixture.draft) {
        return json({ code: "not_found", message: "Package not found" }, 404);
      }
      indexReads += 1;
      // `buildFileIndex` shape: sorted entries of { path, size, media_kind },
      // with `inline` carrying the full text of small text files.
      const entries = Object.entries(draftEntries(found))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([entryPath, entry]) => ({
          path: entryPath,
          size: encoder.encode(entry.text).byteLength,
          media_kind: "text",
          ...(entry.inline ? { inline: entry.text } : {}),
        }));
      return json({ entries }, 200, { ETag: `"${found.fixture.draft.etag ?? "idx-1"}"` });
    }

    const content = path.match(/^\/api\/packages\/(@[^/]+)\/([^/]+)\/files\/content$/);
    if (content) {
      const found = find(content[1]!, content[2]!);
      const wanted = url.searchParams.get("path") ?? "";
      const entry = found?.fixture.draft ? draftEntries(found)[wanted] : undefined;
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
    imports: () => imports,
    publishes: () => publishes,
  };
}

function draftSkillMd(p: Prepared): string {
  return p.fixture.draft?.skillMd ?? p.fixture.skillMd;
}

/** Flat map of every draft entry, and whether the index inlines its text. */
function draftEntries(p: Prepared): Record<string, { text: string; inline: boolean }> {
  const draft = p.fixture.draft!;
  const out: Record<string, { text: string; inline: boolean }> = {
    "manifest.json": {
      text: JSON.stringify({
        afps_version: "0.2",
        type: "skill",
        name: p.fixture.id,
        version: p.version,
        description: MANIFEST_DESCRIPTION,
      }),
      inline: true,
    },
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
