// SPDX-License-Identifier: Apache-2.0

/** Namespaces of keys the platform reads that belong to the runtime (`NODE_ENV`) and to git (`GIT_SHA`). */
export const FOREIGN_ENV_NAMESPACES: ReadonlySet<string> = new Set(["NODE", "GIT"]);
