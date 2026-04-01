/**
 * Shared utilities for profile selection components.
 *
 * Radix Select does not support `null` as a value, so we encode
 * "all profiles" as a sentinel string and decode it back to `null`
 * for the domain layer.
 */

export const PROFILE_ALL_VALUE = "__all__";

export function encodeProfileValue(value: string | null): string {
  return value === null ? PROFILE_ALL_VALUE : value;
}

export function decodeProfileValue(encoded: string): string | null {
  return encoded === PROFILE_ALL_VALUE ? null : encoded;
}
