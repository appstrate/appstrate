// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Workspace-relative (posix) directories where a runner materialises bundle
 * members. Shared because the prompt points the agent at these paths and the
 * runner writes the files there: both sides must agree on one value.
 */

/** Skill members: `{workspace}/.pi/skills/<packageId>/`. */
export const PI_SKILLS_DIR = ".pi/skills";

/** Integration members: `{workspace}/.pi/integrations/<packageId>/`. */
export const PI_INTEGRATIONS_DIR = ".pi/integrations";
