// SPDX-License-Identifier: Apache-2.0

/**
 * Storage driver contract — the disk/driver abstraction rapatriated from the
 * appstrate-ws storage layer (strategy §4.1). A disk is a backend you operate
 * through one driver; the route/service layer is driver-agnostic.
 *
 * v1 drivers:
 *   - `native` — the platform's built-in storage (S3/FS via `@appstrate/db
 *     /storage`): read/write/delete. The default disk.
 *   - `s3`     — a connected S3-compatible bucket: read/write/delete + list.
 *   - `google_drive` — a connected Drive (read-only scope): read + list.
 *
 * Write capability is optional: a read-only disk simply omits `write`/`remove`
 * and the routes return a 400 for mutating operations on it.
 */

/** One object as seen when enumerating a cloud disk (the `list` op). */
export interface DriverObject {
  /** Stable disk-native key (S3 key, Drive file id) — dedup + read handle. */
  driverKey: string;
  name: string;
  mime: string | null;
  sizeBytes: number | null;
  modifiedAt: Date | null;
}

/** Raw bytes of one object, with the resolved content type. */
export interface ObjectBytes {
  bytes: Uint8Array;
  mime: string;
}

/**
 * Per-request context for connection-backed cloud drivers (Drive): the
 * requesting actor + the platform credential-proxy. The driver makes its API
 * calls through `proxyCall`, which injects the user's integration-connection
 * credentials server-side — the driver never handles a raw provider token.
 */
export interface DriverContext {
  actor: { type: "user" | "end_user"; id: string };
  proxyCall: (
    input: import("@appstrate/core/platform-types").CredentialProxyCallInput,
  ) => Promise<import("@appstrate/core/platform-types").CredentialProxyCallResult>;
}

export interface StorageDriver {
  /** Read raw bytes by the disk-native key. `null` = no longer present. */
  read(driverKey: string, mime: string | null): Promise<ObjectBytes | null>;

  /**
   * Write raw bytes to the disk. Returns the disk-native key to persist on
   * the object row. Optional — read-only disks (Drive in v1) omit it.
   */
  write?(name: string, mime: string, data: Uint8Array): Promise<string>;

  /** Delete by disk-native key. Optional — read-only disks omit it. */
  remove?(driverKey: string): Promise<void>;

  /**
   * Enumerate the disk's objects (cloud disks). `since` is the disk's
   * watermark cursor. Optional — the native disk has no remote to enumerate
   * (its inventory IS the object rows it owns).
   */
  list?(since: Date | null): AsyncGenerator<DriverObject>;
}
