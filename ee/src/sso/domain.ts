// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/** Hostname labels: letters, digits, inner hyphens, 1-63 characters. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The canonical form of an email domain an organization claims (lowercase, no
 * trailing dot), or `null` when it is not a public hostname of at least two
 * labels. A subdomain is a domain of its own: `eu.example.com` is not covered
 * by `example.com`, since another party may run its DNS zone.
 */
export function normalizeDomain(input: string): string | null {
  const domain = input.trim().toLowerCase().replace(/\.$/, "");
  if (domain.length === 0 || domain.length > 253) return null;
  const labels = domain.split(".");
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return null;
  // The top-level label of a public domain is never all digits (an IPv4 address would be).
  if (/^\d+$/.test(labels[labels.length - 1]!)) return null;
  return domain;
}

/** The domain of an address, normalized, or `null`. */
export function emailDomainOf(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 1) return null;
  return normalizeDomain(email.slice(at + 1));
}

/** An address in one comparable form (lowercase, normalized domain), or `null`. */
export function normalizeAddress(email: string): string | null {
  const at = email.trim().lastIndexOf("@");
  const domain = emailDomainOf(email.trim());
  if (at < 1 || !domain) return null;
  return `${email.trim().slice(0, at).toLowerCase()}@${domain}`;
}

/** The DNS name that carries an organization's proof for `domain`. */
export function verificationRecordName(domain: string): string {
  return `_appstrate.${domain}`;
}

const VERIFICATION_PREFIX = "appstrate-domain-verification=";

/** The TXT value proving `token`. */
export function verificationRecordValue(token: string): string {
  return `${VERIFICATION_PREFIX}${token}`;
}

/** A fresh, unguessable verification token (128 bits, hex). */
export function newVerificationToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
