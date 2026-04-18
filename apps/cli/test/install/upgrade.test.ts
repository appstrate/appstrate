// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `lib/install/upgrade.ts`.
 *
 * These cover the safety-critical upgrade path:
 *   - mode detection (fresh vs upgrade, with any combination of
 *     `.env` / `docker-compose.yml` present),
 *   - `.env` parsing (ignore comments, blanks, quote stripping,
 *     garbage-key rejection),
 *   - merge semantics (existing wins for every collision — secrets
 *     must never rotate on a re-run),
 *   - backup + restore round-trip (file identity preserved byte-for-
 *     byte, no timestamp accumulation),
 *   - atomic replace (the `.tmp` sibling is renamed, not left behind).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, platform } from "node:os";
import {
  detectInstallMode,
  parseEnvFile,
  mergeEnv,
  backupFiles,
  restoreBackups,
  cleanupBackups,
  atomicReplace,
  runWithRollback,
} from "../../src/lib/install/upgrade.ts";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "appstrate-cli-upgrade-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("detectInstallMode", () => {
  it("reports 'fresh' on an empty directory", async () => {
    const { mode, existing } = await detectInstallMode(workDir);
    expect(mode).toBe("fresh");
    expect(existing.hasEnv).toBe(false);
    expect(existing.hasCompose).toBe(false);
    expect(existing.existingEnv).toEqual({});
  });

  it("reports 'upgrade' when only .env is present", async () => {
    await writeFile(join(workDir, ".env"), "BETTER_AUTH_SECRET=keep-me\n");
    const { mode, existing } = await detectInstallMode(workDir);
    expect(mode).toBe("upgrade");
    expect(existing.hasEnv).toBe(true);
    expect(existing.hasCompose).toBe(false);
    expect(existing.existingEnv).toEqual({ BETTER_AUTH_SECRET: "keep-me" });
  });

  it("reports 'upgrade' when only docker-compose.yml is present (half-installed state)", async () => {
    await writeFile(join(workDir, "docker-compose.yml"), "services: {}\n");
    const { mode, existing } = await detectInstallMode(workDir);
    expect(mode).toBe("upgrade");
    expect(existing.hasEnv).toBe(false);
    expect(existing.hasCompose).toBe(true);
  });

  it("reports 'upgrade' when both are present (typical re-run)", async () => {
    await writeFile(
      join(workDir, ".env"),
      "BETTER_AUTH_SECRET=keep\nCONNECTION_ENCRYPTION_KEY=dont-rotate\n",
    );
    await writeFile(join(workDir, "docker-compose.yml"), "services: {}\n");
    const { mode, existing } = await detectInstallMode(workDir);
    expect(mode).toBe("upgrade");
    expect(existing.existingEnv.BETTER_AUTH_SECRET).toBe("keep");
    expect(existing.existingEnv.CONNECTION_ENCRYPTION_KEY).toBe("dont-rotate");
  });

  it("degrades gracefully if .env is unreadable (directory, not a file)", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(workDir, ".env"));
    const { mode, existing } = await detectInstallMode(workDir);
    // `.env` exists (as a dir) → upgrade path, but existingEnv is empty.
    expect(mode).toBe("upgrade");
    expect(existing.hasEnv).toBe(true);
    expect(existing.existingEnv).toEqual({});
  });
});

describe("parseEnvFile", () => {
  it("parses plain KEY=value lines", () => {
    const out = parseEnvFile("FOO=bar\nBAZ=qux\n");
    expect(out).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("ignores # comments and blank lines", () => {
    const body = "# top-level header\n\nFOO=bar\n  # indented comment\n\nBAZ=qux\n";
    expect(parseEnvFile(body)).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("strips surrounding single or double quotes from values", () => {
    const body = `SINGLE='v1'\nDOUBLE="v2"\nUNQUOTED=v3\n`;
    expect(parseEnvFile(body)).toEqual({ SINGLE: "v1", DOUBLE: "v2", UNQUOTED: "v3" });
  });

  it("treats an '=' inside the value as part of the value (only the first '=' is the separator)", () => {
    // base64 passwords contain `=` padding — must not be mis-split.
    const out = parseEnvFile("CONNECTION_ENCRYPTION_KEY=AAAAAAAAAAAAAAAA=\n");
    expect(out.CONNECTION_ENCRYPTION_KEY).toBe("AAAAAAAAAAAAAAAA=");
  });

  it("rejects keys that don't match the [A-Za-z_][A-Za-z0-9_]* identifier shape", () => {
    const body = "1FOO=bad\nMY-KEY=also-bad\nGOOD=ok\n";
    expect(parseEnvFile(body)).toEqual({ GOOD: "ok" });
  });

  it("handles CRLF line endings", () => {
    expect(parseEnvFile("FOO=bar\r\nBAZ=qux\r\n")).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("returns an empty dict for empty or whitespace-only input", () => {
    expect(parseEnvFile("")).toEqual({});
    expect(parseEnvFile("\n\n  \n")).toEqual({});
  });
});

describe("mergeEnv", () => {
  it("existing values always win over fresh values (secrets must not rotate)", () => {
    const existing = {
      BETTER_AUTH_SECRET: "existing-secret",
      CONNECTION_ENCRYPTION_KEY: "existing-key",
    };
    const fresh = {
      BETTER_AUTH_SECRET: "newly-generated-secret",
      CONNECTION_ENCRYPTION_KEY: "newly-generated-key",
    };
    expect(mergeEnv(existing, fresh)).toEqual({
      BETTER_AUTH_SECRET: "existing-secret",
      CONNECTION_ENCRYPTION_KEY: "existing-key",
    });
  });

  it("fresh keys that are new (tier 1 → tier 3 adds MINIO_*) are added", () => {
    const existing = { BETTER_AUTH_SECRET: "x", POSTGRES_PASSWORD: "p" };
    const fresh = {
      BETTER_AUTH_SECRET: "should-be-ignored",
      POSTGRES_PASSWORD: "also-ignored",
      MINIO_ROOT_PASSWORD: "new-on-tier-3",
      S3_BUCKET: "appstrate",
    };
    const out = mergeEnv(existing, fresh);
    expect(out.BETTER_AUTH_SECRET).toBe("x");
    expect(out.POSTGRES_PASSWORD).toBe("p");
    expect(out.MINIO_ROOT_PASSWORD).toBe("new-on-tier-3");
    expect(out.S3_BUCKET).toBe("appstrate");
  });

  it("user-added keys not in fresh are preserved (SMTP_HOST stays)", () => {
    const existing = { BETTER_AUTH_SECRET: "x", SMTP_HOST: "smtp.example.com" };
    const fresh = { BETTER_AUTH_SECRET: "y", POSTGRES_PASSWORD: "p" };
    const out = mergeEnv(existing, fresh);
    expect(out.SMTP_HOST).toBe("smtp.example.com");
    expect(out.POSTGRES_PASSWORD).toBe("p");
    expect(out.BETTER_AUTH_SECRET).toBe("x");
  });

  it("returns a new object (doesn't mutate either input)", () => {
    const existing = { A: "1" };
    const fresh = { B: "2" };
    const out = mergeEnv(existing, fresh);
    expect(out).not.toBe(existing);
    expect(out).not.toBe(fresh);
    expect(existing).toEqual({ A: "1" });
    expect(fresh).toEqual({ B: "2" });
  });

  it("APPSTRATE_VERSION ALWAYS takes the fresh value, even when existing has one", () => {
    // Lockstep invariant (ADR-006): the Docker image tag must track the
    // CLI that orchestrates it. Preserving an existing APPSTRATE_VERSION
    // would leave a CLI-upgraded install pointing at the old images.
    const existing = {
      APPSTRATE_VERSION: "1.0.0-alpha.50",
      BETTER_AUTH_SECRET: "keep-me",
    };
    const fresh = {
      APPSTRATE_VERSION: "1.0.0-alpha.52",
      BETTER_AUTH_SECRET: "rotated-would-break-sessions",
    };
    const out = mergeEnv(existing, fresh);
    expect(out.APPSTRATE_VERSION).toBe("1.0.0-alpha.52"); // fresh wins
    expect(out.BETTER_AUTH_SECRET).toBe("keep-me"); // existing wins
  });

  it("APPSTRATE_VERSION in existing alone is preserved when fresh omits it", () => {
    // If fresh didn't set the key (e.g. a future tier-0 upgrade path),
    // we don't want to blow away what was there — the overlay only
    // triggers when `fresh` has a non-undefined value.
    const existing = { APPSTRATE_VERSION: "1.0.0-alpha.50" };
    const fresh = {};
    expect(mergeEnv(existing, fresh).APPSTRATE_VERSION).toBe("1.0.0-alpha.50");
  });
});

describe("backupFiles + restoreBackups", () => {
  it("round-trips byte-for-byte including 0600 mode and secret content", async () => {
    const envBody = "BETTER_AUTH_SECRET=abc\nMINIO_ROOT_PASSWORD=def\n";
    await writeFile(join(workDir, ".env"), envBody, { mode: 0o600 });
    await writeFile(join(workDir, "docker-compose.yml"), "services:\n  postgres: {}\n");

    const backedUp = await backupFiles(workDir, [".env", "docker-compose.yml"]);
    expect(backedUp).toEqual([".env", "docker-compose.yml"]);

    // Overwrite the originals with garbage.
    await writeFile(join(workDir, ".env"), "WIPED=yes\n");
    await writeFile(join(workDir, "docker-compose.yml"), "services: {}\n");

    await restoreBackups(workDir, backedUp);

    const restoredEnv = await readFile(join(workDir, ".env"), "utf8");
    const restoredCompose = await readFile(join(workDir, "docker-compose.yml"), "utf8");
    expect(restoredEnv).toBe(envBody);
    expect(restoredCompose).toBe("services:\n  postgres: {}\n");
  });

  it("skips files that don't exist (half-installed dir)", async () => {
    // Only .env exists; compose is missing.
    await writeFile(join(workDir, ".env"), "X=1\n");
    const backedUp = await backupFiles(workDir, [".env", "docker-compose.yml"]);
    expect(backedUp).toEqual([".env"]);
  });

  it("uses a single .backup suffix — never accumulates timestamped files", async () => {
    await writeFile(join(workDir, ".env"), "X=1\n");
    await backupFiles(workDir, [".env"]);
    await backupFiles(workDir, [".env"]);
    const entries = await readdir(workDir);
    // One original + one backup — no .backup.2025-… proliferation.
    expect(entries.sort()).toEqual([".env", ".env.backup"]);
  });

  it("is a no-op on restore when no backups were taken", async () => {
    await restoreBackups(workDir, []);
    // Just assert no throw — dir is untouched.
    const entries = await readdir(workDir);
    expect(entries).toEqual([]);
  });
});

describe("cleanupBackups", () => {
  it("removes the .backup files after a successful upgrade", async () => {
    await writeFile(join(workDir, ".env"), "X=1\n");
    const backedUp = await backupFiles(workDir, [".env"]);
    expect((await readdir(workDir)).sort()).toEqual([".env", ".env.backup"]);
    await cleanupBackups(workDir, backedUp);
    expect((await readdir(workDir)).sort()).toEqual([".env"]);
  });

  it("swallows missing-file errors (belt-and-braces)", async () => {
    // `.env.backup` never existed — cleanup should still succeed.
    await cleanupBackups(workDir, [".env"]);
  });
});

describe("atomicReplace", () => {
  it("writes the body to the target path", async () => {
    const target = join(workDir, ".env");
    await atomicReplace(target, "FOO=bar\n");
    expect(await readFile(target, "utf8")).toBe("FOO=bar\n");
  });

  it("honours the mode argument", async () => {
    if (platform() === "win32") return;
    const target = join(workDir, ".env");
    await atomicReplace(target, "SECRET=1\n", 0o600);
    const s = await stat(target);
    expect(s.mode & 0o777).toBe(0o600);
  });

  it("does not leave the .tmp sibling behind on success", async () => {
    const target = join(workDir, ".env");
    await atomicReplace(target, "FOO=bar\n");
    const entries = await readdir(workDir);
    expect(entries).toEqual([".env"]);
  });

  it("overwrites an existing target atomically", async () => {
    const target = join(workDir, ".env");
    await writeFile(target, "OLD=1\n");
    await atomicReplace(target, "NEW=1\n");
    expect(await readFile(target, "utf8")).toBe("NEW=1\n");
  });
});

describe("end-to-end upgrade flow (integration)", () => {
  it("preserves BETTER_AUTH_SECRET + CONNECTION_ENCRYPTION_KEY across a re-run", async () => {
    // Simulate the critical invariant: the user ran tier 1 once, then
    // re-runs tier 3. Their session-signing secret and credential-
    // encryption key MUST NOT change.
    const originalEnv = [
      "BETTER_AUTH_SECRET=user-original-session-secret",
      "CONNECTION_ENCRYPTION_KEY=user-original-encryption-key-base64==",
      "POSTGRES_PASSWORD=user-original-db-password",
      "APP_URL=https://my-production.example.com",
    ].join("\n");
    await writeFile(join(workDir, ".env"), originalEnv, { mode: 0o600 });
    await writeFile(join(workDir, "docker-compose.yml"), "# old tier 1 compose\n");

    const { mode, existing } = await detectInstallMode(workDir);
    expect(mode).toBe("upgrade");

    const freshTier3 = {
      BETTER_AUTH_SECRET: "newly-generated-and-MUST-be-ignored",
      CONNECTION_ENCRYPTION_KEY: "newly-generated-and-MUST-be-ignored",
      POSTGRES_PASSWORD: "newly-generated-and-MUST-be-ignored",
      APP_URL: "http://localhost:3000",
      MINIO_ROOT_USER: "appstrate",
      MINIO_ROOT_PASSWORD: "new-minio-password",
      S3_BUCKET: "appstrate",
      S3_REGION: "us-east-1",
    };
    const merged = mergeEnv(existing.existingEnv, freshTier3);

    expect(merged.BETTER_AUTH_SECRET).toBe("user-original-session-secret");
    expect(merged.CONNECTION_ENCRYPTION_KEY).toBe("user-original-encryption-key-base64==");
    expect(merged.POSTGRES_PASSWORD).toBe("user-original-db-password");
    expect(merged.APP_URL).toBe("https://my-production.example.com");
    // New tier 3 keys are introduced.
    expect(merged.MINIO_ROOT_PASSWORD).toBe("new-minio-password");
    expect(merged.S3_BUCKET).toBe("appstrate");
  });

  it("rollback restores the original files byte-for-byte after a failed upgrade", async () => {
    const originalEnv = "BETTER_AUTH_SECRET=orig\nPOSTGRES_PASSWORD=orig-pg\n";
    const originalCompose = "# tier 1\nservices:\n  postgres: {}\n";
    await writeFile(join(workDir, ".env"), originalEnv, { mode: 0o600 });
    await writeFile(join(workDir, "docker-compose.yml"), originalCompose);

    // Simulate the upgrade start: backup, then overwrite.
    const backedUp = await backupFiles(workDir, [".env", "docker-compose.yml"]);
    await writeFile(join(workDir, ".env"), "WIPED=1\n");
    await writeFile(join(workDir, "docker-compose.yml"), "# new tier 3\n");

    // Simulate downstream failure (docker compose up) — rollback.
    await restoreBackups(workDir, backedUp);

    expect(await readFile(join(workDir, ".env"), "utf8")).toBe(originalEnv);
    expect(await readFile(join(workDir, "docker-compose.yml"), "utf8")).toBe(originalCompose);
    // Backups are kept on the rollback path so the user can inspect.
    const entries = await readdir(workDir);
    expect(entries).toContain(".env.backup");
    expect(entries).toContain("docker-compose.yml.backup");
  });
});

describe("runWithRollback", () => {
  // Contract that guards `commands/install.ts::installDockerTier`: a
  // downstream failure (docker compose up, healthcheck timeout, ctrl-C)
  // MUST trigger `restoreBackups` before re-raising, so the user is
  // never left with a half-upgraded config that matches neither the old
  // nor the new stack. Extracting the helper into `upgrade.ts` means
  // the contract is unit-testable — a regression that dropped the
  // try/catch in `installDockerTier` would be caught here, not silently
  // bypassed on the install command's happy path.
  const originalEnv = "BETTER_AUTH_SECRET=keep-me\n";
  const originalCompose = "# tier 1\n";

  beforeEach(async () => {
    await writeFile(join(workDir, ".env"), originalEnv);
    await writeFile(join(workDir, "docker-compose.yml"), originalCompose);
  });

  it("returns the step's value on success and runs onSuccess", async () => {
    const backedUp = await backupFiles(workDir, [".env", "docker-compose.yml"]);
    let onSuccessCalled = false;
    const out = await runWithRollback(
      workDir,
      backedUp,
      async () => {
        await writeFile(join(workDir, ".env"), "REWRITTEN=1\n");
        return "ok";
      },
      async () => {
        onSuccessCalled = true;
      },
    );
    expect(out).toBe("ok");
    expect(onSuccessCalled).toBe(true);
    // Step wrote the new content; onSuccess was called so the files
    // stay at the new state.
    expect(await readFile(join(workDir, ".env"), "utf8")).toBe("REWRITTEN=1\n");
  });

  it("restores backups when the step throws and wraps the error", async () => {
    const backedUp = await backupFiles(workDir, [".env", "docker-compose.yml"]);
    let onSuccessCalled = false;
    await expect(
      runWithRollback(
        workDir,
        backedUp,
        async () => {
          // Mid-upgrade: overwrite both files, then simulate docker
          // compose up failing.
          await writeFile(join(workDir, ".env"), "ROTATED_SECRET=danger\n");
          await writeFile(join(workDir, "docker-compose.yml"), "# wrong tier\n");
          throw new Error("docker compose up failed");
        },
        async () => {
          onSuccessCalled = true;
        },
      ),
    ).rejects.toThrow(/Upgrade failed.*docker compose up failed.*restored from backup/s);

    // onSuccess must NOT have run on the failure path.
    expect(onSuccessCalled).toBe(false);

    // Both files are back to their pre-upgrade content.
    expect(await readFile(join(workDir, ".env"), "utf8")).toBe(originalEnv);
    expect(await readFile(join(workDir, "docker-compose.yml"), "utf8")).toBe(originalCompose);
  });

  it("reports restore failure distinctly so the user can escalate", async () => {
    const backedUp = await backupFiles(workDir, [".env", "docker-compose.yml"]);
    // Delete the backup files so `restoreBackups` itself will fail.
    await rm(join(workDir, ".env.backup"));

    await expect(
      runWithRollback(workDir, backedUp, async () => {
        throw new Error("docker compose up failed");
      }),
    ).rejects.toThrow(/Rollback also failed.*manual recovery/s);
  });

  it("propagates the original error unchanged on fresh installs (no backups)", async () => {
    // Fresh install → backedUp is empty. Any failure should bubble up
    // verbatim; there's nothing to restore and dressing the message up
    // would be misleading ("restored from backup" is false).
    await expect(
      runWithRollback(workDir, [], async () => {
        throw new Error("docker compose up failed");
      }),
    ).rejects.toThrow(/^docker compose up failed$/);
  });
});
