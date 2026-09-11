// SPDX-License-Identifier: Apache-2.0

/**
 * `appstrate doctor` — list every appstrate binary on $PATH.
 *
 * Issue #249, phase 3. This command file is the thin I/O wrapper —
 * `lib/doctor.ts` owns the algorithm + formatting so tests can assert on
 * the rendered output without touching commander or the real PATH.
 */

import {
  formatDoctorReport,
  runDoctor,
  type DoctorReport,
  type RunDoctorOptions,
} from "../lib/doctor.ts";
import { intro, note, outro } from "../lib/ui.ts";
import { DEFAULT_IO, type CommandIO } from "../lib/io.ts";

interface DoctorCommandOptions {
  /** When true, skip clack framing and emit JSON. Useful for scripts. */
  json?: boolean;
  /** Override deps for tests. */
  runOptions?: RunDoctorOptions;
}

export async function doctorCommand(
  opts: DoctorCommandOptions = {},
  io: CommandIO = DEFAULT_IO,
): Promise<void> {
  const report = await runDoctor(opts.runOptions);
  if (opts.json) {
    io.stdout.write(`${JSON.stringify(serializeReport(report), null, 2)}\n`);
    return;
  }
  intro("Appstrate doctor", io);
  const execPath = opts.runOptions?.execPath ?? process.execPath;
  const body = formatDoctorReport(report, execPath);
  // `note` prints inside a framed box; multiline content is rendered as-is.
  note(body, "Installations", io);
  if (report.dualInstall) {
    outro("Detected more than one installation. See above for cleanup hints.", io);
  } else {
    outro("Healthy — single installation on PATH.", io);
  }
}

function serializeReport(report: DoctorReport): unknown {
  return {
    installations: report.installations.map((i) => ({
      pathEntry: i.pathEntry,
      binary: i.binary,
      realPath: i.realPath,
      version: i.version,
      source: i.source,
      probeError: i.probeError,
    })),
    runningIndex: report.runningIndex,
    dualInstall: report.dualInstall,
    multiSource: report.multiSource,
    localInstall: report.localInstall,
    composeDrift: report.composeDrift,
    firecracker: report.firecracker,
  };
}
