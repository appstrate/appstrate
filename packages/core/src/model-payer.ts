// SPDX-License-Identifier: Apache-2.0

/**
 * Who pays a model call: the platform's key (`system`), an organization
 * credential (`org`), or a member's own credential (`user`). The order is the
 * `credential_source` pg enum's label order: append only, never reorder.
 */
export const MODEL_PAYERS = ["system", "org", "user"] as const;
export type ModelPayer = (typeof MODEL_PAYERS)[number];

/**
 * Who owns a stored model credential: the organization (`org`) or one member
 * (`user`). The platform's key is not stored, so `system` owns none.
 */
export const MODEL_CREDENTIAL_OWNERS = ["org", "user"] as const satisfies readonly ModelPayer[];
export type ModelCredentialOwner = (typeof MODEL_CREDENTIAL_OWNERS)[number];
