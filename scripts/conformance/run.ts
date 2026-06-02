// SPDX-License-Identifier: Apache-2.0

/**
 * System-package conformance harness — CLI entrypoint.
 *
 *   bun scripts/conformance/run.ts [--tier gate|mcp|all] [--pkg <substr>] [--dir <path>]
 *
 * Tiers:
 *   - gate  (default) — deterministic, no network/credentials. Local MCP-server
 *                       tool parity. Wired into `bun run check`.
 *   - mcp             — gate + remote MCP parity (Wave 2, requires network/creds).
 *   - all             — every check including auth-liveness (Wave 3).
 *
 * Static manifest validation (scope_catalog ↔ required_scopes, schema, drift)
 * is already enforced by `build:system-packages:check`; the harness does not
 * duplicate it.
 */

import { join } from "node:path";
import { loadClassified } from "./load.ts";
import { checkMcpLocalParity } from "./mcp-local-parity.ts";
import { checkMcpRemoteParity } from "./remote-parity.ts";
import { checkAuthLiveness } from "./auth-live.ts";
import { AUTH_PROBES } from "./probes.ts";
import { credentialedCount } from "./creds.ts";
import { formatReport, exitCode, type Summary, summarize } from "./report.ts";
import type { Finding } from "./types.ts";

type Tier = "gate" | "mcp" | "all";

interface Args {
  tier: Tier;
  pkg?: string;
  dir: string;
}

function parseArgs(argv: string[]): Args {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i !== -1 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const tierRaw = flag("--tier") ?? "gate";
  const tier: Tier = tierRaw === "mcp" || tierRaw === "all" ? tierRaw : "gate";
  // Default to the built archives under the repo root (scripts/conformance → ../../system-packages).
  const dir = flag("--dir") ?? join(import.meta.dir, "../../system-packages");
  return { tier, pkg: flag("--pkg"), dir };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { packages, warnings } = await loadClassified(args.dir);

  const findings: Finding[] = warnings.map((w) => ({
    packageId: w.file,
    check: "load",
    severity: "fail" as const,
    message: `could not load archive: ${w.error}`,
  }));

  const selected = packages.filter((p) => !args.pkg || p.entry.packageId.includes(args.pkg));

  // Tier gating. `gate` is deterministic + credential-free (local MCP parity);
  // `mcp` adds the network-bound remote handler; `all` also runs auth-liveness
  // for credential-only integrations.
  const runRemote = args.tier === "mcp" || args.tier === "all";
  const runAuthLive = args.tier === "all";

  let credIntegrations = 0;
  for (const { entry, klass } of selected) {
    if (klass === "mcp-server-local") {
      findings.push(...(await checkMcpLocalParity(entry)));
    } else if (klass === "mcp-remote" && runRemote) {
      findings.push(...(await checkMcpRemoteParity(entry)));
    } else if (klass === "integration-cred") {
      credIntegrations++;
      if (runAuthLive) findings.push(...(await checkAuthLiveness(entry)));
    }
  }

  console.log(formatReport(findings));

  const summary: Summary = summarize(findings);
  if (runRemote) {
    console.log(`[conformance] remote credentials configured: ${credentialedCount()}`);
  }
  if (runAuthLive) {
    console.log(
      `[conformance] auth-liveness: ${Object.keys(AUTH_PROBES).length} probes defined, ${credIntegrations} credential-only integrations (uncovered are skipped silently)`,
    );
  }
  console.log(
    `\n[conformance] tier=${args.tier} packages=${selected.length} → ${summary.ok ? "PASS" : "FAIL"}`,
  );
  process.exit(exitCode(findings));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
