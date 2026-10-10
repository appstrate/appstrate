// SPDX-License-Identifier: Apache-2.0

/**
 * Who pays a model call: the platform's key (`system`), an organization
 * credential (`org`), or a member's own credential (`user`). The order is the
 * `credential_source` pg enum's label order: append only, never reorder.
 */
export const MODEL_PAYERS = ["system", "org", "user"] as const;
export type ModelPayer = (typeof MODEL_PAYERS)[number];
