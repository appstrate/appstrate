// SPDX-License-Identifier: Apache-2.0

import { networkInterfaces } from "node:os";

import { isBlockedHost } from "../../helpers.ts";

/**
 * The first non-loopback IPv4 of this machine, which must be private: the internal, non-loopback
 * address a test upstream binds to stand for an operator's internal host (#1819).
 */
export function privateIpv4(): string {
  const address = Object.values(networkInterfaces())
    .flat()
    .find((i) => i?.family === "IPv4" && !i.internal)?.address;
  if (!address || !isBlockedHost(address)) {
    throw new Error(
      `this test needs a private non-loopback IPv4 on this machine; os.networkInterfaces() offers ${address ?? "none"}`,
    );
  }
  return address;
}
