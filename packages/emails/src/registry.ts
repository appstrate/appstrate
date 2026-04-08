// SPDX-License-Identifier: Apache-2.0

import type { EmailType, EmailRenderer, EmailPropsMap, RenderedEmail } from "./types.ts";
import { renderVerificationEmail } from "./templates/verification.ts";
import { renderInvitationEmail } from "./templates/invitation.ts";
import { renderMagicLinkEmail } from "./templates/magic-link.ts";
import { renderResetPasswordEmail } from "./templates/reset-password.ts";
import { renderEndUserVerificationEmail } from "./templates/enduser-verification.ts";
import { renderEndUserResetPasswordEmail } from "./templates/enduser-reset-password.ts";
import { renderEndUserWelcomeEmail } from "./templates/enduser-welcome.ts";

// Default OSS templates
const defaultRenderers: { [K in EmailType]: EmailRenderer<K> } = {
  verification: renderVerificationEmail,
  invitation: renderInvitationEmail,
  "magic-link": renderMagicLinkEmail,
  "reset-password": renderResetPasswordEmail,
  "enduser-verification": renderEndUserVerificationEmail,
  "enduser-reset-password": renderEndUserResetPasswordEmail,
  "enduser-welcome": renderEndUserWelcomeEmail,
};

// Mutable registry — defaults + overrides merged at boot
let registry: { [K in EmailType]: EmailRenderer<K> } = { ...defaultRenderers };

/**
 * Merge cloud (or custom) overrides into the email registry.
 * Only overrides provided keys; others keep the OSS default.
 * Called once at boot, before any email is sent.
 */
export function registerEmailOverrides(
  overrides: Partial<{ [K in EmailType]: EmailRenderer<K> }>,
): void {
  registry = { ...registry, ...overrides };
}

/**
 * Reset registry to OSS defaults. Test-only.
 */
export function resetEmailRegistry(): void {
  registry = { ...defaultRenderers };
}

/**
 * Render an email by type. Type-safe: props must match the email type.
 */
export function renderEmail<T extends EmailType>(type: T, props: EmailPropsMap[T]): RenderedEmail {
  const renderer = registry[type] as EmailRenderer<T>;
  return renderer(props);
}
