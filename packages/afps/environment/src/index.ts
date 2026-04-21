// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate contributors

/**
 * `@afps/environment` — platform-identity prelude.
 *
 * The prompt template is logic-less Mustache (mustache.js spec); runtimes
 * render it against the canonical PromptView (plus any platform-specific
 * flags under `platform.*`). Unlike the pre-1.3 `@appstrate/environment`
 * (now legacy), this prelude is vendor-neutral: it references provider
 * tools (`<name>_call`), not a specific proxy URL. The same prelude runs
 * unchanged on Appstrate, a local CLI, a GitHub Action, or any
 * third-party AFPS-compliant runner.
 */

import prompt from "./prompt-text.ts";

export const AFPS_ENVIRONMENT_VERSION = "2.0.0";
export const AFPS_ENVIRONMENT_NAME = "@afps/environment";

/**
 * Mustache template rendered against the canonical PromptView. Runtimes
 * may supply additional `platform.*` flags for logic-less gating of
 * sections (`hasProviders`, `hasUploads`, `hasTimeout`).
 */
export const AFPS_ENVIRONMENT_PROMPT = prompt;

export default {
  name: AFPS_ENVIRONMENT_NAME,
  version: AFPS_ENVIRONMENT_VERSION,
  prompt: AFPS_ENVIRONMENT_PROMPT,
};
