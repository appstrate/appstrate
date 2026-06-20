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
 * ## Now that search has landed
 *
 * The consumer (`module-search`) exists, so the razor is satisfied and the
 * wiring is live: the platform exposes `services.events.emit` + the matching
 * `ModuleEvents` entries, storage captures the emitter at init
 * (`setEventEmitter`), and `emitStorageObjectEvent` forwards every mutation to
 * the bus. The emission stays FIRE-AND-FORGET so a storage mutation's response
 * never blocks on indexing — search enqueues a `pending` row and drains on its
 * own worker.
 *
 * Rule of thumb (strategy §5): events, never JOIN; ACL in storage,
 * denormalised in search.
 */

import type { PlatformServices } from "@appstrate/core/module";
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

// The platform event emitter, captured at init from `ctx.services.events.emit`
// (see index.ts). Null until init (or on a platform without the capability) —
// the seam then degrades to a debug log, so storage still boots standalone.
type EventEmit = PlatformServices["events"]["emit"];
let emit: EventEmit | null = null;

/** Capture the platform event emitter at module init. */
export function setEventEmitter(fn: EventEmit | null): void {
  emit = fn;
}

/**
 * Emit a storage object event to the platform bus (fan-out to listening
 * modules — today `search`). Centralises every emission point. FIRE-AND-FORGET:
 * the storage mutation that triggered this must not block on a consumer's
 * reaction; the platform fan-out isolates handler errors, and the `.catch`
 * here guards the dispatch itself.
 */
export function emitStorageObjectEvent(event: StorageObjectEvent): void {
  if (!emit) {
    logger.debug("storage object event (no emitter wired)", { event });
    return;
  }
  const send = emit;
  const dispatch = (): Promise<void> => {
    switch (event.type) {
      case "object.upserted":
        return send("onStorageObjectUpserted", {
          id: event.id,
          orgId: event.orgId,
          diskId: event.diskId,
          mime: event.mime,
          acl: event.acl,
        });
      case "object.deleted":
        return send("onStorageObjectDeleted", { id: event.id, orgId: event.orgId });
      case "object.acl_changed":
        return send("onStorageObjectAclChanged", {
          id: event.id,
          orgId: event.orgId,
          acl: event.acl,
        });
    }
  };
  void dispatch().catch((err) =>
    logger.warn("storage object event emit failed", { type: event.type, err: String(err) }),
  );
}
