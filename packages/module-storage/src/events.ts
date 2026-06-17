// SPDX-License-Identifier: Apache-2.0

/**
 * Storage → search event contract — the expensive seam, posed in v1.
 *
 * ## Why a LOCAL seam instead of the platform event bus
 *
 * The platform's `emitEvent` bus is core→modules (modules LISTEN, they do not
 * emit), and `PlatformServices` is deliberately minimal — a capability lands
 * there only when a real consumer needs it (enforced by
 * `scripts/verify-module-contract.ts`). `module-search` — the consumer of
 * these events — does not exist yet, so wiring the core bus now would add
 * speculative surface the platform explicitly forbids.
 *
 * ## What we pose NOW (the part that's expensive to change later)
 *
 *   - the stable OPAQUE object `id` consumers hold (never the driver key);
 *   - storage as the SOURCE OF TRUTH for the object ACL;
 *   - the event SHAPE + a single emission seam every mutation routes through.
 *
 * ## When search lands
 *
 * Wiring becomes a one-function change: make `emitStorageObjectEvent` forward
 * to the platform bus (after adding the matching `ModuleEvents` entries + a
 * `services.events.emit` capability — the razor is satisfied then, because
 * there is finally a consumer). Nothing else in this module changes.
 *
 * Rule of thumb (strategy §5): events, never JOIN; ACL in storage,
 * denormalised in search.
 */

import { logger } from "./logger.ts";

export interface StorageObjectAcl {
  visibility: "org" | "private";
  ownerId: string | null;
}

export type StorageObjectEvent =
  | {
      type: "object.upserted";
      id: string;
      orgId: string;
      diskId: string;
      mime: string | null;
      acl: StorageObjectAcl;
    }
  | { type: "object.deleted"; id: string; orgId: string }
  | { type: "object.acl_changed"; id: string; orgId: string; acl: StorageObjectAcl };

/**
 * Emit a storage object event. Today a no-op seam (debug log only) — no
 * consumer exists yet. Centralises every emission point so `module-search`
 * can subscribe with a single edit. See the module header for the rationale.
 */
export function emitStorageObjectEvent(event: StorageObjectEvent): void {
  logger.debug("storage object event (no consumer yet)", { event });
}
