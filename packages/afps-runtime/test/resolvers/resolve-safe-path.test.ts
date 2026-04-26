/**
 * Unit tests for {@link resolveSafePath} — the path-safety primitive
 * gating every `{ fromFile }` upload and `responseMode.toFile` download.
 *
 * Covers:
 *  - Workspace-relative paths resolve under the workspace (baseline).
 *  - Absolute paths under `/tmp` are accepted (issue #316).
 *  - Absolute paths outside every allowed root are rejected.
 *  - Parent-traversal escapes (`../`) are rejected from both relative
 *    and absolute starting points.
 *  - Symlink escape (a symlink whose realpath leaves the allowed roots)
 *    is rejected.
 *  - Error messages include the resolved path, allowed roots, and a
 *    self-correcting hint.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveSafePath } from "../../src/resolvers/provider-tool.ts";
import { ResolverError } from "../../src/errors.ts";

// Real `/tmp` may not equal `tmpdir()` on macOS (`/var/folders/...`),
// so the "/tmp is allowed" tests must root themselves under `/tmp`
// directly, not under `tmpdir()`.
const TMP_ROOT = realpathSync("/tmp");

describe("resolveSafePath", () => {
  let workspace: string;
  let outside: string;

  beforeEach(() => {
    workspace = realpathSync(mkdtempSync(join(tmpdir(), "rsp-ws-")));
    outside = realpathSync(mkdtempSync(join(tmpdir(), "rsp-out-")));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  describe("relative paths", () => {
    it("resolves a simple workspace-relative path", async () => {
      writeFileSync(join(workspace, "file.txt"), "hello");
      const resolved = await resolveSafePath(workspace, "file.txt");
      expect(resolved).toBe(join(workspace, "file.txt"));
    });

    it("resolves a non-existent relative path (write target)", async () => {
      const resolved = await resolveSafePath(workspace, "new-file.txt");
      expect(resolved).toBe(join(workspace, "new-file.txt"));
    });

    it("rejects parent-traversal escape", async () => {
      let err: unknown;
      try {
        await resolveSafePath(workspace, "../../../etc/passwd");
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ResolverError);
      expect((err as ResolverError).code).toBe("RESOLVER_PATH_OUTSIDE_WORKSPACE");
    });

    it("rejects empty / non-string paths", async () => {
      let err: unknown;
      try {
        await resolveSafePath(workspace, "");
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ResolverError);
      expect((err as ResolverError).code).toBe("RESOLVER_PATH_INVALID");
    });
  });

  describe("absolute paths under /tmp (issue #316)", () => {
    it("accepts an absolute path under /tmp", async () => {
      // Use the platform-native `/tmp/...` form (not `tmpdir()`, which is
      // `/var/folders/...` on macOS and is NOT an allowed root).
      const tmpDir = realpathSync(mkdtempSync("/tmp/rsp-allow-"));
      try {
        const target = join(tmpDir, "output.xlsx");
        writeFileSync(target, "fake-xlsx");
        const resolved = await resolveSafePath(workspace, target);
        expect(resolved).toBe(target);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("accepts a non-existent absolute path under /tmp (write target)", async () => {
      const tmpDir = realpathSync(mkdtempSync("/tmp/rsp-allow-"));
      try {
        const target = join(tmpDir, "not-yet.xlsx");
        const resolved = await resolveSafePath(workspace, target);
        expect(resolved).toBe(target);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("accepts the canonical /tmp root itself", async () => {
      // realpath /tmp on macOS is /private/tmp; the resolver normalizes,
      // so we pass the platform-native /tmp form and expect the realpath
      // back.
      const resolved = await resolveSafePath(workspace, "/tmp");
      expect(resolved).toBe(TMP_ROOT);
    });
  });

  describe("absolute paths outside allowed roots", () => {
    it("rejects an absolute path outside both workspace and /tmp", async () => {
      // Pick a path that's guaranteed outside both /tmp and the workspace.
      const target = "/etc/passwd";
      let err: unknown;
      try {
        await resolveSafePath(workspace, target);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ResolverError);
      expect((err as ResolverError).code).toBe("RESOLVER_PATH_OUTSIDE_WORKSPACE");
    });

    it("error message names the offender, resolved path, and allowed roots", async () => {
      let err: ResolverError | undefined;
      try {
        await resolveSafePath(workspace, "/etc/passwd");
      } catch (e) {
        err = e as ResolverError;
      }
      expect(err).toBeInstanceOf(ResolverError);
      const msg = err!.message;
      expect(msg).toContain('"/etc/passwd"');
      expect(msg).toContain("/etc/passwd"); // resolved
      expect(msg).toContain("allowed:");
      expect(msg).toContain("/tmp");
      expect(msg).toContain(workspace);
      expect(msg).toContain("hint:");
      // The structured payload also exposes the roots for programmatic use.
      const details = err!.details as { allowedRoots?: string[] } | undefined;
      expect(Array.isArray(details?.allowedRoots)).toBe(true);
      expect(details!.allowedRoots).toEqual(expect.arrayContaining([workspace, TMP_ROOT]));
    });
  });

  describe("symlink escape", () => {
    it("rejects a symlink in the workspace that points outside every root", async () => {
      writeFileSync(join(outside, "secret.txt"), "secret");
      const link = join(workspace, "linky");
      symlinkSync(join(outside, "secret.txt"), link);
      let err: unknown;
      try {
        await resolveSafePath(workspace, "linky");
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ResolverError);
      expect((err as ResolverError).code).toBe("RESOLVER_PATH_OUTSIDE_WORKSPACE");
      expect((err as ResolverError).message).toContain("symlink");
    });

    it("accepts a symlink inside the workspace pointing to /tmp (now an allowed root)", async () => {
      const tmpDir = realpathSync(mkdtempSync("/tmp/rsp-link-"));
      try {
        const target = join(tmpDir, "target.txt");
        writeFileSync(target, "ok");
        const link = join(workspace, "to-tmp");
        symlinkSync(target, link);
        const resolved = await resolveSafePath(workspace, "to-tmp");
        expect(resolved).toBe(target);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
