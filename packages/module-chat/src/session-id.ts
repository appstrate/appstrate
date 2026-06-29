// SPDX-License-Identifier: Apache-2.0

/**
 * A fresh chat-session id, minted either server-side (the create route) or
 * client-side (lazy ChatGPT-style creation). One impl so the `chs_` shape can
 * never drift between the two call sites. Format: `chs_` + 32 lowercase hex.
 */
export function mintSessionId(): string {
  return `chs_${crypto.randomUUID().replace(/-/g, "")}`;
}
