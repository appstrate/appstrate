// SPDX-License-Identifier: Apache-2.0

/**
 * Tables owned by the webhooks module, listed FK-safe (children first).
 * The root test preload auto-discovers this file and registers these
 * tables with `truncateAll()` for per-test cleanup.
 */
export default ["webhook_deliveries", "webhooks"] as const;
