// SPDX-License-Identifier: Apache-2.0

/** Fixed ports mirrored by the Firecracker guest nftables policy. */
export const FIRECRACKER_BROWSER_GATEWAY_PORT_BASE = 18_080;
export const FIRECRACKER_BROWSER_WORKER_PORT_BASE = 18_081;
export const FIRECRACKER_BROWSER_AUTH_PROXY_PORT_BASE = 18_082;
export const FIRECRACKER_BROWSER_DEVTOOLS_PORT_BASE = 18_083;
export const FIRECRACKER_BROWSER_PORT_SLOT_STRIDE = 4;
export const FIRECRACKER_BROWSER_MAX_SLOTS = 4;

export function isFirecrackerBrowserIsolation(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.APPSTRATE_BROWSER_GUEST_ISOLATION === "1";
}

export function assertBrowserIsolationSlot(slot: number | undefined): number {
  if (
    !Number.isInteger(slot) ||
    slot === undefined ||
    slot < 0 ||
    slot >= FIRECRACKER_BROWSER_MAX_SLOTS
  ) {
    throw new Error("BROWSER_UNAVAILABLE: invalid or missing Firecracker browser isolation slot");
  }
  return slot;
}

export function browserGatewayPort(slot: number): number {
  return FIRECRACKER_BROWSER_GATEWAY_PORT_BASE + slot * FIRECRACKER_BROWSER_PORT_SLOT_STRIDE;
}

export function browserWorkerPort(slot: number): number {
  return FIRECRACKER_BROWSER_WORKER_PORT_BASE + slot * FIRECRACKER_BROWSER_PORT_SLOT_STRIDE;
}

export function browserAuthProxyPort(slot: number): number {
  return FIRECRACKER_BROWSER_AUTH_PROXY_PORT_BASE + slot * FIRECRACKER_BROWSER_PORT_SLOT_STRIDE;
}

export function browserDevtoolsPort(slot: number): number {
  return FIRECRACKER_BROWSER_DEVTOOLS_PORT_BASE + slot * FIRECRACKER_BROWSER_PORT_SLOT_STRIDE;
}
