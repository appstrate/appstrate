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
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync } from "node:fs";
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
  let tmpHome: string;

  beforeEach(() => {
    tmpBin = mkdtempSync(`${tmpdir()}/bootstrap-test-`);
    tmpHome = mkdtempSync(`${tmpdir()}/bootstrap-home-`);
  });

  afterEach(() => {
    rmSync(tmpBin, { recursive: true, force: true });
    rmSync(tmpHome, { recursive: true, force: true });
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

  describe("_setup_path (issue #527 — bash login-shell rc precedence)", () => {
    // Drive the extracted rc-file writer in isolation. We point HOME at a
    // throwaway dir, force a bash SHELL, and clear the CI / opt-out env so
    // the writer actually runs (in real CI runs `CI=true` short-circuits it,
    // which is precisely why this path had no coverage when #527 shipped).
    function runSetupPath(extraSetup = ""): Promise<ShellResult> {
      const body = `
export HOME="${tmpHome}"
export SHELL=/bin/bash
unset CI
unset APPSTRATE_NO_MODIFY_PATH
BIN_DIR="${tmpHome}/.local/bin"
${extraSetup}
_setup_path
`;
      return runShell(body, tmpBin);
    }

    const marker = "# added by appstrate installer";

    it("does NOT create ~/.bash_profile when only ~/.bashrc exists", async () => {
      // The exact #527 repro: a server with ~/.bashrc and no ~/.bash_profile.
      writeFileSync(`${tmpHome}/.bashrc`, "# user config\n");

      const res = await runSetupPath();

      expect(res.exitCode).toBe(0);
      // The regression: a freshly created ~/.bash_profile would be read at
      // login INSTEAD of ~/.profile/~/.bashrc, shadowing the user's config.
      expect(existsSync(`${tmpHome}/.bash_profile`)).toBe(false);
      // PATH still lands in the files a login + interactive bash will read.
      expect(readFileSync(`${tmpHome}/.bashrc`, "utf8")).toContain(marker);
      expect(existsSync(`${tmpHome}/.profile`)).toBe(true);
      expect(readFileSync(`${tmpHome}/.profile`, "utf8")).toContain(marker);
    });

    it("appends to ~/.bash_profile when it already exists", async () => {
      // If the user already manages a ~/.bash_profile, it's the canonical
      // login file — appending there is correct and expected.
      writeFileSync(`${tmpHome}/.bashrc`, "# user config\n");
      writeFileSync(`${tmpHome}/.bash_profile`, "# pre-existing login config\n");

      const res = await runSetupPath();

      expect(res.exitCode).toBe(0);
      const profile = readFileSync(`${tmpHome}/.bash_profile`, "utf8");
      expect(profile).toContain("# pre-existing login config");
      expect(profile).toContain(marker);
    });

    it("writes ~/.profile and ~/.bashrc on a pristine HOME but never ~/.bash_profile", async () => {
      const res = await runSetupPath();

      expect(res.exitCode).toBe(0);
      expect(existsSync(`${tmpHome}/.bash_profile`)).toBe(false);
      expect(readFileSync(`${tmpHome}/.profile`, "utf8")).toContain(marker);
      expect(readFileSync(`${tmpHome}/.bashrc`, "utf8")).toContain(marker);
    });

    it("is idempotent — re-running does not duplicate the PATH line", async () => {
      writeFileSync(`${tmpHome}/.bashrc`, "# user config\n");

      await runSetupPath();
      await runSetupPath();

      const occurrences = readFileSync(`${tmpHome}/.bashrc`, "utf8").split(marker).length - 1;
      expect(occurrences).toBe(1);
    });

    it("a login shell gains BIN_DIR AND still loads the user's ~/.bashrc (end-to-end)", async () => {
      // Mimic a stock Debian/Ubuntu home: ~/.profile chains to ~/.bashrc,
      // and ~/.bashrc carries the user's real config. This is the exact
      // arrangement #527 broke — the installer's stray ~/.bash_profile would
      // win at login and never reach this chain.
      writeFileSync(
        `${tmpHome}/.profile`,
        'if [ -r "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi\n',
      );
      writeFileSync(`${tmpHome}/.bashrc`, "export USER_CONFIG=present\n");

      const setup = await runSetupPath();
      expect(setup.exitCode).toBe(0);
      expect(existsSync(`${tmpHome}/.bash_profile`)).toBe(false);

      // Launch a real bash LOGIN shell with a clean environment so only the
      // rc files under tmpHome decide PATH + exported vars.
      const proc = Bun.spawn(
        [
          "/usr/bin/env",
          "-i",
          `HOME=${tmpHome}`,
          "PATH=/usr/bin:/bin",
          "/bin/bash",
          "-l",
          "-c",
          'printf "PATH=%s\\nCFG=%s\\n" "$PATH" "${USER_CONFIG:-}"',
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      await proc.exited;
      const out = await new Response(proc.stdout).text();

      // PATH picked up the installed bin dir …
      expect(out).toContain(`${tmpHome}/.local/bin`);
      // … AND the user's pre-existing config survived (the #527 guarantee).
      expect(out).toContain("CFG=present");
    });
  });
});
