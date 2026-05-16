// SPDX-License-Identifier: Apache-2.0
//
// Unit tests for the bash functions in scripts/bootstrap.sh.
//
// The script wraps all of its body in `_appstrate_bootstrap` and invokes it
// at the very bottom — a guard against partial `curl … | bash` execution.
// To exercise nested helpers in isolation, we set
// `APPSTRATE_BOOTSTRAP_SOURCE_ONLY=1` before sourcing: the wrapper still
// runs, defines every nested function (bash promotes nested function bodies
// to global scope as soon as the enclosing function executes), and then
// returns before any network/install side effects.
//
// Per-test we manufacture a temp `PATH` with fake package-manager shims
// (e.g. `brew`) whose behaviour we control byte-for-byte. This lets us
// reproduce the unlinked-keg scenario from issue #479 deterministically on
// any host — no Homebrew install required.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resolve } from "node:path";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const SCRIPT = resolve(import.meta.dir, "../../../../scripts/bootstrap.sh");

interface ShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runShell(body: string, binDir: string): Promise<ShellResult> {
  // `set +e` after sourcing — bootstrap.sh runs `set -euo pipefail`, which
  // would abort the test shell on the first non-zero return inside a
  // helper. Tests assert on exit codes explicitly, so we relax that here.
  const script = `
APPSTRATE_BOOTSTRAP_SOURCE_ONLY=1 source "${SCRIPT}"
set +e
${body}
`;
  // PATH composition: the per-test bin dir comes first (fake package
  // manager shims win lookup), followed by /usr/bin:/bin for system
  // utilities the script itself relies on at source time (uname, tr,
  // mktemp, dirname, basename). Notably absent: /opt/homebrew/bin,
  // /usr/local/bin — so a dev mac with brew installed doesn't leak a
  // real brew into "no manager available" assertions.
  const path = `${binDir}:/usr/bin:/bin`;
  // Absolute path to bash so the launch itself doesn't depend on PATH.
  const proc = Bun.spawn(["/bin/bash", "-c", script], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PATH: path },
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr };
}

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

describe("scripts/bootstrap.sh", () => {
  let tmpBin: string;

  beforeEach(() => {
    tmpBin = mkdtempSync(`${tmpdir()}/bootstrap-test-`);
  });

  afterEach(() => {
    rmSync(tmpBin, { recursive: true, force: true });
  });

  describe("try_install_minisign (issue #479 — Homebrew unlinked-keg recovery)", () => {
    it("recovers from unlinked-keg state by calling `brew link`", async () => {
      // Fake brew mimics the bug from #479: `install` exits 0 with the
      // "already installed but not linked" warning, leaving minisign off
      // PATH. `link` materialises the binary, mirroring symlink restore.
      writeExecutable(
        `${tmpBin}/brew`,
        `#!/bin/bash
case "$1" in
  install)
    echo "Warning: minisign 0.12 is already installed, it's just not linked." >&2
    exit 0
    ;;
  link)
    cat > "${tmpBin}/minisign" <<'INNER'
#!/bin/bash
exit 0
INNER
    chmod +x "${tmpBin}/minisign"
    exit 0
    ;;
esac
exit 1
`,
      );

      const res = await runShell(`OS=darwin try_install_minisign && echo OK || echo FAIL`, tmpBin);

      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("brew link minisign");
      expect(res.stdout).toContain("OK");
      expect(res.stdout).not.toContain("FAIL");
    });

    it("succeeds without invoking `brew link` on the happy path", async () => {
      // Brew install materialises minisign directly — no recovery needed.
      writeExecutable(
        `${tmpBin}/brew`,
        `#!/bin/bash
if [ "$1" = "install" ]; then
  cat > "${tmpBin}/minisign" <<'INNER'
#!/bin/bash
exit 0
INNER
  chmod +x "${tmpBin}/minisign"
  exit 0
fi
echo "fake brew: unexpected subcommand $1" >&2
exit 1
`,
      );

      const res = await runShell(`OS=darwin try_install_minisign && echo OK || echo FAIL`, tmpBin);

      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("OK");
      // The recovery path must stay dormant when install already worked.
      expect(res.stdout).not.toContain("brew link minisign");
    });

    it("surfaces a clear error when `brew install` exits non-zero", async () => {
      writeExecutable(
        `${tmpBin}/brew`,
        `#!/bin/bash
echo "Error: simulated brew failure" >&2
exit 1
`,
      );

      const res = await runShell(`OS=darwin try_install_minisign && echo OK || echo FAIL`, tmpBin);

      expect(res.stdout).toContain("FAIL");
      expect(res.stderr).toContain("Failed to install minisign");
    });

    it("falls back to the legacy error when even `brew link` cannot restore the binary", async () => {
      // Pathological case: install reports unlinked, link also fails. The
      // recovery attempt should fire (logged) but the final guard should
      // still surface the misleading-success diagnostic.
      writeExecutable(
        `${tmpBin}/brew`,
        `#!/bin/bash
case "$1" in
  install)
    echo "Warning: minisign 0.12 is already installed, it's just not linked." >&2
    exit 0
    ;;
  link)
    echo "Error: simulated link failure" >&2
    exit 1
    ;;
esac
exit 1
`,
      );

      const res = await runShell(`OS=darwin try_install_minisign && echo OK || echo FAIL`, tmpBin);

      expect(res.stdout).toContain("FAIL");
      expect(res.stdout).toContain("brew link minisign");
      expect(res.stderr).toContain("install reported success but the binary is still not on PATH");
    });

    it("returns failure when no supported package manager is on PATH", async () => {
      // OS=darwin so detection only probes for `brew`. On a Linux CI box,
      // `/usr/bin/apt-get` would otherwise match (we always include
      // /usr/bin:/bin so the script's own setup helpers — uname, tr — can
      // resolve). brew is never preinstalled at /usr/bin, so this stays
      // deterministic on macOS and Linux alike.
      const res = await runShell(`OS=darwin try_install_minisign && echo OK || echo FAIL`, tmpBin);

      expect(res.stdout).toContain("FAIL");
    });
  });

  describe("detect_minisign_installer", () => {
    it("returns 'brew' on darwin when brew is on PATH", async () => {
      writeExecutable(`${tmpBin}/brew`, `#!/bin/bash\nexit 0\n`);

      const res = await runShell(`OS=darwin detect_minisign_installer`, tmpBin);

      expect(res.exitCode).toBe(0);
      expect(res.stdout.trim()).toBe("brew");
    });

    it("returns 'apt' on linux when apt-get is on PATH", async () => {
      writeExecutable(`${tmpBin}/apt-get`, `#!/bin/bash\nexit 0\n`);

      const res = await runShell(`OS=linux detect_minisign_installer`, tmpBin);

      expect(res.exitCode).toBe(0);
      expect(res.stdout.trim()).toBe("apt");
    });

    it("returns non-zero when no supported manager is available", async () => {
      // OS=darwin keeps detection scoped to `brew` — never present at
      // /usr/bin on either macOS or Linux. OS=linux would false-positive
      // on Ubuntu CI where /usr/bin/apt-get exists.
      const res = await runShell(
        `OS=darwin detect_minisign_installer && echo OK || echo FAIL`,
        tmpBin,
      );

      expect(res.stdout).toContain("FAIL");
    });
  });

  describe("minisign_install_cmd", () => {
    it("emits the bare brew command (no sudo on macOS)", async () => {
      const res = await runShell(`minisign_install_cmd brew`, tmpBin);

      expect(res.exitCode).toBe(0);
      expect(res.stdout.trim()).toBe("brew install minisign");
    });

    it("returns non-zero for an unknown manager", async () => {
      const res = await runShell(
        `minisign_install_cmd unknown-mgr && echo OK || echo FAIL`,
        tmpBin,
      );

      expect(res.stdout).toContain("FAIL");
    });
  });
});
