// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  runComposeUpgrade,
  formatComposeUpgradeResult,
  resolveComposeUpgradeDir,
  type ComposeUpgradeDeps,
  type ComposeUpgradeOutcome,
} from "../src/lib/install/compose-upgrade.ts";
import { CODE_DEFAULTS } from "../src/lib/compose-defaults.ts";
import { defaultInstallDir } from "../src/lib/install/project.ts";

/**
 * `appstrate install --upgrade-compose` orchestration (#515). All
 * filesystem effects are injected, so these assert the read → analyze →
 * backup → write sequencing without an install dir on disk.
 */

const MODULES_DEFAULT = CODE_DEFAULTS.MODULES!;
const STALE_LINE = `      - MODULES=\${MODULES:-${MODULES_DEFAULT}}`;

/** Recording deps: capture what was read/backed-up/written. */
function deps(content: string | null) {
  const calls = {
    backedUp: [] as { dir: string; files: string[] }[],
    writes: [] as { path: string; body: string }[],
  };
  const d: ComposeUpgradeDeps = {
    readComposeFile: async () => content,
    backup: async (dir, files) => {
      calls.backedUp.push({ dir, files });
      return files; // pretend all existed and were copied
    },
    writeComposeFile: async (path, body) => {
      calls.writes.push({ path, body });
    },
  };
  return { d, calls };
}

describe("runComposeUpgrade", () => {
  it("reports no-install when the compose file is absent", async () => {
    const { d, calls } = deps(null);
    const out = await runComposeUpgrade("/tmp/nope", d);
    expect(out.status).toBe("no-install");
    expect(out.composePath).toBe("/tmp/nope/docker-compose.yml");
    expect(calls.writes).toHaveLength(0);
    expect(calls.backedUp).toHaveLength(0);
  });

  it("reports clean when there is nothing to strip", async () => {
    const { d, calls } = deps(
      ["    environment:", "      - MODULES", "      - APP_URL"].join("\n"),
    );
    const out = await runComposeUpgrade("/srv/appstrate", d);
    expect(out.status).toBe("clean");
    expect(calls.writes).toHaveLength(0);
    expect(calls.backedUp).toHaveLength(0);
  });

  it("backs up then writes when it strips a stale default", async () => {
    const content = ["    environment:", STALE_LINE, "      - APP_URL"].join("\n");
    const { d, calls } = deps(content);
    const out = await runComposeUpgrade("/srv/appstrate", d);

    expect(out.status).toBe("upgraded");
    expect(out.applied).toHaveLength(1);
    expect(out.applied[0]!.varName).toBe("MODULES");
    expect(out.backupPath).toBe("/srv/appstrate/docker-compose.yml.backup");

    // Backup happens BEFORE the write — assert ordering and content.
    expect(calls.backedUp).toEqual([{ dir: "/srv/appstrate", files: ["docker-compose.yml"] }]);
    expect(calls.writes).toHaveLength(1);
    expect(calls.writes[0]!.path).toBe("/srv/appstrate/docker-compose.yml");
    expect(calls.writes[0]!.body.split("\n")[1]).toBe("      - MODULES");
  });

  it("does not write when a duplicate exists but is not auto-fixable", async () => {
    const content = `      MODULES: \${MODULES:-${MODULES_DEFAULT}}`; // mapping form
    const { d, calls } = deps(content);
    const out = await runComposeUpgrade("/srv/appstrate", d);
    expect(out.status).toBe("refused-only");
    expect(out.refused).toHaveLength(1);
    expect(calls.writes).toHaveLength(0);
    expect(calls.backedUp).toHaveLength(0);
  });

  it("omits backupPath when the backup helper reports nothing copied", async () => {
    const content = STALE_LINE;
    const d: ComposeUpgradeDeps = {
      readComposeFile: async () => content,
      backup: async () => [], // nothing actually existed to copy
      writeComposeFile: async () => {},
    };
    const out = await runComposeUpgrade("/srv/appstrate", d);
    expect(out.status).toBe("upgraded");
    expect(out.backupPath).toBeUndefined();
  });
});

describe("formatComposeUpgradeResult", () => {
  function fmt(o: Partial<ComposeUpgradeOutcome> & { status: ComposeUpgradeOutcome["status"] }) {
    return formatComposeUpgradeResult({
      composePath: "/srv/appstrate/docker-compose.yml",
      applied: [],
      refused: [],
      ...o,
    });
  }

  it("no-install points at --dir", () => {
    const text = fmt({ status: "no-install" });
    expect(text).toContain("No docker-compose.yml found");
    expect(text).toContain("--dir");
  });

  it("clean says already clean", () => {
    expect(fmt({ status: "clean" })).toContain("already clean");
  });

  it("upgraded lists the stripped lines, backup, and restart hint", () => {
    const text = fmt({
      status: "upgraded",
      applied: [
        {
          line: 2,
          varName: "MODULES",
          before: "      - MODULES=${MODULES:-x}",
          after: "      - MODULES",
        },
      ],
      backupPath: "/srv/appstrate/docker-compose.yml.backup",
    });
    expect(text).toContain("stripped 1 stale default");
    expect(text).toContain("MODULES");
    expect(text).toContain(".backup");
    expect(text).toContain("docker compose up -d");
  });

  it("refused-only explains the manual edits", () => {
    const text = fmt({
      status: "refused-only",
      refused: [
        {
          line: 5,
          varName: "MODULES",
          reason: "mapping form",
          raw: "      MODULES: ${MODULES:-x}",
        },
      ],
    });
    expect(text).toContain("none could be auto-fixed");
    expect(text).toContain("line 5");
  });
});

describe("resolveComposeUpgradeDir", () => {
  it("defaults to the standard install dir", () => {
    expect(resolveComposeUpgradeDir(undefined)).toBe(defaultInstallDir());
  });

  it("resolves an explicit --dir to absolute", () => {
    expect(resolveComposeUpgradeDir("/srv/appstrate")).toBe("/srv/appstrate");
  });
});
