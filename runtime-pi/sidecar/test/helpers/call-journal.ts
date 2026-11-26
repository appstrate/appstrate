// SPDX-License-Identifier: Apache-2.0

/** Test doubles for the run's call journal (`call-reporter.ts`). */

import type {
  CallJournal,
  CallReporter,
  DispatchedCall,
  IntegrationCallRecord,
} from "../../call-reporter.ts";

/** A journal that keeps nothing, for a test about something else. */
export const noJournal: CallJournal = () => {};

/** A reporter that keeps nothing, for a boot test about something else. */
export const noCallReporter: CallReporter = {
  report: () => {},
  drain: async () => {},
};

/** A journal that keeps every call it is handed, in order. */
export function recordingJournal(): { journal: CallJournal; calls: DispatchedCall[] } {
  const calls: DispatchedCall[] = [];
  return { journal: (call) => calls.push(call), calls };
}

/** A reporter that keeps every record it is handed, in order. */
export function recordingCallReporter(): {
  reporter: CallReporter;
  records: IntegrationCallRecord[];
} {
  const records: IntegrationCallRecord[] = [];
  return {
    reporter: { report: (record) => records.push(record), drain: async () => {} },
    records,
  };
}
