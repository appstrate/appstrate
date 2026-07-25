// SPDX-License-Identifier: Apache-2.0

/** Increment on any incompatible desktop bridge wire change. */
export const DESKTOP_BRIDGE_PROTOCOL_VERSION = "2";
/**
 * Versions this platform still accepts. A protocol-1 desktop drives a
 * single implicit surface and knows no `tabs.*` verb; it stays usable
 * for the manual path, and agent commands fail with a clear upgrade
 * message rather than silently landing on the wrong surface.
 */
export const DESKTOP_BRIDGE_SUPPORTED_PROTOCOLS = ["1", "2"] as const;
export const DESKTOP_BRIDGE_MAX_FRAME_BYTES = 16 * 1024 * 1024;
