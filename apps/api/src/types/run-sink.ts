// SPDX-License-Identifier: Apache-2.0

/**
 * Pure-types module for the run-sink context populated by the
 * `verifyRunSignature` middleware.
 *
 * Split out from `services/run-event-ingestion.ts` so that
 * `types/index.ts` can reference the shape without pulling in the
 * service's runtime imports (which transitively touch
 * `@appstrate/connect` and `@appstrate/afps-runtime/resolvers`).
 * Web-side TypeScript consumers that import `AppEnv` therefore don't
 * accidentally compile the resolver/fetch-heavy modules.
 */

/**
 * Narrow projection of the `runs` row used for signature verification +
 * event dispatch on `POST /api/runs/:runId/events`.
 */
export interface RunSinkContext {
  id: string;
  orgId: string;
  applicationId: string;
  packageId: string;
  runOrigin: "platform" | "remote";
  sinkSecretEncrypted: string;
  sinkExpiresAt: Date | null;
  sinkClosedAt: Date | null;
  lastEventSequence: number;
  startedAt: Date;
}
