// SPDX-License-Identifier: Apache-2.0

/**
 * `requirePublishedArchive` — the gate for readers that take a published
 * version's files through `getVersionDetail` (run doors, version detail,
 * restore, published package detail). A published version whose ZIP is
 * missing or unreadable, or whose archive lacks the type's REQUIRED content
 * entry, is refused with a 422 `version_artifact_unavailable` rather than
 * degrading into an empty prompt or an empty draft. An OPTIONAL entry
 * (integration) or a type with no entry (mcp-server) is not a refusal. Readers
 * that download the ZIP themselves (bundle export, file explorer, download,
 * fork) raise the same refusal through `versionArtifactUnavailable` instead.
 */

import { describe, it, expect } from "bun:test";
import { ApiError } from "../../../src/lib/errors.ts";
import { requirePublishedArchive } from "../../../src/services/package-versions.ts";

const enc = (s: string) => new TextEncoder().encode(s);

function refusal(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    return err as ApiError;
  }
  throw new Error("expected requirePublishedArchive to throw");
}

describe("requirePublishedArchive", () => {
  it("refuses a version whose archive cannot be read", () => {
    const err = refusal(() =>
      requirePublishedArchive("agent", "@acme/bot", { version: "1.0.0", content: null }),
    );
    expect(err.status).toBe(422);
    expect(err.code).toBe("version_artifact_unavailable");
    expect(err.message).toBe("Published '@acme/bot@1.0.0' has no readable archive");
  });

  it.each([
    ["agent", "prompt.md"],
    ["skill", "SKILL.md"],
  ] as const)("refuses a %s archive missing its required %s", (type, path) => {
    const err = refusal(() =>
      requirePublishedArchive(type, "@acme/pkg", {
        version: "2.1.0",
        content: { "manifest.json": enc("{}") },
      }),
    );
    expect(err.status).toBe(422);
    expect(err.code).toBe("version_artifact_unavailable");
    expect(err.message).toBe(
      `Published '@acme/pkg@2.1.0' has no readable '${path}' in its archive`,
    );
  });

  it("accepts an integration archive without its optional INTEGRATION.md", () => {
    const files = { "manifest.json": enc("{}") };
    const out = requirePublishedArchive("integration", "@acme/api", {
      version: "1.0.0",
      content: files,
    });
    expect(out.files).toEqual(files);
    expect(out.entry).toBeUndefined();
  });

  it("returns an integration's INTEGRATION.md when present", () => {
    const doc = enc("# Guide");
    const out = requirePublishedArchive("integration", "@acme/api", {
      version: "1.0.0",
      content: { "manifest.json": enc("{}"), "INTEGRATION.md": doc },
    });
    expect(out.entry).toEqual(doc);
  });

  it("has no entry for an mcp-server", () => {
    const files = { "manifest.json": enc("{}"), "prompt.md": enc("ignored") };
    const out = requirePublishedArchive("mcp-server", "@acme/mcp", {
      version: "1.0.0",
      content: files,
    });
    expect(out.files).toEqual(files);
    expect(out.entry).toBeUndefined();
  });

  it.each([
    ["agent", "prompt.md"],
    ["skill", "SKILL.md"],
  ] as const)("returns the %s's %s bytes and every file", (type, path) => {
    const body = enc(`body of ${path}`);
    const files = { "manifest.json": enc("{}"), [path]: body };
    const out = requirePublishedArchive(type, "@acme/pkg", { version: "1.0.0", content: files });
    expect(out.entry).toEqual(body);
    expect(out.files).toEqual(files);
  });
});
