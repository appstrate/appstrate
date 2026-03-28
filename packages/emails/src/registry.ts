import type { EmailType, EmailRenderer, EmailPropsMap, RenderedEmail } from "./types.ts";
import { renderVerificationEmail } from "./templates/verification.ts";
import { renderInvitationEmail } from "./templates/invitation.ts";

// Default OSS templates
const defaultRenderers: { [K in EmailType]: EmailRenderer<K> } = {
  verification: renderVerificationEmail,
  invitation: renderInvitationEmail,
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
 * Render an email by type. Type-safe: props must match the email type.
 */
export function renderEmail<T extends EmailType>(type: T, props: EmailPropsMap[T]): RenderedEmail {
  const renderer = registry[type] as EmailRenderer<T>;
  return renderer(props);
}
