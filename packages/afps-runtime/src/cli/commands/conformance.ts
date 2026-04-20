// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { parseArgs } from "node:util";
import {
  createDefaultAdapter,
  formatReport,
  runConformance,
  type ConformanceLevel,
} from "../../conformance/index.ts";
import type { CliIO } from "../index.ts";

const HELP = `afps conformance — run the AFPS conformance suite

Usage:
  afps conformance [--levels L1,L2,L3] [--only L1.1,L3.4] [--json]

Options:
  --levels <list>   Comma-separated level filter (default: all built-in)
  --only <list>     Comma-separated case IDs (takes precedence over --levels)
  --json            Emit the report as a single JSON document

Exit codes:
  0   all selected cases passed
  1   one or more cases failed
  2   usage error

Level 4 (execution → event stream) ships in Phase 10 alongside the Pi
SDK integration.
`;

const ALL_LEVELS: readonly ConformanceLevel[] = ["L1", "L2", "L3"];

export async function run(argv: readonly string[], io: CliIO): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        levels: { type: "string" },
        only: { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (err) {
    io.stderr(`afps conformance: ${(err as Error).message}\n`);
    io.stderr(HELP);
    return 2;
  }
  if (parsed.values.help) {
    io.stdout(HELP);
    return 0;
  }

  let levels: readonly ConformanceLevel[] | undefined;
  if (parsed.values.levels) {
    const requested = parsed.values.levels.split(",").map((s) => s.trim());
    for (const lvl of requested) {
      if (!ALL_LEVELS.includes(lvl as ConformanceLevel)) {
        io.stderr(`afps conformance: unknown level '${lvl}' (valid: ${ALL_LEVELS.join(", ")})\n`);
        return 2;
      }
    }
    levels = requested as ConformanceLevel[];
  }

  const only = parsed.values.only ? parsed.values.only.split(",").map((s) => s.trim()) : undefined;

  const adapter = createDefaultAdapter();
  const report = await runConformance(adapter, { levels, only });

  if (parsed.values.json) {
    io.stdout(JSON.stringify(report, null, 2) + "\n");
  } else {
    io.stdout(formatReport(report));
  }
  return report.summary.failed === 0 ? 0 : 1;
}
