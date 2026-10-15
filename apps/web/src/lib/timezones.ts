// SPDX-License-Identifier: Apache-2.0

/**
 * The time zones a schedule can fire in: every IANA zone the browser knows,
 * UTC first. A hand-kept short list left a schedule stored in another zone
 * (America/Toronto) with an empty select.
 */

// `Intl.supportedValuesOf` is ES2022; the app's TS lib stops at ES2020.
const browserZones: readonly string[] =
  (Intl as { supportedValuesOf?: (key: "timeZone") => string[] }).supportedValuesOf?.("timeZone") ??
  [];

const ZONES: readonly string[] = [...new Set(["UTC", ...browserZones])];

/** The zones to offer, keeping `current` listed even when the browser does not know it. */
export function timezoneOptions(current?: string): readonly string[] {
  return current && !ZONES.includes(current) ? [...ZONES, current] : ZONES;
}
