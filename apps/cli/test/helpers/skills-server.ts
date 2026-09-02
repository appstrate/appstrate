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
  /** AFPS manifest `description`. */
  description?: string;
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
        description: fixture.description ?? "A skill.",
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

export function createSkillServer(fixtures: SkillFixture[]): SkillServer {
  const prepared = fixtures.map(prepare);
  let downloads = 0;
  let indexReads = 0;
  let contentReads = 0;
  let inFlight = 0;
  let peakInFlight = 0;

  const stub = async (input: string | URL | Request): Promise<Response> => {
    inFlight += 1;
    peakInFlight = Math.max(peakInFlight, inFlight);
    try {
      // One macrotask of latency, so overlapping requests are observable at
      // all: a stub that answers synchronously never has two in flight and
      // would measure a concurrency cap of 1 as if it were the real one.
      await new Promise((resolve) => setTimeout(resolve, 0));
      return await respond(input);
    } finally {
      inFlight -= 1;
    }
  };

  const respond = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const path = url.pathname;

    if (path === "/api/packages/skills") {
      return json({
        object: "list",
        data: prepared.map((p) => ({
          id: p.fixture.id,
          name: p.name,
          description: p.fixture.description ?? "A skill.",
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
          description: found.fixture.description ?? "A skill.",
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
      return json({
        id: found.fixture.id,
        name: found.name,
        description: found.fixture.description ?? "A skill.",
        content: draftSkillMd(found),
        source: found.fixture.source ?? "local",
        version: found.version,
        manifest: {
          afps_version: "0.2",
          type: "skill",
          name: found.fixture.id,
          version: found.version,
          description: found.fixture.description ?? "A skill.",
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
      const found = prepared.find((p) => p.scope === content[1] && p.name === content[2]);
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
        description: p.fixture.description ?? "A skill.",
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
