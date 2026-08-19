// SPDX-License-Identifier: Apache-2.0

/**
 * System-package conformance harness — CLI entrypoint.
 *
 *   bun scripts/conformance/run.ts [--tier gate|mcp|all] [--pkg <substr>] [--dir <path>]
 *
 * Tiers:
 *   - gate  (default) — deterministic, no network/credentials. Local MCP-server
 *                       tool parity. Wired into `bun run check`.
 *   - mcp             — gate + remote MCP parity + OAuth AS-metadata conformance
 *                       + identity-endpoint liveness (network, no credentials).
 *   - all             — every check including auth-liveness.
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
import { checkOAuthMetadata } from "./oauth-metadata.ts";
import {
  checkRefreshStrategy,
  checkUnverifiedBacklog,
  checkBacklogCeiling,
} from "./refresh-strategy.ts";
import { checkIdentityEndpoints } from "./identity-endpoint.ts";
import { AUTH_PROBES } from "./probes.ts";
import { credentialedCount } from "./creds.ts";
import { formatReport, exitCode, type Summary, summarize } from "./report.ts";
import type { Finding } from "./types.ts";

type Tier = "gate" | "mcp" | "all";

interface Args {
  tier: Tier;
  pkg?: string;
  dir: string;
  snapshotOut?: string;
}

function parseArgs(argv: string[]): Args {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i !== -1 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const snapshotOut = flag("--snapshot-out");
  // Snapshotting the live tool surface requires hitting the remote servers →
  // force the mcp tier unless the caller asked for a broader one.
  const tierRaw = flag("--tier") ?? (snapshotOut ? "mcp" : "gate");
  const tier: Tier = tierRaw === "mcp" || tierRaw === "all" ? tierRaw : "gate";
  // Default to the built archives under the repo root (scripts/conformance → ../../system-packages).
  const dir = flag("--dir") ?? join(import.meta.dir, "../../system-packages");
  return { tier, pkg: flag("--pkg"), dir, snapshotOut };
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
  // AS-metadata conformance needs the network but no credentials, so it rides
  // with `mcp` rather than waiting for the credentialed `all` tier.
  const runOAuthMetadata = runRemote;

  let credIntegrations = 0;
  for (const { entry, klass } of selected) {
    if (klass === "mcp-server-local") {
      findings.push(...(await checkMcpLocalParity(entry)));
    } else if (klass === "mcp-remote" && runRemote) {
      findings.push(...(await checkMcpRemoteParity(entry, { snapshotDir: args.snapshotOut })));
    } else if (klass === "integration-cred") {
      credIntegrations++;
      if (runAuthLive) findings.push(...(await checkAuthLiveness(entry)));
    }
    // Deterministic, credential-free, network-free → every tier, including
    // `gate`. Whether an oauth2 auth can keep its connection alive is decided
    // entirely by what the manifest declares.
    if (klass !== "mcp-server-local" && klass !== "other") {
      findings.push(...checkRefreshStrategy(entry));
    }

    // Manifest-declared OAuth surface, checked for every integration class —
    // a remote MCP integration declares an `issuer` and a credential-only one
    // declares explicit endpoints, and both are transcribed by hand.
    if (runOAuthMetadata && klass !== "mcp-server-local" && klass !== "other") {
      findings.push(...(await checkOAuthMetadata(entry)));
      // Credential-free: a bogus bearer must be rejected. Catches a
      // `userinfo_endpoint` that has been renamed or retired, which otherwise
      // degrades connections to accountId "default" in silence.
      findings.push(...(await checkIdentityEndpoints(entry)));
    }
  }

  // Only meaningful over the full set: with `--pkg` every entry outside the
  // filter would read as stale.
  if (!args.pkg) {
    findings.push(...checkUnverifiedBacklog(selected.map((p) => p.entry)));
    findings.push(...checkBacklogCeiling());
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
