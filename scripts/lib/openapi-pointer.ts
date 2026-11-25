// SPDX-License-Identifier: Apache-2.0

/** The operation keys of an OpenAPI 3 Path Item. */
export const OPERATION_VERBS = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
] as const;

export { resolveRef } from "../../apps/api/src/openapi/pointer.ts";
